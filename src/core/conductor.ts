import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GitManager, CommitEntry } from './git-manager';
import { PromptBuilder } from './prompt-builder';
import { SharedMemory } from './memory';
import { db } from './database';
import { callModel } from './model-provider';
import { ToolExecutor, ToolCall } from './tools';
import {
  AgentRole, ConductorStatus, ProjectModelConfig,
  DEFAULT_MODEL_CONFIG, TaskQueueEntry, Checkpoint
} from './types';

export class Conductor {
  private projectName: string;
  private workspacePath: string;
  private triadDir: string = '';
  private git: GitManager;
  private promptBuilder: PromptBuilder;
  private memory: SharedMemory;
  private sessionId: string;
  private status: ConductorStatus;
  private taskQueue: TaskQueueEntry[];
  private currentTaskId: string | null;
  private modelConfig: ProjectModelConfig;
  private loopCount: number;
  private broadcastFn: ((event: string, data: any) => void) | null = null;
  private checkpoint: Checkpoint | null = null;
  private checkpointPath: string = '';
  private workspaceMapCache: string[] | null = null;
  private workspaceMapCacheTime: number = 0;
  private cachedIntent: string = '';
  private tools: ToolExecutor;

  constructor(projectName: string, workspacePath: string) {
    this.projectName = projectName;
    this.workspacePath = workspacePath;
    this.git = new GitManager(workspacePath);
    this.tools = new ToolExecutor(workspacePath);
    this.promptBuilder = new PromptBuilder();
    this.memory = new SharedMemory();
    this.triadDir = path.join(workspacePath, '.triad');
    this.sessionId = '';
    this.status = 'idle';
    this.taskQueue = [];
    this.currentTaskId = null;
    this.modelConfig = DEFAULT_MODEL_CONFIG;
    this.loopCount = 0;
    this.checkpointPath = path.join(path.dirname(workspacePath), 'checkpoint.json');
  }

  setBroadcast(fn: (event: string, data: any) => void): void {
    this.broadcastFn = fn;
  }

  private emit(event: string, data: any): void {
    if (this.broadcastFn) {
      this.broadcastFn(event, { ...data, projectName: this.projectName });
    }
  }

  // ========== Lifecycle ==========

  async start(intent: string): Promise<void> {
    console.log(`[Conductor] Starting project "${this.projectName}"...`);

    await this.ensureRepo();

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
    this.sessionId = `session-${dateStr}`;
    await this.git.createSessionBranch(this.sessionId);

    const modelConfigPath = path.join(this.workspacePath, '.triad', 'model_config.json');
    if (fs.existsSync(modelConfigPath)) {
      try {
        this.modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8'));
      } catch (e) {
        console.warn('[Conductor] Failed to parse model_config.json, using defaults');
      }
    }

    this.triadDir = path.join(this.workspacePath, '.triad');
    if (!fs.existsSync(this.triadDir)) fs.mkdirSync(this.triadDir, { recursive: true });
    this.cachedIntent = intent;
    fs.writeFileSync(path.join(this.triadDir, 'intent.md'), this.buildIntentFile(intent));
    fs.writeFileSync(path.join(this.triadDir, 'model_config.json'), JSON.stringify(this.modelConfig, null, 2));

    const memoryContext = this.memory.getRelevantLessons(intent);
    fs.writeFileSync(path.join(this.triadDir, 'memory_context.md'), memoryContext || 'No relevant past lessons found.');

    this.initCheckpoint(intent);

    await this.saveState();
    await this.git.commit(`[${this.sessionId}] [system] session initialized`);

    this.status = 'planning';
    this.emit('conductor_started', { sessionId: this.sessionId, projectName: this.projectName });
    this.emit('state_update', { ...this.getState(), projectName: this.projectName });

    // Periodic state broadcast for live dashboard updates
    this.stateInterval = setInterval(() => this.emit('state_update', { ...this.getState(), projectName: this.projectName }), 1000);

    // Run pipeline async — do NOT await, start() must return immediately
    // so the IPC handler responds to the dashboard without blocking
    setImmediate(() => this.handlePlanning(intent).catch(e => {
      console.error('[Conductor] Pipeline error:', e.message);
      this.status = 'failed';
      this.emit('pipeline_failed', { projectName: this.projectName, reason: e.message });
    }));
  }

  private stateInterval: NodeJS.Timeout | null = null;

  async stop(): Promise<void> {
    console.log(`[Conductor] Stopping project "${this.projectName}"...`);
    if (this.stateInterval) { clearInterval(this.stateInterval); this.stateInterval = null; }
    this.status = 'failed';
    await this.saveState();
    this.emit('conductor_stopped', { projectName: this.projectName });
  }

  async pause(): Promise<void> {
    console.log(`[Conductor] Pausing project "${this.projectName}"...`);
    this.status = 'paused';
    await this.saveState();
    this.emit('conductor_paused', { projectName: this.projectName });
  }

  async resume(): Promise<void> {
    console.log(`[Conductor] Resuming project "${this.projectName}"...`);
    this.status = 'idle';
    await this.saveState();
    this.emit('conductor_resumed', { projectName: this.projectName });
    await this.resumePipeline();
  }

  async getState() {
    return {
      session_id: this.sessionId,
      project: this.projectName,
      status: this.status,
      current_task_id: this.currentTaskId,
      loop_count: this.loopCount,
      task_queue: this.taskQueue,
      active_agents: [],
    };
  }

  async getGitLog(): Promise<CommitEntry[]> {
    return await this.git.getLog(this.sessionId);
  }

  async getGitDiff(fromHash: string, toHash: string): Promise<string> {
    return await this.git.getDiff(fromHash, toHash);
  }

  async getGitBranches(): Promise<string[]> {
    return await this.git.getBranches();
  }

  // ========== Direct API Pipeline ==========

  private async handlePlanning(intent: string): Promise<void> {
    console.log('[Conductor] Planning with Architect...');
    this.emit('agent_spawned', { role: 'architect' });
    this.emit('state_update', { ...this.getState(), projectName: this.projectName });

    const workspaceMap = this.getWorkspaceMap();
    const memoryContext = this.memory.getRelevantLessons(intent);
    const prompt = this.promptBuilder.buildArchitectPrompt(intent, memoryContext, workspaceMap);

    const cfg = this.modelConfig.architect;
    const provider = (cfg.provider === 'opencode' ? 'OPENCODE' : cfg.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    const sysPrompt = 'You are a senior architect. Decompose user intent into a precise task plan. Return a JSON array of task objects with "id", "description", "dependencies", "files_impacted". No explanation.';

    try {
      const response = await callModel(provider, cfg.model, prompt, sysPrompt);
      const tasks = this.parsePlan(response);
      if (!tasks || tasks.length === 0) {
        throw new Error('Plan could not be parsed from model response');
      }
      this.taskQueue = tasks;
      fs.writeFileSync(path.join(this.triadDir, 'task_queue.json'), JSON.stringify(tasks, null, 2));

      try { await this.git.commit(`[${this.sessionId}] [architect] plan created — ${tasks.length} tasks`); } catch (e) {}
      this.emit('plan_ready', { tasks, projectName: this.projectName });
      await this.saveState();
      console.log(`[Conductor] Plan created: ${tasks.length} tasks.`);
      await this.startNextTask();
    } catch (e: any) {
      console.error('[Conductor] Planning failed:', e.message);
      this.emit('error', { message: `Planning failed: ${e.message}` });
      fs.writeFileSync(path.join(this.triadDir, 'state.json'), JSON.stringify({ error: 'planning_failed', message: e.message }));
      this.status = 'failed';
      await this.saveState();
    }
  }

  private async handleExecution(): Promise<void> {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) {
      console.error('[Conductor] No current task for execution.');
      await this.startNextTask();
      return;
    }

    console.log(`[Conductor] Building task ${currentTask.id}: ${currentTask.description.substring(0, 60)}...`);
    this.emit('agent_spawned', { role: 'builder', taskId: currentTask.id });

    const workspaceMap = this.getWorkspaceMap();
    const prompt = this.promptBuilder.buildBuilderPrompt({
      id: currentTask.id,
      description: currentTask.description,
      status: 'in_progress',
      retry_count: currentTask.retries,
      files_impacted: currentTask.files_impacted || [],
      dependencies: currentTask.dependencies,
      auditor_notes: currentTask.auditor_notes,
      reviewer_notes: currentTask.reviewer_notes
    }, workspaceMap, currentTask.reviewer_notes || '', currentTask.auditor_notes || '');

    const cfg = this.modelConfig.builder;
    const provider = (cfg.provider === 'opencode' ? 'OPENCODE' : cfg.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    const sysPrompt = `You are a builder. Execute the given task by using tools.
Available tools: write_file, read_file, run_command
Respond ONLY with a JSON object: {"action": "write_file|run_command|read_file", "path": "...", "content": "...", "command": "..."}
When the task is complete, respond with: {"action": "done", "summary": "what was done"}`;

    try {
      let taskDone = false;
      let retries = 0;
      while (!taskDone && retries < 10) {
        retries++;
        const response = await callModel(provider, cfg.model, prompt, sysPrompt);
        const toolCall = this.extractToolCall(response);

        if (!toolCall) {
          console.warn(`[Conductor] Builder returned unparseable response, retry ${retries}`);
          continue;
        }

        if (toolCall.action === 'done') {
          taskDone = true;
          currentTask.status = 'awaiting_review';
          if (toolCall.path) {
            if (!currentTask.files_impacted) currentTask.files_impacted = [];
            if (!currentTask.files_impacted.includes(toolCall.path)) currentTask.files_impacted.push(toolCall.path);
          }
          console.log(`[Conductor] Task ${currentTask.id} done: ${toolCall.summary || 'completed'}`);
          break;
        }

        try {
          const result = await this.tools.execute(toolCall as ToolCall);
          const lines = result.split('\n').filter(l => l.trim());
          lines.forEach(l => this.emit('log', { role: 'builder', message: l.substring(0, 200) }));
        } catch (e: any) {
          console.error(`[Conductor] Tool execution error: ${e.message}`);
        }
      }

      if (!taskDone) {
        currentTask.status = 'failed';
        currentTask.retries++;
        console.error(`[Conductor] Task ${currentTask.id} failed after max retries.`);
      }

      try { await this.git.commit(`[${this.sessionId}] [builder] ${currentTask.id}: ${taskDone ? 'complete' : 'failed'}`); } catch (e) {}
      await this.saveState();

      if (taskDone) {
        this.status = 'reviewing';
        await this.handleReview();
      } else {
        await this.startNextTask();
      }
    } catch (e: any) {
      console.error(`[Conductor] Builder API error: ${e.message}`);
      currentTask.status = 'failed';
      currentTask.retries++;
      await this.saveState();
      await this.startNextTask();
    }
  }

  private async handleReview(): Promise<void> {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) {
      console.error('[Conductor] No current task for review.');
      await this.startNextTask();
      return;
    }

    console.log(`[Conductor] Reviewing task ${currentTask.id}...`);
    this.emit('agent_spawned', { role: 'reviewer', taskId: currentTask.id });

    const changedFiles = currentTask.files_impacted || [];
    const prompt = this.promptBuilder.buildReviewerPrompt({
      id: currentTask.id,
      description: currentTask.description,
      status: 'awaiting_review',
      retry_count: currentTask.retries,
      files_impacted: changedFiles,
      dependencies: currentTask.dependencies,
      auditor_notes: currentTask.auditor_notes,
      reviewer_notes: currentTask.reviewer_notes
    }, changedFiles, this.cachedIntent);

    const cfg = this.modelConfig.reviewer;
    const provider = (cfg.provider === 'opencode' ? 'OPENCODE' : cfg.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    const sysPrompt = 'Review the code changes for bugs, security issues, and regressions. First line must be either PASS or FAIL.';

    try {
      const response = await callModel(provider, cfg.model, prompt, sysPrompt);
      const verdict = this.parseReviewVerdict(response);
      currentTask.reviewer_notes = response;

      if (verdict === 'PASS') {
        console.log('[Conductor] Review PASSED.');
        currentTask.status = 'awaiting_audit';
        this.status = 'auditing';
        try { await this.git.commit(`[${this.sessionId}] [reviewer] ${currentTask.id}: PASS`); } catch (e) {}
        await this.saveState();
        await this.handleAudit();
      } else {
        currentTask.retries++;
        if (currentTask.retries >= 3) {
          currentTask.status = 'failed';
          console.error(`[Conductor] Task ${currentTask.id} failed review after 3 retries.`);
          try { await this.git.commit(`[${this.sessionId}] [reviewer] ${currentTask.id}: FAIL — max retries`); } catch (e) {}
          await this.saveState();
          await this.startNextTask();
        } else {
          console.log(`[Conductor] Review FAILED, retry ${currentTask.retries}/3.`);
          try { await this.git.commit(`[${this.sessionId}] [reviewer] ${currentTask.id}: FAIL — retry ${currentTask.retries}`); } catch (e) {}
          this.status = 'executing';
          await this.saveState();
          await this.handleExecution();
        }
      }
    } catch (e: any) {
      console.error(`[Conductor] Review API error: ${e.message}`);
      currentTask.status = 'awaiting_audit';
      this.status = 'auditing';
      await this.saveState();
      await this.handleAudit();
    }
  }

  private async handleAudit(): Promise<void> {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) {
      console.error('[Conductor] No current task for audit.');
      await this.startNextTask();
      return;
    }

    console.log(`[Conductor] Auditing task ${currentTask.id}...`);
    this.emit('agent_spawned', { role: 'auditor', taskId: currentTask.id });

    const prompt = this.promptBuilder.buildAuditorPrompt({
      id: currentTask.id,
      description: currentTask.description,
      status: 'awaiting_audit',
      retry_count: currentTask.retries,
      files_impacted: currentTask.files_impacted || [],
      dependencies: currentTask.dependencies,
      auditor_notes: currentTask.auditor_notes,
      reviewer_notes: currentTask.reviewer_notes
    }, currentTask.reviewer_notes || '');

    const cfg = this.modelConfig.auditor;
    const provider = (cfg.provider === 'opencode' ? 'OPENCODE' : cfg.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    const sysPrompt = 'Verify the task is fully and correctly completed. First line must be either PASS or FAIL. Include a Lesson section if passing.';

    try {
      const response = await callModel(provider, cfg.model, prompt, sysPrompt);
      const verdict = this.parseReviewVerdict(response);
      currentTask.auditor_notes = response;

      if (verdict === 'PASS') {
        currentTask.status = 'completed';
        console.log(`[Conductor] Audit PASSED for task ${currentTask.id}.`);
        const lesson = this.extractLesson(response);
        if (lesson) this.memory.addLesson(this.projectName, currentTask.description, lesson);
        try { await this.git.commit(`[${this.sessionId}] [auditor] ${currentTask.id}: PASS`); } catch (e) {}
        await this.saveState();
        this.loopCount++;
        await this.startNextTask();
      } else {
        currentTask.retries++;
        if (currentTask.retries >= 3) {
          currentTask.status = 'failed';
          console.error(`[Conductor] Task ${currentTask.id} failed audit after 3 retries.`);
          try { await this.git.commit(`[${this.sessionId}] [auditor] ${currentTask.id}: FAIL — max retries`); } catch (e) {}
          await this.saveState();
          await this.startNextTask();
        } else {
          console.log(`[Conductor] Audit FAILED, retry ${currentTask.retries}/3.`);
          try { await this.git.commit(`[${this.sessionId}] [auditor] ${currentTask.id}: FAIL — retry ${currentTask.retries}`); } catch (e) {}
          this.status = 'executing';
          await this.saveState();
          await this.handleExecution();
        }
      }
    } catch (e: any) {
      console.error(`[Conductor] Audit API error: ${e.message}`);
      currentTask.retries++;
      if (currentTask.retries >= 3) {
        currentTask.status = 'failed';
      }
      await this.saveState();
      if (currentTask.status !== 'failed') {
        this.status = 'executing';
        await this.handleExecution();
      } else {
        await this.startNextTask();
      }
    }
  }

  private extractToolCall(response: string): any {
    try { const r = JSON.parse(response.trim()); if (r.action) return r; } catch (e) {}
    const m = response.match(/\{[^{}]*"action"[^{}]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    return null;
  }

  // ========== Task queue management ==========

  private async startNextTask(): Promise<void> {
    const nextTask = this.taskQueue.find(t =>
      t.status === 'pending' || t.status === 'failed'
    );

    if (!nextTask) {
      const allDone = this.taskQueue.length > 0 && this.taskQueue.every(t => t.status === 'completed');
      if (allDone) {
        await this.completeProject();
      } else {
        console.log('[Conductor] No pending tasks. Waiting...');
        this.status = 'idle';
        await this.saveState();
      }
      return;
    }

    this.currentTaskId = nextTask.id;
    this.status = 'executing';
    await this.saveState();
    await this.handleExecution();
  }

  private async completeProject(): Promise<void> {
    console.log('[Conductor] All tasks complete!');
    this.status = 'completed';
    try {
      await this.git.commit(`[${this.sessionId}] [project] COMPLETE — ${this.taskQueue.length} tasks, ${this.loopCount} loops`);
    } catch (e: any) {
      console.error('[Conductor] Git commit failed (non-blocking):', e.message);
    }
    await this.saveState();
    this.emit('project_complete', {
      projectName: this.projectName,
      taskCount: this.taskQueue.length,
      loopCount: this.loopCount,
    });
  }

  private async resumePipeline(): Promise<void> {
    const pending = this.taskQueue.find(t =>
      t.status === 'pending' || t.status === 'failed'
    );
    if (pending) {
      this.currentTaskId = pending.id;
      this.status = 'executing';
      await this.saveState();
      await this.handleExecution();
    } else if (this.taskQueue.some(t => t.status === 'completed' || t.status === 'awaiting_audit')) {
      this.status = 'idle';
      await this.saveState();
      await this.startNextTask();
    } else {
      console.log('[Conductor] No state to resume from. Restarting pipeline.');
      this.status = 'planning';
      await this.saveState();
    }
  }

  // ========== Parsing utilities ==========

  private parsePlan(content: string): TaskQueueEntry[] | null {
    const tasks: TaskQueueEntry[] = [];

    // Strategy 1: Structured markdown (### Task N with **ID:** labels)
    const taskRegex = /### Task (\d+)\s*\*\*ID:\*\*\s*(\S+)\s*\*\*Description:\*\*\s*(.+?)\s*\*\*Dependencies:\*\*\s*(.+?)\s*\*\*Files to create or modify:\*\*\s*(.+?)(?=###|$)/gs;
    let match;
    while ((match = taskRegex.exec(content)) !== null) {
      const deps = match[4].trim();
      tasks.push({
        id: match[2].trim(),
        description: match[3].trim(),
        dependencies: deps === 'none' || deps === 'N/A' ? [] : deps.split(',').map((d: string) => d.trim()),
        files_impacted: match[5].split(',').map((f: string) => f.trim()),
        estimated_complexity: 'medium',
        status: 'pending',
        retries: 0,
        reviewer_notes: '',
        auditor_notes: '',
      });
    }

    // Strategy 2: Markdown list items (- or *)
    if (tasks.length === 0) {
      const lines = content.split('\n').map(l => l.trim()).filter(l =>
        l.startsWith('-') || l.startsWith('*') || /^\d+[\.\)]/.test(l)
      );
      if (lines.length > 0) {
        lines.forEach((line, i) => {
          const desc = line.replace(/^[-*\d]+[\.\)]?\s*/, '').trim();
          if (desc) {
            tasks.push({
              id: `t${i + 1}`,
              description: desc,
              dependencies: [],
              files_impacted: [],
              estimated_complexity: 'medium',
              status: 'pending',
              retries: 0,
              reviewer_notes: '',
              auditor_notes: '',
            });
          }
        });
      }
    }

    // Strategy 3: Numbered JSON array ["task1", "task2", ...]
    if (tasks.length === 0) {
      try {
        const jsonArray = JSON.parse(content);
        if (Array.isArray(jsonArray)) {
          jsonArray.forEach((item: any, i: number) => {
            const desc = typeof item === 'string' ? item : item.description || item.task || '';
            if (desc) {
              tasks.push({
                id: `t${i + 1}`,
                description: desc,
                dependencies: [],
                files_impacted: [],
                estimated_complexity: 'medium',
                status: 'pending',
                retries: 0,
                reviewer_notes: '',
                auditor_notes: '',
              });
            }
          });
        }
      } catch (e) {}
    }

    return tasks.length > 0 ? tasks : null;
  }

  private parseReviewVerdict(content: string): 'PASS' | 'FAIL' {
    const firstLine = content.trim().split('\n')[0].toUpperCase().trim();
    // Check first line starts with PASS or FAIL (word boundary)
    if (/^PASS\b/.test(firstLine)) return 'PASS';
    if (/^FAIL\b/.test(firstLine)) return 'FAIL';
    if (/^#+\s*PASS\b/.test(firstLine)) return 'PASS';
    if (/^#+\s*FAIL\b/.test(firstLine)) return 'FAIL';

    // Check for **Verdict:** marker
    const verdictMatch = content.match(/\*\*Verdict:\*\*\s*(PASS|FAIL)/i);
    if (verdictMatch) return verdictMatch[1].toUpperCase() as 'PASS' | 'FAIL';

    // Check for Verdict: marker
    const verdictMatch2 = content.match(/Verdict:\s*(PASS|FAIL)/i);
    if (verdictMatch2) return verdictMatch2[1].toUpperCase() as 'PASS' | 'FAIL';

    // Fallback: check if "PASS" appears as a standalone word (not preceded by NOT)
    const hasPass = /\bPASS\b/i.test(content);
    const hasFail = /\bFAIL\b/i.test(content);
    const hasNot = /\bNOT\s+PASS\b/i.test(content);

    if (hasNot) return 'FAIL';
    if (hasPass && !hasFail) return 'PASS';
    if (hasFail && !hasPass) return 'FAIL';

    return 'FAIL';
  }

  private extractLesson(content: string): string {
    const lessonMatch = content.match(/## Lesson\s*\n([\s\S]+?)(?=##|$)/);
    if (lessonMatch) {
      return lessonMatch[1].trim();
    }

    const lineMatch = content.match(/\*\*Lesson\*\*\s*(.+)/i);
    if (lineMatch) {
      return lineMatch[1].trim();
    }

    return '';
  }

  // ========== File builders ==========

  private buildIntentFile(intent: string): string {
    return `# Project Intent\n\n${intent}\n\n## Constraints\n- Only modify files within the workspace directory\n- Write all outputs to .triad/ files as instructed\n- Do not ask for clarification — make the best decision and proceed\n`;
  }

  private buildTaskCurrentFile(task: TaskQueueEntry, reviewerNotes: string, auditorNotes: string): string {
    const completedTasks = this.taskQueue.filter(t => t.status === 'completed');
    const completedDesc = completedTasks.map(t => `- ${t.id}: ${t.description}`).join('\n');

    return `# Current Task\n\n**Task ID:** ${task.id}\n**Description:** ${task.description}\n**Previous attempts:** ${task.retries}\n**Reviewer notes from prior attempt:** ${reviewerNotes || '(none)'}\n**Auditor notes from prior attempt:** ${auditorNotes || '(none)'}\n\n## Context\n- intent.md contains the project goal\n- plan.md contains the full task list\n${completedDesc ? `- Completed tasks:\n${completedDesc}` : '- No tasks completed yet'}\n- Focus ONLY on this task\n\n## Output requirement\nWhen you have finished all file edits for this task, write an empty file to \`.triad/done.signal\`. Write nothing else to .triad/. Do not explain your work to me — just execute.\n`;
  }

  // ========== Helpers ==========

  private async ensureRepo(): Promise<void> {
    const gitDir = path.join(this.workspacePath, '.git');
    if (!fs.existsSync(gitDir)) {
      await this.git.init();
    }
  }

  private getWorkspaceMap(): string[] {
    const now = Date.now();
    if (this.workspaceMapCache && (now - this.workspaceMapCacheTime) < 10000) {
      return this.workspaceMapCache;
    }
    this.workspaceMapCache = this.walkDir(this.workspacePath);
    this.workspaceMapCacheTime = now;
    return this.workspaceMapCache;
  }

  private walkDir(dir: string, fileList: string[] = [], baseDir?: string): string[] {
    const relativeBase = baseDir || dir;
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const name = path.join(dir, file);
      if (fs.statSync(name).isDirectory()) {
        if (!file.startsWith('.') && file !== 'node_modules' && file !== '.git') {
          this.walkDir(name, fileList, relativeBase);
        }
      } else {
        fileList.push(path.relative(relativeBase, name));
      }
    });
    return fileList;
  }

  private initCheckpoint(intent: string): void {
    if (fs.existsSync(this.checkpointPath)) {
      try {
        this.checkpoint = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf-8'));
        if (this.checkpoint?.status === 'completed') this.checkpoint = null;
      } catch (e) { this.checkpoint = null; }
    }
    if (!this.checkpoint) {
      this.checkpoint = {
        session_id: this.sessionId,
        project_name: this.projectName,
        status: 'planning',
        intent_hash: crypto.createHash('sha256').update(intent || '').digest('hex'),
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

  private saveCheckpoint(): void {
    if (!this.checkpoint) return;
    this.checkpoint.last_checkpoint_at = new Date().toISOString();
    this.checkpoint.loop_count = this.loopCount;
    this.checkpoint.status = this.status;
    this.checkpoint.current_task_id = this.currentTaskId || '';
    this.checkpoint.model_config_snapshot = {
      architect: { provider: this.modelConfig.architect.provider || '', name: this.modelConfig.architect.model },
      builder: { provider: this.modelConfig.builder.provider || '', name: this.modelConfig.builder.model },
      reviewer: { provider: this.modelConfig.reviewer.provider || '', name: this.modelConfig.reviewer.model },
      auditor: { provider: this.modelConfig.auditor.provider || '', name: this.modelConfig.auditor.model }
    };
    // Sync tasks from taskQueue
    this.checkpoint.tasks = this.taskQueue.map(t => ({
      id: t.id,
      description: t.description,
      status: t.status,
      completed_at: t.status === 'completed' ? new Date().toISOString() : null,
      retry_count: t.retries,
      files_created: t.files_impacted || [],
      files_modified: [],
      files_deleted: [],
      reviewer_notes: t.reviewer_notes || null,
      auditor_notes: t.auditor_notes || null
    }));
    try { fs.writeFileSync(this.checkpointPath, JSON.stringify(this.checkpoint, null, 2)); } catch (e) {}
  }

  private async saveState(): Promise<void> {
    const state = {
      session_id: this.sessionId,
      project: this.projectName,
      status: this.status,
      current_task_id: this.currentTaskId,
      loop_count: this.loopCount,
      task_queue: this.taskQueue,
      active_agents: [],
      last_commit: '',
      started_at: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(this.triadDir, 'state.json'), JSON.stringify(state, null, 2));
    this.emit('state_update', state);
    this.saveCheckpoint();

    db.upsertProject(this.projectName,
      this.cachedIntent || (fs.existsSync(path.join(this.triadDir, 'intent.md')) ? fs.readFileSync(path.join(this.triadDir, 'intent.md'), 'utf-8') : ''),
      this.status, 50, this.loopCount,
      JSON.stringify(this.modelConfig)
    );
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getStatus(): ConductorStatus {
    return this.status;
  }
}
