import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Ledger, Task, TaskStatus, Checkpoint, CheckpointTask } from './types';
import { callModel, Models } from './model-provider';
import { ToolExecutor, ToolCall } from './tools';
import { VisualBridge } from './visual-bridge';
import { SharedMemory } from './memory';
import * as readline from 'readline';
import axios from 'axios';
import { db } from './database';

export class Orchestrator {
  private ledger: Ledger;
  private tools: ToolExecutor;
  private visual: VisualBridge;
  private memory: SharedMemory;
  private projectName: string;
  private projectDir: string;
  private sessionId: string;
  private logPath: string;

  private checkpoint!: Checkpoint;

  constructor(projectName: string, projectDir: string) {
    this.projectName = projectName;
    this.projectDir = projectDir;
    this.tools = new ToolExecutor(projectDir);
    this.visual = new VisualBridge(projectDir);
    this.memory = new SharedMemory();
    this.sessionId = `session_${Date.now()}`;

    // Load from SQL DB
    const dbProject: any = db.getProject(projectName);
    const dbTasks: any = db.getTasks(projectName);
    const dbPrompts: any = db.getLatestPrompts(projectName);

    // Setup persistent logging directory
    const logsDir = path.join(projectDir, '..', 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    this.logPath = path.join(logsDir, `${this.sessionId}.log`);

    this.ledger = {
      global_intent: dbProject?.intent || "Mission Standby",
      status: dbProject?.status || 'idle',
      loop_count: dbProject?.loop_count || 0,
      max_loops: dbProject?.max_loops || 50,
      model_config: dbProject?.model_config ? JSON.parse(dbProject.model_config) : undefined,
      task_queue: dbTasks.map((t: any) => ({
        id: t.id,
        description: t.description,
        status: t.status,
        retry_count: t.retry_count,
        auditor_notes: t.auditor_notes,
        reviewer_notes: t.reviewer_notes,
        files_impacted: t.files_impacted ? JSON.parse(t.files_impacted) : []
      })),
      system_prompts: {
        architect: dbPrompts?.architect,
        builder: dbPrompts?.builder,
        reviewer: dbPrompts?.reviewer,
        auditor: dbPrompts?.auditor
      }
    };
    this.initCheckpoint();
    console.log(`[Orchestrator] Loaded project "${projectName}" status=${this.ledger.status} loop=${this.ledger.loop_count} max=${this.ledger.max_loops} tasks=${this.ledger.task_queue.length}`);
  }

  private initCheckpoint() {
    const cpPath = path.join(this.projectDir, '..', 'checkpoint.json');
    if (fs.existsSync(cpPath)) {
      try { this.checkpoint = JSON.parse(fs.readFileSync(cpPath, 'utf-8')); } catch (e) {}
    }
    if (!this.checkpoint) {
      this.checkpoint = {
        session_id: this.sessionId,
        project_name: this.projectName,
        status: this.ledger.status,
        intent_hash: crypto.createHash('sha256').update(this.ledger.global_intent || '').digest('hex'),
        last_checkpoint_at: new Date().toISOString(),
        last_completed_phase: '',
        current_task_id: '',
        tasks: [],
        file_manifest: { created: [], modified: [], deleted: [] },
        model_config_snapshot: {},
        loop_count: 0,
        interruption_reason: null
      };
    }
  }

  private saveCheckpoint() {
    if (!this.checkpoint) return;
    this.checkpoint.last_checkpoint_at = new Date().toISOString();
    this.checkpoint.loop_count = this.ledger.loop_count;
    this.checkpoint.status = this.ledger.status;
    this.checkpoint.current_task_id = this.ledger.current_task_id || '';
    if (this.ledger.model_config) {
      this.checkpoint.model_config_snapshot = this.ledger.model_config as any;
    }
    const cpPath = path.join(this.projectDir, '..', 'checkpoint.json');
    try { fs.writeFileSync(cpPath, JSON.stringify(this.checkpoint, null, 2)); } catch (e) {}
  }

  private async broadcast(data: any) {
    try { await axios.post('http://localhost:4002/api/internal/broadcast', data); } catch (e: any) {}
  }

  private persistLog(message: string) {
    // 1. Save to SQL DB (NoSQL style entry)
    db.addLog(this.projectName, this.sessionId, message);
    
    // 2. Save to physical log file
    const entry = `[${new Date().toLocaleTimeString()}] ${message}\n`;
    fs.appendFileSync(this.logPath, entry);
    
    // 3. Output to console and Dashboard
    console.log(`[${this.projectName}] ${message}`);
    this.broadcast({ type: 'log', projectName: this.projectName, message });
  }

  private saveState() {
    db.upsertProject(this.projectName, this.ledger.global_intent, this.ledger.status, this.ledger.max_loops, this.ledger.loop_count,
      this.ledger.model_config ? JSON.stringify(this.ledger.model_config) : undefined);
    this.ledger.task_queue.forEach(t => db.saveTask(t, this.projectName));
    this.saveCheckpoint();
    this.broadcast({ type: 'ledger_update', projectName: this.projectName, ledger: this.ledger });
  }

  private getModel(role: string): { provider: string; name: string } {
    const key = role as keyof typeof Models;
    const override = this.ledger.model_config?.[role.toLowerCase() as keyof typeof this.ledger.model_config];
    if (override && override.provider && override.name) return override;
    return Models[key] || Models.ARCHITECT_PRIMARY;
  }

  private logModelCall(role: string, model: string, provider: string) {
    this.persistLog(`[MODEL] ${role} -> ${provider}/${model}`);
  }

  private getProjectMap(): string {
    const files = this.walkDir(this.projectDir);
    return files.join('\n');
  }

  private walkDir(dir: string, fileList: string[] = []): string[] {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const name = path.join(dir, file);
      if (fs.statSync(name).isDirectory()) {
        if (!file.startsWith('.') && file !== 'node_modules') this.walkDir(name, fileList);
      } else {
        fileList.push(path.relative(this.projectDir, name));
      }
    });
    return fileList;
  }

  public getStatus(): string {
    return this.ledger.status;
  }

  public async tick(): Promise<boolean> {
    // Stop if terminal status
    if (this.ledger.status === 'completed' || this.ledger.status === 'failed') {
      this.persistLog(`Engine Dormant: ${this.ledger.status}`);
      return true;
    }

    if (this.ledger.loop_count >= this.ledger.max_loops) {
      this.persistLog("Max loops reached. Setting completed.");
      this.ledger.status = 'completed';
      this.saveState();
      return true;
    }

    this.persistLog(`--- Tick ${this.ledger.loop_count} [Status: ${this.ledger.status}] ---`);

    // HEALING: Reset stuck tasks
    const stuckTask = this.ledger.task_queue.find(t => t.status === 'in_progress');
    if (stuckTask) {
      this.persistLog(`Healing stuck task: ${stuckTask.description}`);
      stuckTask.status = 'failed';
    }

    try {
      switch (this.ledger.status) {
        case 'idle': await this.handlePlanning(); break;
        case 'planning': await this.handlePlanning(); break;
        case 'executing': await this.handleExecution(); break;
        case 'reviewing': await this.handleCodeReview(); break;
        case 'auditing': await this.handleAuditing(); break;
      }
      this.ledger.loop_count++;
      this.saveState();
    } catch (error: any) {
      const isRateLimit = error.message?.includes('Rate limit') ||
                         error.response?.data?.error?.type === 'FreeUsageLimitError' ||
                         error.response?.status === 429;

      if (isRateLimit) {
        this.persistLog("!!! RATE LIMIT !!! Cooling down (60s)...");
        const activeTask = this.ledger.task_queue.find(t => t.id === this.ledger.current_task_id);
        if (activeTask) {
          activeTask.retry_count++;
          if (activeTask.retry_count >= 3) {
            activeTask.status = 'failed';
          }
        }
        this.saveState();
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else {
        this.persistLog(`ERROR: ${error.message}`);
        this.ledger.status = 'failed';
        this.saveState();
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    return false;
  }

  private extractJsonArray(text: string): string[] | null {
    const trimmed = text.trim();
    // Try direct JSON parse first
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    // Try extracting from markdown code blocks
    const blockMatch = trimmed.match(/```(?:json)?\s*\n?(\[[\s\S]*?\])\n?\s*```/);
    if (blockMatch) {
      try {
        const parsed = JSON.parse(blockMatch[1]);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    // Try finding any JSON array in the text
    const arrayMatch = trimmed.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return null;
  }

  private extractJsonObject(text: string): any | null {
    const trimmed = text.trim();
    // Try direct JSON parse first
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
    // Try extracting from markdown code blocks
    const blockMatch = trimmed.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\n?\s*```/);
    if (blockMatch) {
      try {
        const parsed = JSON.parse(blockMatch[1]);
        if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {}
    }
    // Try finding any JSON object in the text
    const objMatch = trimmed.match(/\{[\s\S]*?\}/);
    if (objMatch) {
      try {
        const parsed = JSON.parse(objMatch[0]);
        if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return null;
  }

  private async handlePlanning() {
    this.persistLog("Architect planning...");
    const lessons = this.memory.getRelevantLessons(this.ledger.global_intent);
    const systemPrompt = this.ledger.system_prompts?.architect || `You are the Triad Engine Lead Architect. Decompose user intent into a precise JSON task plan.

RULES:
1. Return ONLY a JSON array of strings: ["task 1", ...]
2. Each task must be atomic and verifiable
3. Order by dependency
4. Maximum 15 tasks
5. No conversational text`;
    const prompt = `User Intent: ${this.ledger.global_intent}\n\n${lessons ? `Past Lessons:\n${lessons}\n\n` : ""}Return JSON array: ["task 1", ...]`;

    let response;
    try {
      this.logModelCall('Architect', this.getModel('ARCHITECT_PRIMARY').name, this.getModel('ARCHITECT_PRIMARY').provider);
      response = await callModel(this.getModel('ARCHITECT_PRIMARY').provider as any, this.getModel('ARCHITECT_PRIMARY').name, prompt, systemPrompt);
    } catch (e: any) {
      this.persistLog(`Architect Primary failed: ${e.message}`);
      try {
        this.logModelCall('Architect(Fallback)', this.getModel('ARCHITECT_FALLBACK').name, this.getModel('ARCHITECT_FALLBACK').provider);
        response = await callModel(this.getModel('ARCHITECT_FALLBACK').provider as any, this.getModel('ARCHITECT_FALLBACK').name, prompt, systemPrompt);
      } catch (e2: any) {
        this.persistLog(`Architect Fallback also failed: ${e2.message}`);
        return;
      }
    }

    const tasks = this.extractJsonArray(response);
    if (!tasks) {
      this.persistLog("Architect returned invalid JSON. Retrying next tick.");
      return;
    }

    db.clearTasks(this.projectName);
    this.ledger.task_queue = tasks.map((desc, i) => ({ id: `t${i + 1}`, description: desc, status: 'pending', retry_count: 0, files_impacted: [] }));
    this.ledger.status = 'executing';
    // Update checkpoint tasks
    this.checkpoint.tasks = this.ledger.task_queue.map(t => ({
      id: t.id,
      description: t.description,
      status: t.status,
      completed_at: null,
      retry_count: 0,
      files_created: [],
      files_modified: [],
      files_deleted: [],
      reviewer_notes: null,
      auditor_notes: null
    }));
    this.persistLog(`Plan created: ${tasks.length} tasks.`);
  }

  private async handleExecution() {
    // Check for tasks awaiting review — transition to reviewing
    const reviewTask = this.ledger.task_queue.find(t => t.status === 'awaiting_review');
    if (reviewTask) {
      this.ledger.current_task_id = reviewTask.id;
      this.ledger.status = 'reviewing';
      return;
    }

    // Check for tasks awaiting audit — transition to auditing
    const awaitingTask = this.ledger.task_queue.find(t => t.status === 'awaiting_audit');
    if (awaitingTask) {
      this.ledger.current_task_id = awaitingTask.id;
      this.ledger.status = 'auditing';
      return;
    }

    const nextTask = this.ledger.task_queue.find(t => t.status === 'pending' || t.status === 'failed');
    if (!nextTask) {
      if (this.ledger.task_queue.length > 0 && this.ledger.task_queue.every(t => t.status === 'completed')) {
        this.ledger.status = 'completed';
        this.persistLog("Mission accomplished.");
        return;
      }
      // No tasks at all — need planning
      this.ledger.status = 'idle';
      return;
    }

    if (nextTask.retry_count >= 3) {
      const userHint = await this.askUser(`Manual Interception Required for "${nextTask.description}": `);
      nextTask.auditor_notes = `HUMAN HINT: ${userHint}\n${nextTask.auditor_notes}`;
    }

    this.persistLog(`Builder executing: ${nextTask.description}`);
    const projectMap = this.getProjectMap();
    this.ledger.current_task_id = nextTask.id;
    nextTask.status = 'in_progress';
    this.saveState();

    const systemPrompt = this.ledger.system_prompts?.builder || `You are the Triad Engine Builder. Execute tasks via tool calls.

TOOLS: write_file, read_file, run_command, create_custom_tool, use_custom_tool
RULES: Respond ONLY with a single JSON object. No explanation.
CONTEXT GUARD (Global State):
${projectMap}
MISSION: Complete task without breaking regressions. Respond ONLY JSON.`;

    const prompt = `GLOBAL GOAL: ${this.ledger.global_intent}\nTASK: ${nextTask.description}\nFEEDBACK: ${nextTask.auditor_notes || 'None'}`;

    let response;
    try {
      this.logModelCall('Builder', this.getModel('BUILDER').name, this.getModel('BUILDER').provider);
      response = await callModel(this.getModel('BUILDER').provider as any, this.getModel('BUILDER').name, prompt, systemPrompt);
    } catch (e: any) {
      this.persistLog("Builder API call failed. Retrying next tick.");
      nextTask.retry_count++;
      return;
    }

    const toolCallJson = this.extractJsonObject(response);
    if (!toolCallJson || !toolCallJson.action) {
      this.persistLog(`Builder returned invalid JSON. Resetting task...`);
      nextTask.status = 'failed';
      nextTask.retry_count++;
      return;
    }

    try {
      const toolCall: ToolCall = toolCallJson as ToolCall;
      const result = await this.tools.execute(toolCall);
      this.persistLog(`Action Result: ${result}`);

      if (toolCall.action === 'write_file' && toolCall.path) {
        if (!nextTask.files_impacted) nextTask.files_impacted = [];
        if (!nextTask.files_impacted.includes(toolCall.path)) nextTask.files_impacted.push(toolCall.path);

        // Track in checkpoint file manifest
        const fullPath = path.isAbsolute(toolCall.path) ? toolCall.path : path.join(this.projectDir, toolCall.path);
        const relPath = toolCall.path;
        const existed = fs.existsSync(fullPath);
        if (existed) {
          if (!this.checkpoint.file_manifest.modified.includes(relPath)) this.checkpoint.file_manifest.modified.push(relPath);
        } else {
          if (!this.checkpoint.file_manifest.created.includes(relPath)) this.checkpoint.file_manifest.created.push(relPath);
        }
        // Also track in checkpoint task
        const cpTask = this.checkpoint.tasks.find(t => t.id === nextTask.id);
        if (cpTask) {
          if (existed) { if (!cpTask.files_modified.includes(relPath)) cpTask.files_modified.push(relPath); }
          else { if (!cpTask.files_created.includes(relPath)) cpTask.files_created.push(relPath); }
        }
        this.saveCheckpoint();
      }



      nextTask.status = 'awaiting_review';
      this.ledger.status = 'reviewing';
    } catch (e: any) {
      this.persistLog(`Execution Error: ${e.message}. Resetting task...`);
      nextTask.status = 'failed';
      nextTask.retry_count++;
    }
  }

  private async handleCodeReview() {
    const currentTask = this.ledger.task_queue.find(t => t.id === this.ledger.current_task_id);
    if (!currentTask || currentTask.status !== 'awaiting_review') {
      this.ledger.status = 'executing';
      return;
    }

    this.persistLog(`Code Reviewer checking: ${currentTask.description}`);

    const projectMap = this.getProjectMap();
    const systemPrompt = this.ledger.system_prompts?.reviewer || `You are the Triad Engine Code Reviewer. Check for bugs, security issues, style problems, and regressions.

RULES:
1. If acceptable, return: PASS
2. If issues found, return: FAILURE REPORT: <file:line> - <issue> - <fix>
3. Be specific with file paths and line numbers
4. Do NOT check if the task goal is met — that is the Auditor's job`;
    const prompt = `GLOBAL GOAL: ${this.ledger.global_intent}\nTASK: ${currentTask.description}\nFILES:\n${projectMap}\n\nREVIEW: Check for correctness, security, and style issues.`;

    try {
      this.logModelCall('Code Reviewer', this.getModel('REVIEWER').name, this.getModel('REVIEWER').provider);
      const response = await callModel(this.getModel('REVIEWER').provider as any, this.getModel('REVIEWER').name, prompt, systemPrompt);

      if (response.toUpperCase().includes("PASS")) {
        currentTask.reviewer_notes = response;
        currentTask.status = 'awaiting_audit';
        this.persistLog("Code Review PASSED.");
      } else {
        currentTask.status = 'failed';
        currentTask.retry_count++;
        currentTask.reviewer_notes = response;
        this.persistLog(`Code Review FAILED: ${response.substring(0, 80)}...`);
      }
      // Sync checkpoint
      const cpTask = this.checkpoint.tasks.find(t => t.id === currentTask.id);
      if (cpTask) {
        cpTask.status = currentTask.status;
        cpTask.reviewer_notes = currentTask.reviewer_notes;
        cpTask.retry_count = currentTask.retry_count;
      }
    } catch (e: any) {
      this.persistLog(`Code Reviewer API error: ${e.message}. Passing to auditor.`);
      currentTask.status = 'awaiting_audit';
    }
    this.ledger.status = 'executing';
  }

  private async handleAuditing() {
    const currentTask = this.ledger.task_queue.find(t => t.id === this.ledger.current_task_id);
    if (!currentTask || currentTask.status !== 'awaiting_audit') {
      this.ledger.status = 'executing';
      return;
    }

    this.persistLog(`Auditor verifying: ${currentTask.description}`);

    let screenshot: string | undefined;
    const htmlFile = currentTask.files_impacted?.find(f => f.endsWith('.html'));
    if (htmlFile) {
      const fullPath = path.isAbsolute(htmlFile) ? htmlFile : path.join(this.projectDir, htmlFile);
      if (fs.existsSync(fullPath)) {
        try {
          screenshot = await this.visual.captureScreenshot(htmlFile);
          this.persistLog(`Captured visual state.`);
        } catch (e: any) {
          this.persistLog(`Screenshot failed: ${e.message}`);
        }
      }
    }

    const systemPrompt = this.ledger.system_prompts?.auditor || `You are the Triad Engine Auditor. Rigorously verify task completion.

RULES:
1. If fully and correctly completed, return: PASS
2. If issues found, return: FAILURE REPORT: <issue> - <evidence>
3. Be skeptical — check for stubs, TODOs, placeholder code
4. Use provided screenshot for visual verification of HTML/CSS`;
    const prompt = `GLOBAL GOAL: ${this.ledger.global_intent}\nTASK: ${currentTask.description}\nVERIFY: Does this output fulfill the goal?`;

    try {
      this.logModelCall('Auditor', this.getModel('AUDITOR').name, this.getModel('AUDITOR').provider);
      const response = await callModel(this.getModel('AUDITOR').provider as any, this.getModel('AUDITOR').name, prompt, systemPrompt, screenshot);
      if (response.toUpperCase().includes("PASS")) {
        currentTask.status = 'completed';
        this.persistLog("Audit PASSED.");
        if (currentTask.retry_count > 0) this.memory.addLesson(this.projectName, currentTask.description, "Resolved after struggle.");
      } else {
        currentTask.status = 'failed';
        currentTask.retry_count++;
        currentTask.auditor_notes = response;
        this.persistLog(`Audit FAILED: ${response.substring(0, 50)}...`);
      }
      // Sync checkpoint
      const cpTask = this.checkpoint.tasks.find(t => t.id === currentTask.id);
      if (cpTask) {
        cpTask.status = currentTask.status;
        cpTask.auditor_notes = currentTask.auditor_notes;
        cpTask.retry_count = currentTask.retry_count;
        if (currentTask.status === 'completed') cpTask.completed_at = new Date().toISOString();
      }
    } catch (e: any) {
      currentTask.retry_count++;
      const is429 = e.response?.status === 429 || e.message?.includes('429');
      if (is429) {
        this.persistLog(`Auditor rate limited (429). Cool down + retry ${currentTask.retry_count}/3.`);
        if (currentTask.retry_count >= 3) {
          currentTask.status = 'failed';
          currentTask.auditor_notes = 'FAILED after 3 rate limited audit attempts.';
          this.persistLog('Auditor gave up after 3 rate limits.');
        }
        await new Promise(resolve => setTimeout(resolve, 10000 * currentTask.retry_count));
      } else {
        this.persistLog(`Auditor API error: ${e.message}. Keeping task for retry.`);
        if (currentTask.retry_count >= 3) {
          currentTask.status = 'failed';
          this.persistLog('Auditor failed after 3 errors.');
        }
      }
    }
    this.ledger.status = 'executing';
  }

  private askUser(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
  }
}
