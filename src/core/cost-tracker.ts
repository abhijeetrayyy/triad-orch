export interface CostRecord {
  model: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
  harness: string;
}

export interface BudgetStatus {
  totalCost: number;
  budgetLimit: number;
  remaining: number;
  percentUsed: number;
  records: CostRecord[];
  perRole: Record<string, number>;
  perHarness: Record<string, number>;
}

// Approximate token costs per 1K tokens (input/output)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash-free': { input: 0, output: 0 },
  'deepseek/deepseek-chat:free': { input: 0, output: 0 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5': { input: 0.001, output: 0.005 },
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
};

const DEFAULT_COST = { input: 0.0001, output: 0.0005 };

export class CostTracker {
  private records: CostRecord[] = [];
  private budgetLimit: number;
  private broadcastFn: ((event: string, data: any) => void) | null = null;

  constructor(budgetLimitUsd: number = 0.50) {
    this.budgetLimit = budgetLimitUsd;
  }

  setBroadcast(fn: (event: string, data: any) => void) {
    this.broadcastFn = fn;
  }

  track(model: string, role: string, inputTokens: number, outputTokens: number, harness: string = 'opencode'): void {
    const costs = MODEL_COSTS[model] || DEFAULT_COST;
    const costUsd = (inputTokens / 1000) * costs.input + (outputTokens / 1000) * costs.output;

    this.records.push({
      model,
      role,
      inputTokens,
      outputTokens,
      costUsd,
      timestamp: new Date().toISOString(),
      harness,
    });

    const status = this.getStatus();
    if (this.broadcastFn) {
      this.broadcastFn('cost_update', {
        cost: costUsd,
        total: status.totalCost,
        percentUsed: status.percentUsed,
      });
    }

    // Warn at 80% budget
    if (status.percentUsed >= 80 && status.percentUsed < 90) {
      if (this.broadcastFn) this.broadcastFn('log', { role: 'cost', message: `[BUDGET] ⚠ ${status.percentUsed.toFixed(0)}% of $${this.budgetLimit} budget used ($${status.totalCost.toFixed(4)})` });
    }

    // Alarm at 90%+
    if (status.percentUsed >= 90) {
      if (this.broadcastFn) this.broadcastFn('log', { role: 'cost', message: `[BUDGET] 🔴 CRITICAL: ${status.percentUsed.toFixed(0)}% of budget exhausted! Remaining: $${status.remaining.toFixed(4)}` });
    }
  }

  getStatus(): BudgetStatus {
    const totalCost = this.records.reduce((s, r) => s + r.costUsd, 0);
    const perRole: Record<string, number> = {};
    const perHarness: Record<string, number> = {};
    for (const r of this.records) {
      perRole[r.role] = (perRole[r.role] || 0) + r.costUsd;
      perHarness[r.harness] = (perHarness[r.harness] || 0) + r.costUsd;
    }

    return {
      totalCost: Math.round(totalCost * 10000) / 10000,
      budgetLimit: this.budgetLimit,
      remaining: Math.round((this.budgetLimit - totalCost) * 10000) / 10000,
      percentUsed: Math.round((totalCost / this.budgetLimit) * 100),
      records: [...this.records],
      perRole,
      perHarness,
    };
  }

  /**
   * ECC-style model routing: simple tasks get cheaper models.
   */
  selectModel(complexity: 'low' | 'medium' | 'high', preferredModel: string): string {
    const status = this.getStatus();

    // If budget is tight, downgrade aggressively
    if (status.percentUsed > 80 && complexity === 'low') {
      return 'deepseek-v4-flash-free'; // free model
    }
    if (status.percentUsed > 90) {
      return 'deepseek-v4-flash-free'; // force free above 90%
    }

    return preferredModel;
  }

  reset() {
    this.records = [];
  }

  getRecords(): CostRecord[] {
    return [...this.records];
  }
}
