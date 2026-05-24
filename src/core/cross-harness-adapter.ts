import { spawn, execSync } from 'child_process';
import { AgentRole, CLIType, ModelConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';

export type HarnessType = 'opencode' | 'claude-code' | 'codex' | 'gemini' | 'cursor' | 'all';

export interface HarnessConfig {
  type: HarnessType;
  binary: string;
  args: string[];
  env: Record<string, string>;
  readySignal?: string;
  modelFlag: string;
}

export interface CrossHarnessResult {
  harness: HarnessType;
  success: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  model: string;
}

const HARNESS_CONFIGS: Record<HarnessType, HarnessConfig> = {
  opencode: {
    type: 'opencode',
    binary: 'opencode',
    args: ['run', '--format', 'json', '--thinking', '--dangerously-skip-permissions'],
    env: { NO_COLOR: '1', FORCE_COLOR: '0' },
    readySignal: 'ready',
    modelFlag: '--model',
  },
  'claude-code': {
    type: 'claude-code',
    binary: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose'],
    env: { NO_COLOR: '1' },
    modelFlag: '--model',
  },
  codex: {
    type: 'codex',
    binary: 'codex',
    args: ['exec', '-p', 'yolo'],
    env: {},
    modelFlag: '-m',
  },
  gemini: {
    type: 'gemini',
    binary: 'gemini',
    args: ['--yolo'],
    env: {},
    modelFlag: '--model',
  },
  cursor: {
    type: 'cursor',
    binary: 'cursor',
    args: ['--cli'],
    env: {},
    modelFlag: '--model',
  },
  all: {
    type: 'all',
    binary: '',
    args: [],
    env: {},
    modelFlag: '',
  },
};

const ECC_SKILL_PREFIX = `\n\n## ECC Skills Active\nYou have access to these specialized workflows:\n- **search-first**: Research before building. Check for existing solutions.\n- **tdd-workflow**: Write tests before code. Target 80%+ coverage.\n- **verification-loop**: Build → typecheck → lint → test → coverage gates.\n- **frontend-design-direction**: Purpose/audience/tone/memorable-detail framework.\n- **cost-aware-pipeline**: Route simple tasks to cheaper models, complex to expensive.\n- **security-review**: No hardcoded secrets, validate inputs, parameterized queries.\n\nFollow these ECC principles:\n1. Agent-First — use specialized sub-agents for domain tasks\n2. Test-Driven — write tests before implementation\n3. Security-First — validate all inputs, never hardcode secrets\n4. Immutability — create new objects, never mutate\n5. Plan Before Execute — plan complex features before coding\n`;

export class CrossHarnessAdapter {
  private workspacePath: string;
  private triadDir: string;
  private broadcastFn: ((event: string, data: any) => void) | null = null;
  private activeProcesses: Map<string, any> = new Map();
  private availableHarnesses: HarnessType[] = [];

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.triadDir = path.join(workspacePath, '.triad');
    this.detectAvailableHarnesses();
  }

  setBroadcast(fn: (event: string, data: any) => void) {
    this.broadcastFn = fn;
  }

  private log(message: string) {
    if (this.broadcastFn) this.broadcastFn('log', { role: 'harness', message });
    console.log(`[HarnessAdapter] ${message}`);
  }

  /**
   * Detect which CLI harnesses are installed on the system.
   */
  detectAvailableHarnesses(): HarnessType[] {
    const checks: [HarnessType, string][] = [
      ['opencode', 'opencode --version'],
      ['claude-code', 'claude --version'],
      ['codex', 'codex --version'],
      ['gemini', 'gemini --version'],
      ['cursor', 'cursor --version'],
    ];

    this.availableHarnesses = [];
    for (const [type, cmd] of checks) {
      try {
        execSync(cmd, { stdio: 'pipe', timeout: 5000 });
        this.availableHarnesses.push(type);
      } catch (e) {
        // not installed — skip
      }
    }

    // Always include opencode as fallback
    if (!this.availableHarnesses.includes('opencode')) {
      this.availableHarnesses.unshift('opencode');
    }

    this.log(`Detected harnesses: ${this.availableHarnesses.join(', ')}`);
    return this.availableHarnesses;
  }

  getAvailableHarnesses(): HarnessType[] {
    return [...this.availableHarnesses];
  }

  /**
   * Run a task on the best available harness.
   * Priority: opencode > claude-code > codex > gemini
   */
  async runOnBestHarness(
    role: AgentRole,
    prompt: string,
    modelConfig: ModelConfig,
    preferredHarness?: HarnessType
  ): Promise<CrossHarnessResult> {
    // Try preferred harness first, then fall through available ones
    const attemptOrder = preferredHarness
      ? [preferredHarness, ...this.availableHarnesses.filter(h => h !== preferredHarness)]
      : this.availableHarnesses;

    let lastError: string = '';
    for (const harness of attemptOrder) {
      try {
        const result = await this.spawnHarness(harness, role, prompt, modelConfig);
        if (result.success) return result;
        lastError = result.error || `exit code ${result.exitCode}`;
        this.log(`Harness ${harness} failed: ${lastError} — trying next...`);
      } catch (e: any) {
        lastError = e.message;
        this.log(`Harness ${harness} crashed: ${e.message} — trying next...`);
      }
    }

    return {
      harness: 'all',
      success: false,
      output: '',
      exitCode: null,
      durationMs: 0,
      error: `All harnesses failed. Last error: ${lastError}`,
      model: modelConfig.model,
    };
  }

  /**
   * Spawn a specific harness with the given prompt.
   */
  async spawnHarness(
    harness: HarnessType,
    role: AgentRole,
    prompt: string,
    modelConfig: ModelConfig
  ): Promise<CrossHarnessResult> {
    const config = HARNESS_CONFIGS[harness];
    if (!config || harness === 'all') {
      return {
        harness, success: false, output: '', exitCode: null, durationMs: 0,
        error: `Unsupported harness: ${harness}`, model: modelConfig.model,
      };
    }

    // Write prompt to file
    const promptFile = path.join(this.triadDir, `${role}_prompt.md`);
    const eccPrompt = prompt + ECC_SKILL_PREFIX;
    fs.writeFileSync(promptFile, eccPrompt, 'utf-8');

    const modelId = modelConfig.provider === harness
      ? `${harness}/${modelConfig.model}`
      : modelConfig.model;

    const sessionId = `triad-${role}-${harness}`;
    const startTime = Date.now();

    // Build args based on harness
    let cmd = config.binary;
    let args: string[];

    switch (harness) {
      case 'claude-code':
        args = [...config.args, '--model', modelId, '--session', sessionId,
          `Read "${promptFile}" and execute. Do NOT ask questions. When done, output DONE.`];
        break;
      case 'codex':
        args = [...config.args, config.modelFlag, modelConfig.model,
          `Read "${promptFile}" and execute. Do NOT ask questions. When done, output DONE.`];
        break;
      case 'gemini':
        args = [...config.args, config.modelFlag, modelId,
          `Read "${promptFile}" and execute. Do NOT ask questions. When done, output DONE.`];
        break;
      case 'opencode':
      default:
        args = [...config.args, '--session', sessionId, config.modelFlag,
          harness === 'opencode' ? `opencode/${modelConfig.model}` : modelId,
          `Read "${promptFile}" and execute. Do NOT ask questions. When done, output DONE.`];
    }

    const sessionKey = `${harness}-${role}`;
    this.log(`Spawning ${harness}: ${cmd} ${args.slice(0, 6).join(' ')}...`);

    return new Promise((resolve) => {
      let resolved = false;
      let output = '';
      const timeoutMs = 120000;

      const finish = (result: CrossHarnessResult) => {
        if (resolved) return;
        resolved = true;
        this.activeProcesses.delete(sessionKey);
        resolve(result);
      };

      let childProcess: any;
      try {
        childProcess = spawn(cmd, args, {
          cwd: this.workspacePath,
          env: { ...process.env, ...config.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        });
      } catch (e: any) {
        finish({ harness, success: false, output: '', exitCode: null, durationMs: Date.now() - startTime, error: `Spawn failed: ${e.message}`, model: modelConfig.model });
        return;
      }

      this.activeProcesses.set(sessionKey, childProcess);

      const timer = setTimeout(() => {
        try { childProcess.kill('SIGTERM'); } catch (e) {}
        finish({ harness, success: false, output, exitCode: null, durationMs: Date.now() - startTime, error: `Timed out after ${timeoutMs / 1000}s`, model: modelConfig.model });
      }, timeoutMs);

      childProcess.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        const lines = data.toString().split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          if (line.includes('DONE')) {
            clearTimeout(timer);
            finish({ harness, success: true, output, exitCode: 0, durationMs: Date.now() - startTime, model: modelConfig.model });
            return;
          }
        }
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        output += `[stderr] ${data.toString()}`;
      });

      childProcess.on('close', (exitCode: number | null) => {
        clearTimeout(timer);
        if (!resolved) {
          const success = exitCode === 0 || output.includes('DONE');
          finish({ harness, success, exitCode: exitCode ?? null, output, durationMs: Date.now() - startTime, model: modelConfig.model });
        }
      });

      childProcess.on('error', (err: Error) => {
        clearTimeout(timer);
        finish({ harness, success: false, output, exitCode: null, durationMs: Date.now() - startTime, error: err.message, model: modelConfig.model });
      });
    });
  }

  killAll() {
    this.activeProcesses.forEach((proc, key) => {
      try { proc.kill('SIGTERM'); } catch (e) {}
      try { execSync(`taskkill /F /T /PID ${proc.pid} 2>nul`, { stdio: 'ignore' }); } catch (e) {}
    });
    this.activeProcesses.clear();
  }

  isRunning(): boolean {
    return this.activeProcesses.size > 0;
  }
}

/**
 * ECC-compatible MCP server configurations.
 * These are the canonical MCP servers from ECC's .mcp.json.
 */
export const ECC_MCP_CONFIGS = {
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'] },
  context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@2.1.4'] },
  exa: { type: 'http', url: 'https://mcp.exa.ai/mcp' },
  memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@2026.1.26'] },
  playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.69', '--extension'] },
  sequentialThinking: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2025.12.18'] },
};
