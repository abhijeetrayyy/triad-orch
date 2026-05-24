import { AgentRole, ConductorStatus, TaskQueueEntry } from './types';

export interface StageDecision {
  nextStage: AgentRole;
  action: 'proceed' | 'targeted_fix' | 'full_retry' | 're_plan' | 'skip' | 'complete' | 'fail_task' | 'pause';
  reason: string;
  retryDelayMs?: number;
  targetedIssue?: string;  // what specifically to fix, for minimal-context retries
}

export interface ProblemLog {
  taskId: string;
  stage: AgentRole;
  issue: string;
  timestamp: string;
  resolved: boolean;
  resolution?: string;
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
  problemsEncountered: ProblemLog[];
  problemsResolved: number;
  stagesVisited: Record<string, number>;
  intentSatisfied: boolean;
  summary: string;
}

export class StageRouter {
  private problems: ProblemLog[] = [];
  private stageVisitCounts: Record<string, number> = {};
  private totalRetries: number = 0;
  private sessionId: string;
  private projectName: string;
  private startedAt: string;
  private intent: string;
  private taskQueue: TaskQueueEntry[];

  constructor(sessionId: string, projectName: string, startedAt: string, intent: string) {
    this.sessionId = sessionId;
    this.projectName = projectName;
    this.startedAt = startedAt;
    this.intent = intent;
    this.taskQueue = [];
  }

  setTaskQueue(queue: TaskQueueEntry[]) {
    this.taskQueue = queue;
  }

  recordVisit(stage: AgentRole): void {
    const key = stage as string;
    this.stageVisitCounts[key] = (this.stageVisitCounts[key] || 0) + 1;
  }

  logProblem(taskId: string, stage: AgentRole, issue: string): void {
    this.problems.push({
      taskId, stage, issue,
      timestamp: new Date().toISOString(),
      resolved: false,
    });
  }

  resolveProblem(taskId: string, resolution: string): void {
    const problem = this.problems.find(p => p.taskId === taskId && !p.resolved);
    if (problem) {
      problem.resolved = true;
      problem.resolution = resolution;
    }
  }

  incrementRetries(): void {
    this.totalRetries++;
  }

  /**
   * Decide where to go after the builder stage completes.
   */
  decideAfterBuilder(result: {
    success: boolean;
    taskId: string;
    retries: number;
    error?: string;
    maxRetries: number;
  }): StageDecision {
    this.recordVisit('builder');

    if (result.success) {
      return { nextStage: 'reviewer', action: 'proceed', reason: `Task ${result.taskId} built successfully` };
    }

    // Builder failure — retry or fail
    if (result.retries < result.maxRetries) {
      this.incrementRetries();
      this.logProblem(result.taskId, 'builder', result.error || 'Builder failed');
      return {
        nextStage: 'builder',
        action: 'targeted_fix',
        reason: `Builder failed (retry ${result.retries}/${result.maxRetries}): ${result.error || 'unknown error'}`,
        targetedIssue: result.error || 'Builder execution failed',
      };
    }

    // Max retries exhausted — fail the task
    this.logProblem(result.taskId, 'builder', `Builder permanently failed after ${result.maxRetries} retries`);
    return checkForReplan(this, result.taskId, result.maxRetries);
  }

  /**
   * Decide after review — route to UI test, re-execute, or fail.
   */
  decideAfterReview(result: {
    verdict: 'PASS' | 'FAIL';
    taskId: string;
    retries: number;
    maxRetries: number;
    hasUI: boolean;
    error?: string;
    reviewNotes?: string;
  }): StageDecision {
    this.recordVisit('reviewer');

    if (result.verdict === 'PASS') {
      if (result.hasUI) {
        return { nextStage: 'ui_tester', action: 'proceed', reason: `Review passed — proceeding to UI testing for task ${result.taskId}` };
      }
      return { nextStage: 'auditor', action: 'proceed', reason: `Review passed — proceeding to audit for task ${result.taskId}` };
    }

    // Review failed
    if (result.retries < result.maxRetries) {
      this.incrementRetries();
      this.logProblem(result.taskId, 'reviewer', result.reviewNotes || 'Review failed');

      // Check: is this a targeted fix situation (< 50 chars of notes)?
      const isSmallFix = (result.reviewNotes || '').length < 200;
      const hasSmallRetries = result.retries <= 1;
      if (isSmallFix && hasSmallRetries) {
        return {
          nextStage: 'builder', action: 'targeted_fix',
          reason: `Review found small issues — targeted fix for task ${result.taskId}`,
          targetedIssue: result.reviewNotes || 'Address review feedback',
        };
      }

      return {
        nextStage: 'builder', action: 'full_retry',
        reason: `Review failed (retry ${result.retries}/${result.maxRetries}) — full re-execution for task ${result.taskId}`,
      };
    }

    this.logProblem(result.taskId, 'reviewer', `Review permanently failed after ${result.maxRetries} retries`);
    return checkForReplan(this, result.taskId, result.maxRetries);
  }

  /**
   * Decide after UI testing — always proceeds to audit, but logs issues.
   */
  decideAfterUITest(result: {
    passed: boolean;
    taskId: string;
    failedSteps: number;
    error?: string;
  }): StageDecision {
    this.recordVisit('ui_tester');

    if (!result.passed) {
      this.logProblem(result.taskId, 'ui_tester',
        `UI tests failed — ${result.failedSteps} steps failed. ${result.error || ''}`);
    }

    // UI tests always advance to audit (never cause retries — that's the auditor's job to evaluate)
    return {
      nextStage: 'auditor',
      action: 'proceed',
      reason: result.passed
        ? `UI tests passed (${result.failedSteps} failures reported to auditor)`
        : `UI tests had ${result.failedSteps} failures — auditor will evaluate`,
    };
  }

  /**
   * Decide after audit — final checkpoint before completing or retrying.
   */
  decideAfterAudit(result: {
    verdict: 'PASS' | 'FAIL';
    taskId: string;
    retries: number;
    maxRetries: number;
    reviewNotes?: string;
    auditNotes?: string;
    hasUI: boolean;
  }): StageDecision {
    this.recordVisit('auditor');

    if (result.verdict === 'PASS') {
      this.resolveProblem(result.taskId, 'Audit passed — task complete');
      return { nextStage: 'auditor', action: 'complete', reason: `Task ${result.taskId} fully verified and complete` };
    }

    if (result.retries < result.maxRetries) {
      this.incrementRetries();
      this.logProblem(result.taskId, 'auditor', result.auditNotes || 'Audit failed');

      // Smart routing: if reviewer passed but audit failed, the issue is likely completeness, not code quality
      // Try a targeted fix first
      if (result.reviewNotes && result.reviewNotes.toUpperCase().includes('PASS')) {
        return {
          nextStage: 'builder', action: 'targeted_fix',
          reason: `Audit failed after review pass — targeted completeness fix for task ${result.taskId}`,
          targetedIssue: result.auditNotes || 'Complete the remaining work',
        };
      }

      return {
        nextStage: 'builder', action: 'full_retry',
        reason: `Audit failed (retry ${result.retries}/${result.maxRetries}) — full re-execution for task ${result.taskId}`,
      };
    }

    this.logProblem(result.taskId, 'auditor', `Audit permanently failed after ${result.maxRetries} retries`);
    return checkForReplan(this, result.taskId, result.maxRetries);
  }

  /**
   * Decide when a task is permanently failed — should we re-plan or abandon?
   */
  decideFailedTask(taskId: string): StageDecision {
    const completedCount = this.taskQueue.filter(t => t.status === 'completed').length;
    const totalCount = this.taskQueue.length;
    const failedCount = this.taskQueue.filter(t => t.status === 'failed' && t.retries >= 3).length;

    // If more than half the tasks failed, the plan is wrong — re-plan
    if (failedCount > totalCount / 2 && completedCount < totalCount / 3) {
      return {
        nextStage: 'architect', action: 're_plan',
        reason: `${failedCount}/${totalCount} tasks failed — plan may be wrong. Re-planning remaining work.`,
      };
    }

    return {
      nextStage: 'architect', action: 'fail_task',
      reason: `Task ${taskId} permanently failed after max retries`,
    };
  }

  /**
   * Check if the original intent has been satisfied by completed tasks.
   * This is a heuristic — it checks if completed tasks collectively cover the intent keywords.
   */
  checkIntentSatisfaction(): { satisfied: boolean; confidence: number; reasoning: string } {
    const completed = this.taskQueue.filter(t => t.status === 'completed');
    if (completed.length === 0) {
      return { satisfied: false, confidence: 0, reasoning: 'No tasks completed yet' };
    }

    const intentLower = this.intent.toLowerCase();
    const intentWords = intentLower.split(/\s+/).filter(w => w.length > 3);
    const completedDescriptions = completed.map(t => t.description.toLowerCase()).join(' ');
    const completedFiles = completed.flatMap(t => t.files_impacted || []).join(' ').toLowerCase();

    let matched = 0;
    const unmatched: string[] = [];
    for (const word of intentWords) {
      if (completedDescriptions.includes(word) || completedFiles.includes(word)) {
        matched++;
      } else {
        unmatched.push(word);
      }
    }

    const ratio = intentWords.length > 0 ? matched / intentWords.length : 0;
    const satisfied = ratio >= 0.6;
    const confidence = Math.round(ratio * 100);

    return {
      satisfied,
      confidence,
      reasoning: unmatched.length > 0
        ? `Matched ${matched}/${intentWords.length} intent keywords. Missing: ${unmatched.slice(0, 5).join(', ')}`
        : `All ${intentWords.length} intent keywords covered by completed tasks`,
    };
  }

  /**
   * Decide whether the entire project is done or needs more work.
   */
  decideProjectCompletion(): StageDecision {
    const completed = this.taskQueue.filter(t => t.status === 'completed').length;
    const total = this.taskQueue.length;
    const pending = this.taskQueue.filter(
      t => (t.status === 'pending' || t.status === 'failed') && t.retries < 3
    ).length;

    const intentCheck = this.checkIntentSatisfaction();

    // All tasks complete AND intent satisfied
    if (completed === total && intentCheck.satisfied) {
      return {
        nextStage: 'auditor', action: 'complete',
        reason: `All ${total} tasks complete. Intent satisfied (${intentCheck.confidence}% confidence).`,
      };
    }

    // All tasks complete but intent NOT satisfied — may need additional tasks
    if (completed === total && !intentCheck.satisfied) {
      return {
        nextStage: 'architect', action: 're_plan',
        reason: `All ${total} tasks complete but intent may not be satisfied (${intentCheck.confidence}%). Missing: ${intentCheck.reasoning}. Consider adding tasks.`,
      };
    }

    // Some tasks completed, some permanently failed, nothing runnable
    if (pending === 0 && completed > 0) {
      const failed = total - completed;
      if (intentCheck.satisfied) {
        return {
          nextStage: 'auditor', action: 'complete',
          reason: `${completed}/${total} tasks completed, ${failed} failed. Intent appears satisfied (${intentCheck.confidence}%). Project complete with failures.`,
        };
      }
      return {
        nextStage: 'architect', action: 're_plan',
        reason: `${failed} tasks failed permanently, ${completed} completed. Intent not fully satisfied — re-planning required.`,
      };
    }

    // Nothing runnable, nothing completed — fail
    if (pending === 0 && completed === 0) {
      return {
        nextStage: 'architect', action: 'fail_task',
        reason: `No tasks could be completed. Project failed.`,
      };
    }

    return {
      nextStage: 'builder', action: 'proceed',
      reason: `${pending} tasks remaining, ${completed}/${total} completed`,
    };
  }

  /**
   * Generate a comprehensive progress report.
   */
  generateReport(): ProgressReport {
    const completed = this.taskQueue.filter(t => t.status === 'completed').length;
    const failed = this.taskQueue.filter(t => t.status === 'failed').length;
    const skipped = this.taskQueue.length - completed - failed;
    const resolved = this.problems.filter(p => p.resolved).length;
    const intentCheck = this.checkIntentSatisfaction();

    return {
      sessionId: this.sessionId,
      projectName: this.projectName,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      totalTasks: this.taskQueue.length,
      completedTasks: completed,
      failedTasks: failed,
      skippedTasks: skipped,
      totalRetries: this.totalRetries,
      totalLoopCount: completed,
      problemsEncountered: this.problems,
      problemsResolved: resolved,
      stagesVisited: { ...this.stageVisitCounts },
      intentSatisfied: intentCheck.satisfied,
      summary: [
        `${this.projectName}: ${completed}/${this.taskQueue.length} tasks completed`,
        `${resolved}/${this.problems.length} problems resolved`,
        `${this.totalRetries} total retries`,
        `Stages visited: ${JSON.stringify(this.stageVisitCounts)}`,
        `Intent satisfied: ${intentCheck.satisfied ? 'YES' : 'NO'} (${intentCheck.confidence}%)`,
        '',
        '## Problem Log',
        ...this.problems.map(p =>
          `- [${p.resolved ? '✓' : '✗'}] ${p.taskId} @ ${p.stage}: ${p.issue}${p.resolution ? ' → ' + p.resolution : ''}`
        ),
      ].join('\n'),
    };
  }

  getProblems(): ProblemLog[] { return [...this.problems]; }
  getStageCounts(): Record<string, number> { return { ...this.stageVisitCounts }; }
}

function checkForReplan(router: StageRouter, taskId: string, maxRetries: number): StageDecision {
  return router.decideFailedTask(taskId);
}
