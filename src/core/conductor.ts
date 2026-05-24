import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GitManager, CommitEntry } from './git-manager';
import { PromptBuilder } from './prompt-builder';
import { SharedMemory } from './memory';
import { db } from './database';
import { callModel } from './model-provider';
import { ToolExecutor, ToolCall } from './tools';
import { PromptSanitizer } from './prompt-sanitizer';
import { CLISpawner, CLISpawnResult } from './cli-spawner';
import { UITester, UITestResult } from './ui-tester';
import { TechStackDetector } from './tech-stack-detector';
import { StageRouter, StageDecision, ProgressReport } from './stage-router';
import { CrossHarnessAdapter, HarnessType, CrossHarnessResult, ECC_MCP_CONFIGS } from './cross-harness-adapter';
import { Verifier } from './verifier';
import { SecurityGuard } from './security-guard';
import { CostTracker } from './cost-tracker';
import {
  AgentRole, ConductorStatus, ProjectModelConfig,
  DEFAULT_MODEL_CONFIG, TaskQueueEntry, Checkpoint
} from './types';

const MAX_RETRIES = 3;

const UI_EXTENSIONS = ['.html', '.css', '.js', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.scss', '.less'];

function taskHasUIFiles(task: TaskQueueEntry): boolean {
  const files = task.files_impacted || [];
  if (files.length === 0) {
    const desc = (task.description || '').toLowerCase();
    return /html|css|component|page|ui|frontend|interface|layout|button|form|input|modal|navbar|sidebar|dashboard|landing/.test(desc);
  }
  return files.some(f => UI_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext)));
}

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
  private currentAgentRole: AgentRole | null = null;
  private modelConfig: ProjectModelConfig;
  private loopCount: number;
  private broadcastFn: ((event: string, data: any) => void) | null = null;
  private checkpoint: Checkpoint | null = null;
  private checkpointPath: string = '';
  private workspaceMapCache: string[] | null = null;
  private workspaceMapCacheTime: number = 0;
  private cachedIntent: string = '';
  private tools: ToolExecutor;
  private sanitizer: PromptSanitizer;
  private abortController: AbortController | null = null;
  private cliSpawner: CLISpawner | null = null;
  private uiTester: UITester | null = null;
  private techStack: TechStackDetector;
  private router: StageRouter | null = null;
  private crossHarness: CrossHarnessAdapter | null = null;
  private verifier: Verifier | null = null;
  private security: SecurityGuard | null = null;
  private costTracker: CostTracker | null = null;
  private pauseTimeout: NodeJS.Timeout | null = null;
  private pausedAt: number = 0;
  private stateInterval: NodeJS.Timeout | null = null;

  constructor(projectName: string, workspacePath: string) {
    this.projectName = projectName;
    this.workspacePath = workspacePath;
    this.git = new GitManager(workspacePath);
    this.tools = new ToolExecutor(workspacePath);
    this.promptBuilder = new PromptBuilder();
    this.memory = new SharedMemory();
    this.sanitizer = new PromptSanitizer();
    this.techStack = new TechStackDetector();
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
    this.cliSpawner = new CLISpawner(this.workspacePath);
    this.cliSpawner.setBroadcast(fn);
    this.uiTester = new UITester(this.workspacePath);
    this.uiTester.setBroadcast(fn);
    this.crossHarness = new CrossHarnessAdapter(this.workspacePath);
    this.crossHarness.setBroadcast(fn);
    this.verifier = new Verifier(this.workspacePath);
    this.verifier.setBroadcast(fn);
    this.security = new SecurityGuard(this.workspacePath);
    this.costTracker = new CostTracker(0.50);
    this.costTracker.setBroadcast(fn);
  }

  private emit(event: string, data: any): void {
    if (this.broadcastFn) {
      this.broadcastFn(event, { ...data, projectName: this.projectName });
    }
    if (event === 'log' && this.sessionId) {
      try { db.addLog(this.projectName, this.sessionId, data.message || JSON.stringify(data)); } catch (e: any) {}
    }
  }

  async start(intent: string): Promise<void> {
    console.log(`[Conductor] Starting project "${this.projectName}"...`);
    const sanitizedIntent = this.sanitizer.sanitizeTaskDescription(intent);
    await this.ensureRepo();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
    this.sessionId = `session-${dateStr}`;
    await this.git.createSessionBranch(this.sessionId);
    const modelConfigPath = path.join(this.workspacePath, '.triad', 'model_config.json');
    if (fs.existsSync(modelConfigPath)) {
      try { this.modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8')); } catch (e) { console.warn('[Conductor] Failed to parse model_config.json, using defaults'); }
    }
    this.triadDir = path.join(this.workspacePath, '.triad');
    if (!fs.existsSync(this.triadDir)) fs.mkdirSync(this.triadDir, { recursive: true });
    this.cachedIntent = sanitizedIntent;
    fs.writeFileSync(path.join(this.triadDir, 'intent.md'), this.buildIntentFile(sanitizedIntent));
    fs.writeFileSync(path.join(this.triadDir, 'model_config.json'), JSON.stringify(this.modelConfig, null, 2));
    const memoryContext = this.memory.getRelevantLessons(sanitizedIntent);
    fs.writeFileSync(path.join(this.triadDir, 'memory_context.md'), memoryContext || 'No relevant past lessons found.');
    this.initCheckpoint(sanitizedIntent);
    this.router = new StageRouter(this.sessionId, this.projectName, now.toISOString(), sanitizedIntent);
    await this.saveState();
    try { await this.git.commit(`[${this.sessionId}] [system] session initialized`); } catch (e) {}
    this.abortController = new AbortController();
    this.status = 'planning';
    this.emit('conductor_started', { sessionId: this.sessionId, projectName: this.projectName });
    this.emit('log', { role: 'system', message: `[ROUTER] StageRouter initialized — intelligent stage dispatch active` });
    this.emit('log', { role: 'system', message: `[SYSTEM] Conductor started — session ${this.sessionId}` });
    this.emit('state_update', { ...this.getState(), projectName: this.projectName });
    this.stateInterval = setInterval(() => this.emit('state_update', { ...this.getState(), projectName: this.projectName }), 1000);
    try {
      db.upsertSession({ id: this.sessionId, project_name: this.projectName, git_branch: `session/${this.sessionId}`, status: 'active', task_count: 0, completed_count: 0, retry_count: 0 });
    } catch (e: any) { console.error(`[Conductor] DB session write failed (non-fatal): ${e.message}`); }
    setImmediate(() => this.dispatch().catch(e => {
      console.error('[Conductor] Pipeline error:', e.message);
      this.status = 'failed';
      if (this.stateInterval) { clearInterval(this.stateInterval); this.stateInterval = null; }
      if (e.name === 'AbortError' || e.name === 'CanceledError') { console.log('[Conductor] Pipeline aborted.'); return; }
      this.emit('pipeline_failed', { projectName: this.projectName, reason: e.message });
    }));
  }

  async stop(): Promise<void> {
    console.log(`[Conductor] Stopping project "${this.projectName}"...`);
    this.abortController?.abort('User stopped project');
    this.abortController = null;
    if (this.cliSpawner) { this.cliSpawner.killAll(); }
    if (this.uiTester) { await this.uiTester.killDevServer().catch(() => {}); }
    if (this.stateInterval) { clearInterval(this.stateInterval); this.stateInterval = null; }
    if (this.pauseTimeout) { clearTimeout(this.pauseTimeout); this.pauseTimeout = null; }
    this.status = 'failed';
    await this.saveState();
    // Emit final report even on stop
    if (this.router) {
      const report = this.router.generateReport();
      this.emit('progress_report', report);
    }
    this.emit('conductor_stopped', { projectName: this.projectName });
  }

  async pause(): Promise<void> {
    console.log(`[Conductor] Pausing project "${this.projectName}"...`);
    this.status = 'paused';
    await this.saveState();
    this.emit('conductor_paused', { projectName: this.projectName });
    this.pausedAt = Date.now();
    this.pauseTimeout = setTimeout(() => {
      console.log(`[Conductor] Auto-resuming after 30min timeout...`);
      this.resume().catch(e => console.error('[Conductor] Auto-resume failed:', e));
    }, 30 * 60 * 1000);
  }

  async resume(): Promise<void> {
    console.log(`[Conductor] Resuming project "${this.projectName}"...`);
    if (this.pauseTimeout) { clearTimeout(this.pauseTimeout); this.pauseTimeout = null; }
    this.pausedAt = 0;
    this.status = 'idle';
    if (this.checkpoint && this.checkpoint.tasks && this.checkpoint.tasks.length > 0) {
      this.taskQueue = this.checkpoint.tasks.map(ct => ({
        id: ct.id, description: ct.description, dependencies: [],
        files_impacted: [...ct.files_created, ...ct.files_modified],
        estimated_complexity: 'medium',
        status: ct.status === 'completed' ? 'completed' : 'pending',
        retries: ct.retry_count || 0,
        reviewer_notes: ct.reviewer_notes || '', auditor_notes: ct.auditor_notes || ''
      }));
      this.loopCount = this.checkpoint.loop_count || 0;
      if (this.checkpoint.current_task_id) {
        this.currentTaskId = this.checkpoint.current_task_id;
        const current = this.taskQueue.find(t => t.id === this.currentTaskId);
        if (current && current.status === 'pending') { current.status = 'failed'; this.currentTaskId = null; }
      }
      console.log(`[Conductor] Restored ${this.taskQueue.length} tasks from checkpoint, loop ${this.loopCount}`);
    }
    if (this.router) this.router.setTaskQueue(this.taskQueue);
    await this.saveState();
    this.emit('conductor_resumed', { projectName: this.projectName });
    await this.dispatch();
  }

  async getState() {
    return {
      session_id: this.sessionId, project: this.projectName, status: this.status,
      current_task_id: this.currentTaskId, current_agent_role: this.currentAgentRole,
      loop_count: this.loopCount, task_queue: this.taskQueue,
      active_agents: this.currentAgentRole ? [this.currentAgentRole] : [],
    };
  }

  async getGitLog(): Promise<CommitEntry[]> { return await this.git.getLog(this.sessionId); }
  async getGitDiff(fromHash: string, toHash: string): Promise<string> { return await this.git.getDiff(fromHash, toHash); }
  async getGitBranches(): Promise<string[]> { return await this.git.getBranches(); }
  getRouter(): StageRouter | null { return this.router; }

  // ===================== MAIN DISPATCHER =====================

  private async dispatch(): Promise<void> {
    if (!this.router) { this.emit('error', { message: 'StageRouter not initialized' }); return; }
    this.router.setTaskQueue(this.taskQueue);

    // First, check if we need to plan
    if (!this.taskQueue.length) {
      this.status = 'planning';
      await this.handlePlanning(this.cachedIntent);
      return;
    }

    // Ask the router what to do next
    const decision = this.router.decideProjectCompletion();

    this.emit('log', { role: 'system', message: `[ROUTER] Stage decision: ${decision.action} → ${decision.nextStage} (${decision.reason.substring(0, 100)})` });

    switch (decision.action) {
      case 'complete':
        await this.finalizeProject(decision.reason);
        return;

      case 're_plan':
        this.emit('log', { role: 'system', message: `[ROUTER] Re-planning triggered: ${decision.reason}` });
        this.status = 'planning';
        // Keep completed tasks, remove pending/failed ones
        const failedIds = this.taskQueue.filter(t => t.status !== 'completed').map(t => t.id);
        this.emit('log', { role: 'system', message: `[ROUTER] Removing ${failedIds.length} non-completed tasks, keeping ${this.taskQueue.filter(t => t.status === 'completed').length} completed` });
        await this.handlePlanning(this.cachedIntent, true);
        return;

      case 'fail_task':
        this.emit('log', { role: 'system', message: `[ROUTER] Project failed: ${decision.reason}` });
        this.status = 'failed';
        await this.finalizeProject(decision.reason);
        return;

      case 'proceed':
        // Check intent satisfaction even when proceeding
        const intentCheck = this.router.checkIntentSatisfaction();
        if (!intentCheck.satisfied && this.loopCount > 5) {
          this.emit('log', { role: 'system', message: `[ROUTER] ⚠ Intent only ${intentCheck.confidence}% satisfied after ${this.loopCount} loops — consider if project is done` });
        }
        await this.startNextTask();
        return;

      default:
        await this.startNextTask();
    }
  }

  // ===================== STAGE 1: Planning (Architect) =====================

  private async handlePlanning(intent: string, isReplan: boolean = false): Promise<void> {
    const verb = isReplan ? 'Re-planning' : 'Planning';
    console.log(`[Conductor] ${verb} with Architect...`);
    this.currentAgentRole = 'architect';
    this.emit('agent_spawned', { role: 'architect' });
    try { db.saveAgentRun({ session_id: this.sessionId, project_name: this.projectName, role: 'architect', cli: this.modelConfig.architect.cli || 'opencode', model: this.modelConfig.architect.model, status: 'started' }); } catch (e: any) {}
    this.emit('log', { role: 'architect', message: `[MODEL] Architect ${verb.toLowerCase()} phase started` });

    const workspaceMap = this.getWorkspaceMap();
    const memoryContext = this.memory.getRelevantLessons(intent);
    const existingCompleted = this.taskQueue.filter(t => t.status === 'completed').length;
    const existingFailed = this.taskQueue.filter(t => t.status === 'failed').length;

    // For re-plans, add context about what's done and what failed
    let replanContext = '';
    if (isReplan) {
      const completedTasks = this.taskQueue.filter(t => t.status === 'completed').map(t => t.description).join('\n');
      const failedTasks = this.taskQueue.filter(t => t.status === 'failed').map(t => `- ${t.id}: ${t.description}`).join('\n');
      const problems = this.router?.getProblems().filter(p => !p.resolved).map(p => `- ${p.stage}: ${p.issue}`).join('\n') || '';
      replanContext = `\n\nRE-PLAN CONTEXT:\nAlready completed (${existingCompleted} tasks):\n${completedTasks}\n\nFailed tasks (${existingFailed}):\n${failedTasks}\n\nUnresolved problems:\n${problems}\n\nCreate a NEW plan for the REMAINING work only. Consider what was learned from failures.\n`;
    }

    const prompt = this.promptBuilder.buildArchitectPrompt(intent + replanContext, memoryContext, workspaceMap);
    const cfg = this.modelConfig.architect;
    const provider = (cfg.provider === 'opencode' ? 'OPENCODE' : cfg.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    this.emit('log', { role: 'architect', message: `[MODEL] Calling ${provider}/${cfg.model} for plan decomposition...` });
    const sysPrompt = isReplan
      ? 'You are a senior architect. Generate a revised plan for the REMAINING work. Keep completed tasks. Replace failed tasks with better alternatives. Return JSON with id, description, dependencies, files_impacted.'
      : 'You are a senior architect. Decompose user intent into a precise task plan. Return a JSON array of task objects with "id", "description", "dependencies", "files_impacted". No explanation.';

    try {
      const startTime = Date.now();
      const response = await this.callModelWithFallback('architect', prompt, sysPrompt);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.emit('log', { role: 'architect', message: `[MODEL] Architect response received in ${elapsed}s (${response.length} chars)` });

      const newTasks = this.parsePlan(response);
      if (!newTasks || newTasks.length === 0) throw new Error('Plan could not be parsed from model response');

      if (isReplan) {
        // Merge: keep completed tasks, add new ones from the replan
        const completedTasks = this.taskQueue.filter(t => t.status === 'completed');
        const newOnly = newTasks.filter(nt => !completedTasks.some(ct => ct.id === nt.id));
        this.taskQueue = [...completedTasks, ...newOnly];
        this.emit('log', { role: 'system', message: `[ROUTER] Re-plan: kept ${completedTasks.length} completed + added ${newOnly.length} new tasks` });
      } else {
        this.taskQueue = newTasks;
      }

      fs.writeFileSync(path.join(this.triadDir, 'task_queue.json'), JSON.stringify(this.taskQueue, null, 2));
      try { await this.git.commit(`[${this.sessionId}] [architect] plan ${isReplan ? 're' : ''}created — ${this.taskQueue.length} tasks`); } catch (e) {}
      this.emit('plan_ready', { tasks: this.taskQueue, projectName: this.projectName, isReplan });
      this.emit('log', { role: 'architect', message: `[SYSTEM] Plan ${isReplan ? 're' : ''}created: ${this.taskQueue.length} tasks queued` });
      await this.saveState();
      this.currentAgentRole = null;

      if (this.router) {
        this.router.setTaskQueue(this.taskQueue);
        this.router.recordVisit('architect');
      }
      await this.startNextTask();
    } catch (e: any) {
      console.error('[Conductor] Planning failed:', e.message);
      this.emit('log', { role: 'architect', message: `[ERROR] Planning failed: ${e.message}` });
      this.emit('error', { message: `Planning failed: ${e.message}` });
      fs.writeFileSync(path.join(this.triadDir, 'state.json'), JSON.stringify({ error: 'planning_failed', message: e.message }));
      this.status = 'failed';
      if (this.stateInterval) { clearInterval(this.stateInterval); this.stateInterval = null; }
      await this.saveState();
      this.currentAgentRole = null;
      this.emit('pipeline_failed', { projectName: this.projectName, reason: e.message });
    }
  }

  // ===================== STAGE 2: Builder =====================

  private async handleExecution(decision?: StageDecision): Promise<void> {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) { console.error('[Conductor] No current task for execution.'); await this.startNextTask(); return; }

    const isTargeted = decision?.action === 'targeted_fix';
    const mode = isTargeted ? 'targeted fix' : 'full build';
    console.log(`[Conductor] Building task ${currentTask.id} (${mode})...`);
    this.emit('agent_spawned', { role: 'builder', taskId: currentTask.id });
    try { db.saveAgentRun({ session_id: this.sessionId, project_name: this.projectName, role: 'builder', cli: this.modelConfig.builder.cli || 'opencode', model: this.modelConfig.builder.model, task_id: currentTask.id, status: 'started' }); } catch (e: any) {}
    this.emit('log', { role: 'builder', message: `[SYSTEM] Executing task ${currentTask.id} (${mode}): ${currentTask.description.substring(0, 80)}` });
    this.currentAgentRole = 'builder';
    const workspaceMap = this.getWorkspaceMap();

    // Choose full or targeted prompt
    const builderPrompt = isTargeted
      ? this.promptBuilder.buildTargetedFixPrompt({
          id: currentTask.id, description: currentTask.description, status: 'in_progress', retry_count: currentTask.retries,
          files_impacted: currentTask.files_impacted || [], dependencies: currentTask.dependencies,
          auditor_notes: currentTask.auditor_notes, reviewer_notes: currentTask.reviewer_notes
        }, decision?.targetedIssue || '', currentTask.reviewer_notes || '', currentTask.auditor_notes || '')
      : this.promptBuilder.buildBuilderPrompt({
          id: currentTask.id, description: currentTask.description, status: 'in_progress', retry_count: currentTask.retries,
          files_impacted: currentTask.files_impacted || [], dependencies: currentTask.dependencies,
          auditor_notes: currentTask.auditor_notes, reviewer_notes: currentTask.reviewer_notes
        }, workspaceMap, currentTask.reviewer_notes || '', currentTask.auditor_notes || '');

    if (isTargeted) {
      this.emit('log', { role: 'builder', message: `[ROUTER] Targeted fix mode — minimal context (${builderPrompt.length} chars vs full ${this.promptBuilder.buildBuilderPrompt.length} chars)` });
    }

    const taskCurrentPath = path.join(this.triadDir, 'task_current.md');
    fs.writeFileSync(taskCurrentPath, `# Task ${currentTask.id}: ${currentTask.description}\n\nFiles: ${(currentTask.files_impacted || []).join(', ')}\nReviewer: ${currentTask.reviewer_notes || 'none'}\nAuditor: ${currentTask.auditor_notes || 'none'}\n\n${builderPrompt}`);

    // Try CLI first
    if (this.cliSpawner) {
      this.emit('log', { role: 'builder', message: `[CLI] Attempting CLI builder (opencode, ${mode}) for task ${currentTask.id}` });
      try {
        const cliResult = await this.cliSpawner.spawnOpenCode('builder', builderPrompt, this.modelConfig.builder);
        const elapsedSec = (cliResult.durationMs / 1000).toFixed(1);
        if (cliResult.success) {
          this.emit('log', { role: 'builder', message: `[CLI] Builder completed in ${elapsedSec}s` });
          const doneSignal = path.join(this.triadDir, 'done.signal');
          if (!fs.existsSync(doneSignal) && cliResult.exitCode === 0) {
            fs.writeFileSync(doneSignal, `completed by CLI builder (${elapsedSec}s)`);
          }
          currentTask.status = 'awaiting_review';
          this.emit('log', { role: 'builder', message: `[SYSTEM] Task ${currentTask.id} complete via CLI in ${elapsedSec}s` });
          try { await this.git.commit(`[${this.sessionId}] [builder] ${currentTask.id}: complete (CLI)`); } catch (e) {}
          await this.saveState();
          this.status = 'reviewing';
          this.currentAgentRole = null;
          if (this.router) {
            const d = this.router.decideAfterBuilder({ success: true, taskId: currentTask.id, retries: currentTask.retries, maxRetries: MAX_RETRIES });
            this.emit('log', { role: 'system', message: `[ROUTER] ${d.action} → ${d.nextStage}: ${d.reason}` });
          }
          await this.handleReview();
          return;
        }
      } catch (e: any) { this.emit('log', { role: 'builder', message: `[WARN] CLI spawn error: ${e.message} — falling back to direct API` }); }
    }

    this.emit('log', { role: 'builder', message: `[SYSTEM] Using direct API builder (fallback, ${mode})` });
    await this.executeBuilderAPI(currentTask, builderPrompt, isTargeted);
  }

  private async executeBuilderAPI(currentTask: TaskQueueEntry, builderPrompt: string, isTargeted: boolean): Promise<void> {
    const cfg = this.modelConfig.builder;
    const provider = (cfg.provider === 'opencode' ? 'OPENCODE' : cfg.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    const maxAttempts = isTargeted ? 3 : 10;
    this.emit('log', { role: 'builder', message: `[MODEL] Builder API: ${provider}/${cfg.model} (${isTargeted ? 'targeted' : 'full'}, max ${maxAttempts} attempts)` });
    try {
      let taskDone = false;
      let attemptCount = 0;
      while (!taskDone && attemptCount < maxAttempts) {
        attemptCount++;
        this.emit('log', { role: 'builder', message: `[MODEL] Builder attempt ${attemptCount}/${maxAttempts}...` });
        const response = await this.callModelWithFallback('builder', builderPrompt, isTargeted
          ? 'Fix ONLY the specific issue described. Do NOT redo the entire task. Return tool call JSON or {"action":"done"}.'
          : 'You are a builder. Execute the task using tools. Return JSON: {"action":"write_file|run_command|read_file",...} or {"action":"done"} when complete.');
        const toolCall = this.extractToolCall(response);
        if (!toolCall) continue;
        if (toolCall.action === 'done') {
          taskDone = true;
          currentTask.status = 'awaiting_review';
          if (toolCall.path && !currentTask.files_impacted?.includes(toolCall.path)) (currentTask.files_impacted = currentTask.files_impacted || []).push(toolCall.path);
          this.emit('log', { role: 'builder', message: `[SYSTEM] Task ${currentTask.id} complete: ${toolCall.summary || 'done'}` });
          break;
        }
        try {
          const result = await this.tools.execute(toolCall as ToolCall);
          builderPrompt += `\n\nTool result (${toolCall.action}):\n${result}\n\nContinue or {"action":"done"}.`;
          if (toolCall.action === 'write_file') this.workspaceMapCache = null;
        } catch (e: any) {
          builderPrompt += `\n\nTool FAILED: ${e.message}\n\nDo NOT retry same action. Try different approach or {"action":"done"} if done.`;
        }
      }
      if (!taskDone) {
        currentTask.status = 'failed';
        currentTask.retries++;
        this.emit('log', { role: 'builder', message: `[ERROR] Task ${currentTask.id} failed after ${maxAttempts} attempts` });
      }
      try { await this.git.commit(`[${this.sessionId}] [builder] ${currentTask.id}: ${taskDone ? 'complete' : 'failed'}`); } catch (e) {}
      await this.saveState();
      if (taskDone) {
        this.status = 'reviewing';
        this.currentAgentRole = null;
        if (this.router) {
          const d = this.router.decideAfterBuilder({ success: true, taskId: currentTask.id, retries: currentTask.retries, maxRetries: MAX_RETRIES });
          this.emit('log', { role: 'system', message: `[ROUTER] ${d.action} → ${d.nextStage}` });
        }
        await this.handleReview();
      } else if (this.router) {
        const d = this.router.decideAfterBuilder({ success: false, taskId: currentTask.id, retries: currentTask.retries, maxRetries: MAX_RETRIES, error: `Builder exhausted after ${maxAttempts} attempts` });
        this.emit('log', { role: 'system', message: `[ROUTER] ${d.action} → ${d.nextStage}: ${d.reason}` });
        if (d.action === 're_plan') {
          this.status = 'planning';
          this.currentAgentRole = null;
          await this.handlePlanning(this.cachedIntent, true);
        } else {
          this.currentAgentRole = null;
          await this.startNextTask();
        }
      } else {
        this.currentAgentRole = null;
        await this.startNextTask();
      }
    } catch (e: any) {
      console.error(`[Conductor] Builder API error: ${e.message}`);
      currentTask.status = 'failed'; currentTask.retries++;
      await this.saveState(); this.currentAgentRole = null;
      await this.startNextTask();
    }
  }

  // ===================== STAGE 3: Review =====================

  private async handleReview(): Promise<void> {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) { await this.startNextTask(); return; }
    console.log(`[Conductor] Reviewing task ${currentTask.id}...`);
    this.currentAgentRole = 'reviewer';
    this.emit('agent_spawned', { role: 'reviewer', taskId: currentTask.id });
    try { db.saveAgentRun({ session_id: this.sessionId, project_name: this.projectName, role: 'reviewer', cli: this.modelConfig.reviewer.cli || 'opencode', model: this.modelConfig.reviewer.model, task_id: currentTask.id, status: 'started' }); } catch (e: any) {}
    this.emit('log', { role: 'reviewer', message: `[SYSTEM] Reviewing task ${currentTask.id}` });
    const changedFiles = currentTask.files_impacted || [];
    const prompt = this.promptBuilder.buildReviewerPrompt({
      id: currentTask.id, description: currentTask.description, status: 'awaiting_review', retry_count: currentTask.retries,
      files_impacted: changedFiles, dependencies: currentTask.dependencies,
      auditor_notes: currentTask.auditor_notes, reviewer_notes: currentTask.reviewer_notes || ''
    }, changedFiles, this.cachedIntent);
    const cfg = this.modelConfig.reviewer;
    const provider = (cfg.provider === 'opencode' ? 'OPENCODE' : cfg.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    try {
      const response = await this.callModelWithFallback('reviewer', prompt, 'Review code ONLY for bugs, security issues, and regressions. Do NOT check task completion or UI behavior. First line: PASS or FAIL.');
      const verdict = this.parseReviewVerdict(response);
      currentTask.reviewer_notes = response;
      const hasUI = taskHasUIFiles(currentTask);

      if (!this.router) {
        // Fallback to old routing if router not available
        if (verdict === 'PASS') {
          currentTask.status = hasUI ? 'awaiting_ui_test' : 'awaiting_audit';
          this.status = hasUI ? 'ui_testing' : 'auditing';
          await this.saveState(); this.currentAgentRole = null;
          hasUI ? await this.handleUITesting() : await this.handleAudit();
          return;
        }
        currentTask.retries++;
        if (currentTask.retries >= MAX_RETRIES) {
          currentTask.status = 'failed';
          await this.saveState(); this.currentAgentRole = null;
          await this.startNextTask(); return;
        }
        this.status = 'executing'; await this.saveState(); this.currentAgentRole = null;
        await this.handleExecution(); return;
      }

      // Smart routing via StageRouter
      const decision = this.router.decideAfterReview({
        verdict, taskId: currentTask.id, retries: currentTask.retries, maxRetries: MAX_RETRIES,
        hasUI, reviewNotes: response,
      });

      this.emit('log', { role: 'system', message: `[ROUTER] Review decision: ${decision.action} → ${decision.nextStage} (${decision.reason.substring(0, 100)})` });

      if (decision.action === 're_plan') {
        currentTask.status = 'failed';
        await this.saveState(); this.currentAgentRole = null;
        await this.handlePlanning(this.cachedIntent, true); return;
      }

      if (decision.action === 'fail_task') {
        currentTask.status = 'failed';
        await this.saveState(); this.currentAgentRole = null;
        await this.startNextTask(); return;
      }

      // Proceed or targeted_fix or full_retry
      if (decision.nextStage === 'reviewer') {
        this.status = 'reviewing';
        await this.saveState(); this.currentAgentRole = null;
        // Self-retry with backoff
        await new Promise(r => setTimeout(r, (decision.retryDelayMs || 5000)));
        await this.handleReview(); return;
      }

      if (decision.nextStage === 'builder') {
        currentTask.retries++;
        this.status = 'executing';
        await this.saveState(); this.currentAgentRole = null;
        await this.handleExecution(decision); return;
      }

      if (decision.nextStage === 'ui_tester') {
        currentTask.status = 'awaiting_ui_test';
        this.status = 'ui_testing';
        await this.saveState(); this.currentAgentRole = null;
        await this.handleUITesting(); return;
      }

      // auditor
      currentTask.status = 'awaiting_audit';
      this.status = 'auditing';
      await this.saveState(); this.currentAgentRole = null;
      await this.handleAudit();
    } catch (e: any) {
      console.error(`[Conductor] Review API error: ${e.message}`);
      currentTask.retries++;
      if (currentTask.retries >= MAX_RETRIES) {
        currentTask.status = 'failed';
        await this.saveState(); this.currentAgentRole = null;
        await this.startNextTask(); return;
      }
      await new Promise(r => setTimeout(r, 5000 * currentTask.retries));
      this.status = 'reviewing'; await this.saveState(); this.currentAgentRole = null;
      await this.handleReview();
    }
  }

  // ===================== STAGE 4: UI Testing =====================

  private async handleUITesting(): Promise<void> {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) { await this.startNextTask(); return; }
    console.log(`[Conductor] UI Testing task ${currentTask.id}...`);
    this.currentAgentRole = 'ui_tester';
    this.emit('agent_spawned', { role: 'ui_tester', taskId: currentTask.id });
    try { db.saveAgentRun({ session_id: this.sessionId, project_name: this.projectName, role: 'ui_tester', cli: 'playwright', model: 'chromium', task_id: currentTask.id, status: 'started' }); } catch (e: any) {}

    const specPath = path.join(this.triadDir, 'ui_test_spec.md');
    let specContent = '';
    if (!fs.existsSync(specPath)) {
      this.emit('log', { role: 'ui_tester', message: `[MODEL] Generating UI test spec for task ${currentTask.id}...` });
      const htmlFiles = this.getWorkspaceMap().filter(f => /\.(html|jsx|tsx|vue|svelte)$/.test(f));
      const testPrompt = this.promptBuilder.buildUITestSpecPrompt(currentTask, htmlFiles, this.cachedIntent);
      try {
        const specResponse = await this.callModelWithFallback('ui_tester', testPrompt, 'Output ONLY the JSON test specification. No explanation.');
        specContent = specResponse;
        fs.writeFileSync(specPath, specContent);
        this.emit('log', { role: 'ui_tester', message: `[SYSTEM] Test spec generated` });
      } catch (e: any) {
        this.emit('log', { role: 'ui_tester', message: `[ERROR] Failed to generate test spec — skipping UI tests` });
        currentTask.status = 'awaiting_audit'; currentTask.ui_test_report = 'No UI test spec generated.';
        this.status = 'auditing'; await this.saveState(); this.currentAgentRole = null;
        await this.handleAudit(); return;
      }
    } else {
      specContent = fs.readFileSync(specPath, 'utf-8');
    }

    if (!this.uiTester) {
      currentTask.status = 'awaiting_audit';
      this.status = 'auditing'; await this.saveState(); this.currentAgentRole = null;
      await this.handleAudit(); return;
    }

    const spec = this.uiTester.parseTestSpec(specContent);
    if (!spec || !spec.tests?.length) {
      specContent = `{"url": "index.html", "viewport": {"width":1280,"height":720}, "tests": [{"action":"screenshot","fullPage":true,"description":"Default full page screenshot"}]}`;
    }

    const finalSpec = this.uiTester.parseTestSpec(specContent) || { url: 'index.html', tests: [] };
    this.emit('log', { role: 'ui_tester', message: `[SYSTEM] Running ${finalSpec.tests.length} UI tests...` });

    let result: UITestResult;
    try {
      result = await this.uiTester.runTests(finalSpec);
    } catch (e: any) {
      currentTask.status = 'awaiting_audit'; currentTask.ui_test_report = `UI test error: ${e.message}`;
      this.status = 'auditing'; await this.saveState(); this.currentAgentRole = null;
      await this.handleAudit(); return;
    }

    const report = this.uiTester.generateTestReport(result);
    const reportPath = path.join(this.triadDir, 'ui_test_report.md');
    fs.writeFileSync(reportPath, report);
    currentTask.ui_test_report = report;

    this.emit('log', { role: 'ui_tester', message: `[AUDIT] UI Tests: ${result.passed ? 'PASS' : 'FAIL'} — ${result.passedSteps}/${result.totalSteps} passed` });
    this.emit('ui_test_result', { projectName: this.projectName, taskId: currentTask.id, passed: result.passed, passedSteps: result.passedSteps, totalSteps: result.totalSteps, failedSteps: result.failedSteps, durationMs: result.durationMs, screenshotsDir: result.screenshotsDir, videoPath: result.videoPath });

    try {
      db.saveAgentRun({ session_id: this.sessionId, project_name: this.projectName, role: 'ui_tester', cli: 'playwright', model: 'chromium', task_id: currentTask.id, status: result.passed ? 'completed' : 'failed', output_file: path.join(this.triadDir, 'ui_test_report.md') });
    } catch (e: any) {}

    // Router decision
    if (this.router) {
      const d = this.router.decideAfterUITest({ passed: result.passed, taskId: currentTask.id, failedSteps: result.failedSteps, error: result.errorSteps > 0 ? `${result.errorSteps} errors` : undefined });
      this.emit('log', { role: 'system', message: `[ROUTER] UI test decision: ${d.action} → ${d.nextStage}` });
    }

    currentTask.status = 'awaiting_audit';
    this.status = 'auditing';
    try { await this.git.commit(`[${this.sessionId}] [ui_tester] ${currentTask.id}: ${result.passed ? 'PASS' : 'FAIL'}`); } catch (e) {}
    await this.saveState(); this.currentAgentRole = null;
    await this.handleAudit();
  }

  // ===================== STAGE 5: Audit =====================

  private async handleAudit(): Promise<void> {
    const currentTask = this.taskQueue.find(t => t.id === this.currentTaskId);
    if (!currentTask) { await this.startNextTask(); return; }
    console.log(`[Conductor] Auditing task ${currentTask.id}...`);
    this.currentAgentRole = 'auditor';
    this.emit('agent_spawned', { role: 'auditor', taskId: currentTask.id });
    try { db.saveAgentRun({ session_id: this.sessionId, project_name: this.projectName, role: 'auditor', cli: this.modelConfig.auditor.cli || 'opencode', model: this.modelConfig.auditor.model, task_id: currentTask.id, status: 'started' }); } catch (e: any) {}
    const uiReport = currentTask.ui_test_report || '';
    const changedFiles = currentTask.files_impacted || [];
    const prompt = this.promptBuilder.buildAuditorPrompt({
      id: currentTask.id, description: currentTask.description, status: 'awaiting_audit', retry_count: currentTask.retries,
      files_impacted: changedFiles, dependencies: currentTask.dependencies,
      auditor_notes: currentTask.auditor_notes || '', reviewer_notes: currentTask.reviewer_notes || ''
    }, currentTask.reviewer_notes || '', uiReport, changedFiles);
    const cfg = this.modelConfig.auditor;
    const provider = (cfg.provider === 'opencode' ? 'OPENCODE' : cfg.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    try {
      const response = await this.callModelWithFallback('auditor', prompt, 'Verify the task is fully and correctly completed. Cross-check reviewer and UI test feedback. First line must be PASS or FAIL. Include a Lesson section if passing.');
      const verdict = this.parseReviewVerdict(response);
      currentTask.auditor_notes = response;

      if (!this.router) {
        // Fallback routing
        if (verdict === 'PASS') {
          currentTask.status = 'completed';
          const lesson = this.extractLesson(response);
          if (lesson) { this.memory.addLesson(this.projectName, currentTask.description, lesson); }
          try { await this.git.commit(`[${this.sessionId}] [auditor] ${currentTask.id}: PASS`); } catch (e) {}
          await this.saveState(); this.loopCount++; this.currentAgentRole = null;
          await this.dispatch(); return;
        }
        currentTask.retries++;
        if (currentTask.retries >= MAX_RETRIES) {
          currentTask.status = 'failed';
          await this.saveState(); this.currentAgentRole = null;
          await this.dispatch(); return;
        }
        this.status = 'executing'; await this.saveState(); this.currentAgentRole = null;
        await this.handleExecution(); return;
      }

      // Smart routing
      const decision = this.router.decideAfterAudit({
        verdict, taskId: currentTask.id, retries: currentTask.retries, maxRetries: MAX_RETRIES,
        reviewNotes: currentTask.reviewer_notes, auditNotes: response, hasUI: !!uiReport,
      });

      this.emit('log', { role: 'system', message: `[ROUTER] Audit decision: ${decision.action} → ${decision.nextStage} (${decision.reason.substring(0, 100)})` });

      if (decision.action === 'complete') {
        currentTask.status = 'completed';
        const lesson = this.extractLesson(response);
        if (lesson) { this.memory.addLesson(this.projectName, currentTask.description, lesson); }
        try { await this.git.commit(`[${this.sessionId}] [auditor] ${currentTask.id}: PASS`); } catch (e) {}
        await this.saveState(); this.loopCount++; this.currentAgentRole = null;

        // Run ECC verification loop after each task completion
        await this.runECCVerification();

        // Run ECC pre-commit security checks
        const changedFiles = currentTask.files_impacted || [];
        if (this.security) {
          const secChecks = await this.security.runPreCommitChecks(changedFiles);
          const secFailed = secChecks.filter(c => !c.passed);
          for (const c of secChecks) {
            this.emit('log', { role: 'security', message: `[SEC] [${c.passed ? '✓' : '✗'}] ${c.name}: ${c.detail}` });
          }
          if (secFailed.length > 0) {
            this.emit('log', { role: 'security', message: `[SEC] ${secFailed.length} security issues found — fix before next tasks` });
          }
        }

        await this.dispatch(); return;
      }

      if (decision.action === 're_plan') {
        currentTask.status = 'failed';
        await this.saveState(); this.currentAgentRole = null;
        await this.handlePlanning(this.cachedIntent, true); return;
      }

      if (decision.action === 'fail_task') {
        currentTask.status = 'failed';
        await this.saveState(); this.currentAgentRole = null;
        await this.dispatch(); return;
      }

      // builder retry (targeted or full)
      currentTask.retries++;
      this.status = 'executing'; await this.saveState(); this.currentAgentRole = null;
      const retryDecision = decision.action === 'targeted_fix' ? decision : undefined;
      await this.handleExecution(retryDecision);
    } catch (e: any) {
      console.error(`[Conductor] Audit API error: ${e.message}`);
      currentTask.retries++;
      if (currentTask.retries >= MAX_RETRIES) {
        currentTask.status = 'failed';
        await this.saveState(); this.currentAgentRole = null;
        await this.dispatch(); return;
      }
      await new Promise(r => setTimeout(r, 5000 * currentTask.retries));
      this.status = 'auditing'; await this.saveState(); this.currentAgentRole = null;
      await this.handleAudit();
    }
  }

  // ===================== TERMINAL: Finalize =====================

  private async finalizeProject(reason: string): Promise<void> {
    console.log(`[Conductor] Finalizing: ${reason}`);
    this.status = reason.includes('fail') ? 'failed' : 'completed';

    if (this.router) {
      const report = this.router.generateReport();
      fs.writeFileSync(path.join(this.triadDir, 'progress_report.md'), report.summary);
      this.emit('progress_report', report);
      this.emit('log', { role: 'system', message: `[ROUTER] Final report generated: ${report.completedTasks}/${report.totalTasks} tasks, ${report.problemsResolved}/${report.problemsEncountered.length} problems resolved, ${report.totalRetries} retries` });
      this.emit('log', { role: 'system', message: `[ROUTER] Intent satisfaction: ${report.intentSatisfied ? 'YES' : 'NO'} (${report.completedTasks} tasks)` });
    }

    try { await this.git.commit(`[${this.sessionId}] [project] ${this.status === 'completed' ? 'COMPLETE' : 'FAILED'} — ${reason}`); } catch (e: any) {}
    await this.saveState();

    this.emit('project_complete', {
      projectName: this.projectName,
      taskCount: this.taskQueue.length,
      completedCount: this.taskQueue.filter(t => t.status === 'completed').length,
      failedCount: this.taskQueue.filter(t => t.status === 'failed').length,
      loopCount: this.loopCount,
      intentSatisfied: this.router?.checkIntentSatisfaction().satisfied || false,
      failed: this.status === 'failed',
    });
  }

  // ===================== STAGE 6: ECC Verification Loop =====================

  private async runECCVerification(): Promise<void> {
    if (!this.verifier) return;
    this.emit('log', { role: 'verifier', message: `[VERIFY] Running ECC verification loop...` });

    try {
      const result = await this.verifier.runAll(true); // ignoreFailures=true — report but don't block
      this.emit('log', { role: 'verifier', message: `[VERIFY] Verification complete: ${result.summary.split('\n')[0]}` });
      for (const gate of result.gates) {
        if (!gate.passed) {
          this.emit('log', { role: 'verifier', message: `[VERIFY] ✗ ${gate.name}: ${gate.recommendation || gate.error?.slice(0, 100)}` });
        } else {
          this.emit('log', { role: 'verifier', message: `[VERIFY] ✓ ${gate.name} passed` });
        }
      }
    } catch (e: any) {
      this.emit('log', { role: 'verifier', message: `[VERIFY] Verification crashed: ${e.message}` });
    }
  }

  // ========== Task queue & dispatch ==========

  private async startNextTask(): Promise<void> {
    if (this.status === 'paused') return;
    const nextTask = this.taskQueue.find(t => (t.status === 'pending' || t.status === 'failed') && t.retries < MAX_RETRIES);
    if (!nextTask) {
      await this.dispatch();
      return;
    }
    this.currentTaskId = nextTask.id;
    this.status = 'executing';
    this.emit('log', { role: 'system', message: `Starting task ${nextTask.id}: ${nextTask.description.substring(0, 80)}` });
    await this.saveState();
    await this.handleExecution();
  }

  // ========== Utilities (unchanged from previous) ==========

  private extractToolCall(response: string): any {
    try { const r = JSON.parse(response.trim()); if (r.action) return r; } catch (e) {}
    const m = response.match(/\{[^{}]*"action"[^{}]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    return null;
  }

  private parsePlan(content: string): TaskQueueEntry[] | null {
    const tasks: TaskQueueEntry[] = [];
    const taskRegex = /### Task (\d+)\s*\*\*ID:\*\*\s*(\S+)\s*\*\*Description:\*\*\s*(.+?)\s*\*\*Dependencies:\*\*\s*(.+?)\s*\*\*Files to create or modify:\*\*\s*(.+?)(?=###|$)/gs;
    let match;
    while ((match = taskRegex.exec(content)) !== null) {
      const deps = match[4].trim();
      tasks.push({ id: match[2].trim(), description: match[3].trim(), dependencies: deps === 'none' || deps === 'N/A' ? [] : deps.split(',').map((d: string) => d.trim()), files_impacted: match[5].split(',').map((f: string) => f.trim()), estimated_complexity: 'medium', status: 'pending', retries: 0, reviewer_notes: '', auditor_notes: '' });
    }
    if (tasks.length === 0) {
      const lines = content.split('\n').map(l => l.trim()).filter(l => l.startsWith('-') || l.startsWith('*') || /^\d+[\.\)]/.test(l));
      if (lines.length > 0) {
        lines.forEach((line, i) => {
          const desc = line.replace(/^[-*\d]+[\.\)]?\s*/, '').trim();
          if (desc) tasks.push({ id: `t${i + 1}`, description: desc, dependencies: [], files_impacted: [], estimated_complexity: 'medium', status: 'pending', retries: 0, reviewer_notes: '', auditor_notes: '' });
        });
      }
    }
    if (tasks.length === 0) {
      try { const jsonArray = JSON.parse(content); if (Array.isArray(jsonArray)) { jsonArray.forEach((item: any, i: number) => { const desc = typeof item === 'string' ? item : item.description || item.task || ''; if (desc) tasks.push({ id: `t${i + 1}`, description: desc, dependencies: [], files_impacted: [], estimated_complexity: 'medium', status: 'pending', retries: 0, reviewer_notes: '', auditor_notes: '' }); }); } } catch (e) {}
    }
    return tasks.length > 0 ? tasks : null;
  }

  private parseReviewVerdict(content: string): 'PASS' | 'FAIL' {
    const firstLine = content.trim().split('\n')[0].toUpperCase().trim();
    if (/^PASS\b/.test(firstLine)) return 'PASS';
    if (/^FAIL\b/.test(firstLine)) return 'FAIL';
    if (/^#+\s*PASS\b/.test(firstLine)) return 'PASS';
    if (/^#+\s*FAIL\b/.test(firstLine)) return 'FAIL';
    const verdictMatch = content.match(/\*\*Verdict:\*\*\s*(PASS|FAIL)/i);
    if (verdictMatch) return verdictMatch[1].toUpperCase() as 'PASS' | 'FAIL';
    const verdictMatch2 = content.match(/Verdict:\s*(PASS|FAIL)/i);
    if (verdictMatch2) return verdictMatch2[1].toUpperCase() as 'PASS' | 'FAIL';
    return 'FAIL';
  }

  private extractLesson(content: string): string {
    const lessonMatch = content.match(/## Lesson\s*\n([\s\S]+?)(?=##|$)/);
    if (lessonMatch) return lessonMatch[1].trim();
    const lineMatch = content.match(/\*\*Lesson\*\*\s*(.+)/i);
    if (lineMatch) return lineMatch[1].trim();
    return '';
  }

  private buildIntentFile(intent: string): string { return `# Project Intent\n\n${intent}\n\n## Constraints\n- Only modify files within the workspace directory\n- Write all outputs to .triad/ files as instructed\n- Do not ask for clarification — make the best decision and proceed\n`; }
  private async ensureRepo(): Promise<void> { const gitDir = path.join(this.workspacePath, '.git'); if (!fs.existsSync(gitDir)) await this.git.init(); }

  private getWorkspaceMap(): string[] {
    const now = Date.now();
    if (this.workspaceMapCache && (now - this.workspaceMapCacheTime) < 10000) return this.workspaceMapCache;
    this.workspaceMapCache = this.walkDir(this.workspacePath);
    this.workspaceMapCacheTime = now;
    return this.workspaceMapCache;
  }

  private async callModelWithFallback(role: string, prompt: string, sysPrompt: string): Promise<string> {
    const cfg = (this.modelConfig as any)[role] || (this.modelConfig as any).architect;
    const primaryProvider = (cfg?.provider === 'opencode' ? 'OPENCODE' : cfg?.provider === 'openrouter' ? 'OPENROUTER' : 'DEEPSEEK') as any;
    const primaryModel = cfg?.model || 'deepseek-v4-flash-free';
    const fallback = cfg?.fallback;
    try {
      const result = await callModel(primaryProvider, primaryModel, prompt, sysPrompt, undefined, this.abortController?.signal);
      return result;
    } catch (e: any) {
      if (e.name === 'AbortError' || e.name === 'CanceledError') throw e;
      if (fallback?.model) {
        const fbProvider = (fallback.provider || fallback.cli || 'openrouter').toUpperCase();
        try { return await callModel(fbProvider as any, fallback.model, prompt, sysPrompt, undefined, this.abortController?.signal); } catch (fbErr: any) {
          if (fbErr.name === 'AbortError' || fbErr.name === 'CanceledError') throw fbErr;
          throw new Error(`Both primary and fallback failed.`);
        }
      }
      throw e;
    }
  }

  private walkDir(dir: string, fileList: string[] = [], baseDir?: string): string[] {
    const relativeBase = baseDir || dir;
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const name = path.join(dir, file);
      if (fs.statSync(name).isDirectory()) {
        if (!file.startsWith('.') && file !== 'node_modules' && file !== '.git') this.walkDir(name, fileList, relativeBase);
      } else { fileList.push(path.relative(relativeBase, name)); }
    });
    return fileList;
  }

  private initCheckpoint(intent: string): void {
    if (fs.existsSync(this.checkpointPath)) {
      try { this.checkpoint = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf-8')); if (this.checkpoint?.status === 'completed') this.checkpoint = null; } catch (e) { this.checkpoint = null; }
    }
    if (!this.checkpoint) {
      this.checkpoint = { session_id: this.sessionId, project_name: this.projectName, status: 'planning', intent_hash: crypto.createHash('sha256').update(intent || '').digest('hex'), last_checkpoint_at: new Date().toISOString(), last_completed_phase: '', current_task_id: '', tasks: [], file_manifest: { created: [], modified: [], deleted: [] }, model_config_snapshot: {}, loop_count: 0, interruption_reason: null };
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
    this.checkpoint.tasks = this.taskQueue.map(t => ({ id: t.id, description: t.description, status: t.status, completed_at: t.status === 'completed' ? new Date().toISOString() : null, retry_count: t.retries, files_created: t.files_impacted || [], files_modified: [], files_deleted: [], reviewer_notes: t.reviewer_notes || null, auditor_notes: t.auditor_notes || null }));
    try { fs.writeFileSync(this.checkpointPath, JSON.stringify(this.checkpoint, null, 2)); } catch (e) {}
  }

  private async saveState(): Promise<void> {
    const state = { session_id: this.sessionId, project: this.projectName, status: this.status, current_task_id: this.currentTaskId, current_agent_role: this.currentAgentRole, loop_count: this.loopCount, task_queue: this.taskQueue, active_agents: this.currentAgentRole ? [this.currentAgentRole] : [], last_commit: '', started_at: new Date().toISOString() };
    fs.writeFileSync(path.join(this.triadDir, 'state.json'), JSON.stringify(state, null, 2));
    this.emit('state_update', state);
    this.saveCheckpoint();
    try {
      db.upsertProject(this.projectName, this.cachedIntent || (fs.existsSync(path.join(this.triadDir, 'intent.md')) ? fs.readFileSync(path.join(this.triadDir, 'intent.md'), 'utf-8') : ''), this.status, 50, this.loopCount, JSON.stringify(this.modelConfig));
      const completed = this.taskQueue.filter(t => t.status === 'completed').length;
      db.upsertSession({ id: this.sessionId, project_name: this.projectName, git_branch: `session/${this.sessionId}`, status: this.status === 'completed' ? 'completed' : this.status === 'failed' ? 'failed' : 'active', task_count: this.taskQueue.length, completed_count: completed, retry_count: this.taskQueue.reduce((s, t) => s + t.retries, 0) });
    } catch (e: any) { console.error(`[Conductor] DB save failed (non-fatal): ${e.message}`); }
  }

  getSessionId(): string { return this.sessionId; }
  getStatus(): ConductorStatus { return this.status; }
}
