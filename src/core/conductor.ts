import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileBus } from './file-bus';
import { GitManager, CommitEntry } from './git-manager';
import { CLISpawner } from './cli-spawner';
import { PromptBuilder } from './prompt-builder';
import { PromptSanitizer } from './prompt-sanitizer';
import { SharedMemory } from './memory';
import { VisualBridge } from './visual-bridge';
import { db } from './database';
import {
  AgentRole, ConductorStatus, ProjectModelConfig,
  DEFAULT_MODEL_CONFIG, TaskQueueEntry, Checkpoint, CheckpointTask
} from './types';

const AGENT_TIMEOUT_MS = 8 * 60 * 1000;

export class Conductor {
  private projectName: string;
  private workspacePath: string;
  private fileBus: FileBus;
  private git: GitManager;
  private spawner: CLISpawner;
  private promptBuilder: PromptBuilder;
  private sanitizer: PromptSanitizer;
  private memory: SharedMemory;
  private visual: VisualBridge;
  private sessionId: string;
  private status: ConductorStatus;
  private taskQueue: TaskQueueEntry[];
  private currentTaskId: string | null;
  private modelConfig: ProjectModelConfig;
  private loopCount: number;
  private timeoutTimers: Map<AgentRole, NodeJS.Timeout> = new Map();
  private broadcastFn: ((event: string, data: any) => void) | null = null;
  private checkpoint: Checkpoint | null = null;
  private checkpointPath: string = '';
  private workspaceMapCache: string[] | null = null;
  private workspaceMapCacheTime: number = 0;
  private cachedIntent: string = '';

  constructor(projectName: string, workspacePath: string) {
    this.projectName = projectName;
    this.workspacePath = workspacePath;
    this.fileBus = new FileBus(workspacePath);
    this.git = new GitManager(workspacePath);
    this.spawner = new CLISpawner(workspacePath);
    this.promptBuilder = new PromptBuilder();
    this.sanitizer = new PromptSanitizer();
    this.memory = new SharedMemory();
    this.visual = new VisualBridge(workspacePath);
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
    this.spawner.setBroadcast(fn);
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

    this.cachedIntent = intent;
    this.fileBus.write('intent.md', this.buildIntentFile(intent));
    this.fileBus.write('model_config.json', JSON.stringify(this.modelConfig, null, 2));

    const memoryContext = this.memory.getRelevantLessons(intent);
    this.fileBus.write('memory_context.md', memoryContext || 'No relevant past lessons found.');

    this.initCheckpoint(intent);
    this.registerFileHandlers();

    await this.saveState();
    await this.git.commit(`[${this.sessionId}] [system] session initialized`);

    this.status = 'planning';
    this.spawnArchitect(intent);
    this.emit('conductor_started', { sessionId: this.sessionId, projectName: this.projectName });
    // Periodic state broadcast for live dashboard updates
    this.stateInterval = setInterval(() => this.emit('state_update', { ...this.getState(), projectName: this.projectName }), 2000);
  }

  private stateInterval: NodeJS.Timeout | null = null;

  async stop(): Promise<void> {
    console.log(`[Conductor] Stopping project "${this.projectName}"...`);
    if (this.stateInterval) { clearInterval(this.stateInterval); this.stateInterval = null; }
    this.clearTimeouts();
    this.spawner.killAll();
    this.status = 'failed';
    await this.saveState();
    this.emit('conductor_stopped', { projectName: this.projectName });
  }

  async pause(): Promise<void> {
    console.log(`[Conductor] Pausing project "${this.projectName}"...`);
    this.status = 'paused';
    this.clearTimeouts();
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
      active_agents: this.spawner.getActiveRoles(),
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

  // ========== File handlers ==========

  private registerFileHandlers(): void {
    this.fileBus.watch('plan.md', (content) => this.onPlanReady(content));
    this.fileBus.watch('done.signal', () => this.onTaskDone());
    this.fileBus.watch('review.md', (content) => this.onReviewReady(content));
    this.fileBus.watch('audit.md', (content) => this.onAuditReady(content));
    this.fileBus.watch('fail_signal', (content) => this.onFailSignal(content));
  }

  private async onPlanReady(planContent: string): Promise<void> {
    console.log('[Conductor] Plan received from Architect.');
    const tasks = this.parsePlan(planContent);

    if (!tasks || tasks.length === 0) {
      console.error('[Conductor] Architect plan could not be parsed.');
      this.emit('error', { message: 'Architect plan could not be parsed. Check architect terminal.' });
      this.fileBus.write('state.json', JSON.stringify({ error: 'plan_parse_failed' }, null, 2));
      return;
    }

    this.taskQueue = tasks;
    this.fileBus.write('task_queue.json', JSON.stringify(tasks, null, 2));

    try {
      await this.git.commit(`[${this.sessionId}] [architect] plan created — ${tasks.length} tasks`);
    } catch (e: any) {
      console.error('[Conductor] Git commit failed (non-blocking):', e.message);
      this.emit('warning', { message: `Git commit failed: ${e.message}` });
    }

    this.emit('plan_ready', { tasks, projectName: this.projectName });
    await this.saveState();
    await this.startNextTask();
  }

  private async onTaskDone(): Promise<void> {
    console.log('[Conductor] Task done signal received.');
    this.spawner.kill('builder');
    this.clearTimeout('builder');

    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (currentTask) {
      currentTask.status = 'completed';
    }

    try {
      await this.git.commit(`[${this.sessionId}] [builder] ${this.currentTaskId || 'task'} complete`);
    } catch (e: any) {
      console.error('[Conductor] Git commit failed (non-blocking):', e.message);
    }

    await this.saveState();
    this.status = 'reviewing';
    this.spawnReviewer();
  }

  private async onReviewReady(reviewContent: string): Promise<void> {
    console.log('[Conductor] Review received.');
    this.spawner.kill('reviewer');
    this.clearTimeout('reviewer');

    const verdict = this.parseReviewVerdict(reviewContent);
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);

    if (verdict === 'PASS') {
      console.log('[Conductor] Review PASSED.');
      if (currentTask) {
        currentTask.reviewer_notes = reviewContent;
        currentTask.status = 'awaiting_audit';
      }

      try {
        await this.git.commit(`[${this.sessionId}] [reviewer] ${this.currentTaskId || 'task'}: PASS`);
      } catch (e: any) {
        console.error('[Conductor] Git commit failed (non-blocking):', e.message);
      }

      await this.saveState();
      this.status = 'auditing';
      this.spawnAuditor(reviewContent);
    } else {
      console.log('[Conductor] Review FAILED.');
      if (currentTask) {
        currentTask.retries++;
        currentTask.reviewer_notes = reviewContent;

        if (currentTask.retries >= 3) {
          console.error(`[Conductor] Task ${this.currentTaskId} failed after 3 retries. Escalating.`);
          currentTask.status = 'failed';
          try {
            await this.git.commit(`[${this.sessionId}] [reviewer] ${this.currentTaskId}: FAIL — max retries`);
          } catch (e: any) {}
          await this.saveState();
          this.emit('task_failed', { taskId: this.currentTaskId, notes: reviewContent });
          await this.startNextTask();
        } else {
          try {
            await this.git.commit(`[${this.sessionId}] [reviewer] ${this.currentTaskId}: FAIL — retry ${currentTask.retries}`);
          } catch (e: any) {}
          await this.saveState();
          this.status = 'executing';
          this.spawnBuilder(reviewContent, '');
        }
      }
    }
  }

  private async onAuditReady(auditContent: string): Promise<void> {
    console.log('[Conductor] Audit received.');
    this.spawner.kill('auditor');
    this.clearTimeout('auditor');

    const verdict = this.parseReviewVerdict(auditContent);
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);

    if (verdict === 'PASS') {
      console.log('[Conductor] Audit PASSED.');
      if (currentTask) {
        currentTask.status = 'completed';
        currentTask.auditor_notes = auditContent;

        const lesson = this.extractLesson(auditContent);
        if (lesson) {
          this.memory.addLesson(this.projectName, currentTask.description, lesson);
          console.log(`[Conductor] Lesson saved: ${lesson.substring(0, 60)}...`);
        }
      }

      try {
        await this.git.commit(`[${this.sessionId}] [auditor] ${this.currentTaskId || 'task'}: PASS — completed`);
      } catch (e: any) {
        console.error('[Conductor] Git commit failed (non-blocking):', e.message);
      }

      await this.saveState();
      await this.startNextTask();
    } else {
      console.log('[Conductor] Audit FAILED.');
      if (currentTask) {
        currentTask.retries++;
        currentTask.auditor_notes = auditContent;

        if (currentTask.retries >= 3) {
          console.error(`[Conductor] Task ${this.currentTaskId} failed audit after 3 retries. Escalating.`);
          currentTask.status = 'failed';
          try {
            await this.git.commit(`[${this.sessionId}] [auditor] ${this.currentTaskId}: FAIL — max retries`);
          } catch (e: any) {}
          await this.saveState();
          this.emit('task_failed', { taskId: this.currentTaskId, notes: auditContent });
          await this.startNextTask();
        } else {
          try {
            await this.git.commit(`[${this.sessionId}] [auditor] ${this.currentTaskId}: FAIL — retry ${currentTask.retries}`);
          } catch (e: any) {}
          await this.saveState();
          this.status = 'executing';
          this.spawnBuilder('', auditContent);
        }
      }
    }
  }

  private async onFailSignal(content: string): Promise<void> {
    console.error(`[Conductor] Fail signal received: ${content}`);
    this.spawner.killAll();
    this.clearTimeouts();
    this.status = 'failed';

    try {
      await this.git.commit(`[${this.sessionId}] [system] pipeline failed`);
    } catch (e: any) {
      console.error('[Conductor] Git commit failed (non-blocking):', e.message);
    }

    await this.saveState();
    this.emit('pipeline_failed', { projectName: this.projectName, reason: content });
  }

  // ========== Agent spawning ==========

  private spawnArchitect(intent: string): void {
    const workspaceMap = this.getWorkspaceMap();
    const memoryContext = this.fileBus.read('memory_context.md');
    const prompt = this.promptBuilder.buildArchitectPrompt(intent, memoryContext, workspaceMap);
    const sanitized = this.sanitizer.sanitizeTaskDescription(prompt);

    console.log('[Conductor] Spawning Architect...');
    this.spawner.spawnByCLI('opencode', 'architect', sanitized, this.modelConfig.architect);
    this.setTimeout('architect', AGENT_TIMEOUT_MS);
    this.emit('agent_spawned', { role: 'architect' });
  }

  private spawnBuilder(reviewerNotes: string, auditorNotes: string): void {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) {
      console.error('[Conductor] No current task to build.');
      return;
    }

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
    }, workspaceMap, reviewerNotes, auditorNotes);
    const sanitized = this.sanitizer.sanitizeTaskDescription(prompt);

    this.fileBus.write('task_current.md', this.buildTaskCurrentFile(currentTask, reviewerNotes, auditorNotes));

    console.log(`[Conductor] Spawning Builder for task ${currentTask.id}...`);
    this.spawner.spawnByCLI('opencode', 'builder', sanitized, this.modelConfig.builder);
    this.setTimeout('builder', AGENT_TIMEOUT_MS);
    this.emit('agent_spawned', { role: 'builder', taskId: currentTask.id });
  }

  private spawnReviewer(): void {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) {
      console.error('[Conductor] No current task to review.');
      return;
    }

    const changedFiles = currentTask.files_impacted || [];
    const intent = this.fileBus.exists('intent.md') ? this.fileBus.read('intent.md') : '';
    const prompt = this.promptBuilder.buildReviewerPrompt({
      id: currentTask.id,
      description: currentTask.description,
      status: 'awaiting_review',
      retry_count: currentTask.retries,
      files_impacted: currentTask.files_impacted || [],
      dependencies: currentTask.dependencies,
      auditor_notes: currentTask.auditor_notes,
      reviewer_notes: currentTask.reviewer_notes
    }, changedFiles, intent);
    const sanitized = this.sanitizer.sanitizeTaskDescription(prompt);

    console.log(`[Conductor] Spawning Reviewer for task ${currentTask.id}...`);
    this.spawner.spawnByCLI('opencode', 'reviewer', sanitized, this.modelConfig.reviewer);
    this.setTimeout('reviewer', AGENT_TIMEOUT_MS);
    this.emit('agent_spawned', { role: 'reviewer', taskId: currentTask.id });
  }

  private spawnAuditor(reviewNotes: string): void {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) {
      console.error('[Conductor] No current task to audit.');
      return;
    }

    let screenshotPath: string | undefined;
    const htmlFiles = (currentTask.files_impacted || []).filter(f => f.endsWith('.html'));
    if (htmlFiles.length > 0) {
      const screenshotsDir = path.join(this.workspacePath, '.triad', 'screenshots');
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }
      screenshotPath = screenshotsDir;
    }

    const prompt = this.promptBuilder.buildAuditorPrompt({
      id: currentTask.id,
      description: currentTask.description,
      status: 'awaiting_audit',
      retry_count: currentTask.retries,
      files_impacted: currentTask.files_impacted || [],
      dependencies: currentTask.dependencies,
      auditor_notes: currentTask.auditor_notes,
      reviewer_notes: currentTask.reviewer_notes
    }, reviewNotes, screenshotPath);
    const sanitized = this.sanitizer.sanitizeTaskDescription(prompt);

    console.log(`[Conductor] Spawning Auditor for task ${currentTask.id}...`);
    this.spawner.spawnByCLI(this.modelConfig.auditor.cli, 'auditor', sanitized, this.modelConfig.auditor);
    this.setTimeout('auditor', AGENT_TIMEOUT_MS);
    this.emit('agent_spawned', { role: 'auditor', taskId: currentTask.id });
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
    this.spawnBuilder('', '');
  }

  private async completeProject(): Promise<void> {
    console.log('[Conductor] All tasks complete!');
    this.status = 'completed';
    this.spawner.killAll();
    this.clearTimeouts();

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
      this.spawnBuilder('', '');
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
      active_agents: this.spawner.getActiveRoles(),
      last_commit: '',
      started_at: new Date().toISOString(),
    };

    this.fileBus.write('state.json', JSON.stringify(state, null, 2));
    this.emit('state_update', state);
    this.saveCheckpoint();

    db.upsertProject(this.projectName,
      this.cachedIntent || (this.fileBus.exists('intent.md') ? this.fileBus.read('intent.md') : ''),
      this.status, 50, this.loopCount,
      JSON.stringify(this.modelConfig)
    );
  }

  // ========== Timeout management ==========

  private setTimeout(role: AgentRole, ms: number): void {
    this.clearTimeout(role);
    const timer = setTimeout(() => this.handleTimeout(role), ms);
    this.timeoutTimers.set(role, timer);
  }

  private clearTimeout(role: AgentRole): void {
    const timer = this.timeoutTimers.get(role);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(role);
    }
  }

  private clearTimeouts(): void {
    this.timeoutTimers.forEach((timer) => clearTimeout(timer));
    this.timeoutTimers.clear();
  }

  private async handleTimeout(role: AgentRole): Promise<void> {
    console.error(`[Conductor] Agent ${role} timed out.`);
    this.spawner.kill(role);
    this.clearTimeout(role);

    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (currentTask) {
      currentTask.retries++;
      if (currentTask.retries >= 3) {
        currentTask.status = 'failed';
        console.error(`[Conductor] Task ${this.currentTaskId} failed after 3 timeouts.`);
        try {
          await this.git.commit(`[${this.sessionId}] [${role}] ${this.currentTaskId}: TIMEOUT — max retries`);
        } catch (e: any) {}
        await this.saveState();
        this.emit('task_failed', { taskId: this.currentTaskId, reason: 'timeout' });
        await this.startNextTask();
        return;
      }
      currentTask.status = 'pending';
      try {
        await this.git.commit(`[${this.sessionId}] [${role}] ${this.currentTaskId || 'task'}: TIMEOUT — retry ${currentTask.retries}`);
      } catch (e: any) {}
      await this.saveState();
      this.emit('agent_timeout', { role, taskId: this.currentTaskId, retry: currentTask.retries });
      // Re-spawn the agent
      this.respawnAgent(role);
    }
  }

  private respawnAgent(role: AgentRole): void {
    if (role === 'architect') {
      const intent = this.fileBus.exists('intent.md') ? this.fileBus.read('intent.md') : '';
      this.spawnArchitect(intent);
    } else if (role === 'builder') {
      this.spawnBuilder('', '');
    } else if (role === 'reviewer') {
      this.spawnReviewer();
    } else if (role === 'auditor') {
      const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
      this.spawnAuditor(currentTask?.reviewer_notes || '');
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getStatus(): ConductorStatus {
    return this.status;
  }
}
