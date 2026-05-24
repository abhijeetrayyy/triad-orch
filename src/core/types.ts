export type TaskStatus = 'pending' | 'in_progress' | 'failed' | 'completed' | 'awaiting_audit' | 'awaiting_review' | 'superseded';

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  retry_count: number;
  auditor_notes?: string;
  reviewer_notes?: string;
  files_impacted?: string[];
  dependencies?: string[];
  estimated_complexity?: 'low' | 'medium' | 'high';
}

export interface Ledger {
  global_intent: string;
  status: 'idle' | 'planning' | 'executing' | 'reviewing' | 'ui_testing' | 'auditing' | 'completed' | 'failed';
  loop_count: number;
  max_loops: number;
  task_queue: Task[];
  current_task_id?: string;
  model_config?: {
    architect?: { provider: string; name: string };
    architect_fallback?: { provider: string; name: string };
    builder?: { provider: string; name: string };
    reviewer?: { provider: string; name: string };
    auditor?: { provider: string; name: string };
  };
  system_prompts?: {
    architect?: string;
    builder?: string;
    reviewer?: string;
    auditor?: string;
  };
}

// v2 types
export type AgentRole = 'architect' | 'builder' | 'reviewer' | 'ui_tester' | 'auditor';
export type HarnessType = 'opencode' | 'claude-code' | 'codex' | 'gemini' | 'cursor';

export type CLIType = 'opencode' | 'gemini' | 'claude-code' | 'codex' | 'cursor';
export type ConductorStatus = 'idle' | 'planning' | 'executing' | 'reviewing' | 'ui_testing' | 'auditing' | 'completed' | 'failed' | 'paused';
export type TaskQueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'awaiting_review' | 'awaiting_ui_test' | 'awaiting_audit';

export interface ModelConfig {
  cli: CLIType;
  provider?: string;
  model: string;
  harness?: HarnessType;
  fallback?: {
    cli?: CLIType;
    provider?: string;
    model: string;
    harness?: HarnessType;
  };
}

export interface ProjectModelConfig {
  architect: ModelConfig;
  builder: ModelConfig;
  reviewer: ModelConfig;
  auditor: ModelConfig;
  ui_tester?: ModelConfig;
}

export interface ConductorState {
  session_id: string;
  project: string;
  status: ConductorStatus;
  current_task_id: string | null;
  loop_count: number;
  task_queue: TaskQueueEntry[];
  active_agents: AgentRole[];
  last_commit: string;
  started_at: string;
}

export interface TaskQueueEntry {
  id: string;
  description: string;
  dependencies: string[];
  files_impacted: string[];
  estimated_complexity: string;
  status: TaskQueueStatus;
  retries: number;
  reviewer_notes: string;
  auditor_notes: string;
  ui_test_report?: string;
}

export interface UITestResultSummary {
  passed: boolean;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  errorSteps: number;
  durationMs: number;
  brief: string;
}

export type TriadFileName = 'intent.md' | 'plan.md' | 'task_queue.json' | 'task_current.md' | 'memory_context.md' | 'model_config.json' | 'state.json' | 'done.signal' | 'review.md' | 'ui_test_spec.md' | 'ui_test_report.md' | 'audit.md' | 'fail_signal';

export const TRIAD_FILES: TriadFileName[] = [
  'intent.md', 'plan.md', 'task_queue.json', 'task_current.md',
  'memory_context.md', 'model_config.json', 'state.json',
  'done.signal', 'review.md', 'ui_test_spec.md', 'ui_test_report.md', 'audit.md', 'fail_signal'
];

export const EXPECTED_AGENT_OUTPUTS: Record<AgentRole, TriadFileName[]> = {
  architect: ['plan.md'],
  builder: ['done.signal', 'ui_test_spec.md'],
  reviewer: ['review.md'],
  ui_tester: ['ui_test_report.md'],
  auditor: ['audit.md']
};

export interface CheckpointTask {
  id: string;
  description: string;
  status: string;
  completed_at: string | null;
  retry_count: number;
  files_created: string[];
  files_modified: string[];
  files_deleted: string[];
  reviewer_notes?: string | null;
  auditor_notes?: string | null;
}

export interface Checkpoint {
  session_id: string;
  project_name: string;
  status: string;
  intent_hash: string;
  last_checkpoint_at: string;
  last_completed_phase: string;
  current_task_id: string;
  tasks: CheckpointTask[];
  file_manifest: {
    created: string[];
    modified: string[];
    deleted: string[];
  };
  model_config_snapshot: Record<string, { provider: string; name: string }>;
  loop_count: number;
  interruption_reason: string | null;
  interrupted_at?: string;
  interrupted_provider?: string;
  interrupted_model?: string;
}

export interface ProgressReport {
  sessionId: string;
  projectName: string;
  startedAt: string;
  completedAt?: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  totalRetries: number;
  totalLoopCount: number;
  problemsEncountered: ProblemLogEntry[];
  problemsResolved: number;
  stagesVisited: Record<string, number>;
  intentSatisfied: boolean;
  summary: string;
}

export interface ProblemLogEntry {
  taskId: string;
  stage: AgentRole;
  issue: string;
  timestamp: string;
  resolved: boolean;
  resolution?: string;
}

export interface StageDecision {
  nextStage: AgentRole;
  action: 'proceed' | 'targeted_fix' | 'full_retry' | 're_plan' | 'skip' | 'complete' | 'fail_task' | 'pause';
  reason: string;
  retryDelayMs?: number;
  targetedIssue?: string;
}

export const DEFAULT_MODEL_CONFIG: ProjectModelConfig = {
  architect: { cli: 'opencode', harness: 'opencode', provider: 'opencode', model: 'deepseek-v4-flash-free', fallback: { provider: 'openrouter', model: 'deepseek/deepseek-chat:free' } },
  builder: { cli: 'opencode', harness: 'opencode', provider: 'opencode', model: 'deepseek-v4-flash-free', fallback: { provider: 'openrouter', model: 'deepseek/deepseek-chat:free' } },
  reviewer: { cli: 'opencode', harness: 'opencode', provider: 'opencode', model: 'deepseek-v4-flash-free', fallback: { provider: 'openrouter', model: 'deepseek/deepseek-chat:free' } },
  auditor: { cli: 'opencode', harness: 'opencode', provider: 'opencode', model: 'deepseek-v4-flash-free', fallback: { provider: 'openrouter', model: 'deepseek/deepseek-chat:free' } },
  ui_tester: { cli: 'opencode', harness: 'opencode', provider: 'opencode', model: 'deepseek-v4-flash-free', fallback: { provider: 'openrouter', model: 'deepseek/deepseek-chat:free' } }
};
