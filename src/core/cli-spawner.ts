import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { AgentRole, CLIType, ModelConfig } from './types';

type BroadcastFn = (event: string, data: any) => void;

const OUTPUT_FILES: Record<AgentRole, string> = {
  architect: 'plan.md',
  builder: 'done.signal',
  reviewer: 'review.md',
  ui_tester: 'ui_test_report.md',
  auditor: 'audit.md'
};

export interface CLISpawnResult {
  success: boolean;
  output: string;
  exitCode: number | null;
  signalUsed: string | null;
  durationMs: number;
  error?: string;
}

export class CLISpawner {
  private workspacePath: string;
  private triadDir: string;
  private ptys: Map<string, pty.IPty> = new Map();
  private outputs: Map<string, string> = new Map();
  private lastActivity: Map<string, number> = new Map();
  private watchdogInterval: NodeJS.Timeout | null = null;
  private broadcast: BroadcastFn | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.triadDir = path.join(workspacePath, '.triad');
    if (process.platform === 'win32' && !process.env.CONPTY_USE_WINPTY) {
      process.env.CONPTY_USE_WINPTY = '1';
    }
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  private startWatchdog(key: string): void {
    if (this.watchdogInterval) return;
    this.watchdogInterval = setInterval(() => {
      const now = Date.now();
      this.ptys.forEach((_, k) => {
        const last = this.lastActivity.get(k) || now;
        if (now - last > 120000) {
          console.error(`[CLISpawner] Watchdog: ${k} stuck (no output for ${((now - last) / 1000).toFixed(0)}s)`);
          this.killByKey(k);
        }
      });
    }, 15000);
  }

  private stopWatchdog(): void {
    if (this.watchdogInterval) { clearInterval(this.watchdogInterval); this.watchdogInterval = null; }
  }

  private stripANSI(text: string): string {
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
  }

  private locateOpenCodeBinary(): { cmd: string; args: string[] } | null {
    const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
    const exePath = npmDir ? path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe') : '';
    const cmdPath = npmDir ? path.join(npmDir, 'opencode.cmd') : '';

    if (fs.existsSync(exePath)) return { cmd: exePath, args: [] };
    if (fs.existsSync(cmdPath)) return { cmd: 'cmd.exe', args: ['/c', cmdPath] };
    return null;
  }

  async spawnOpenCode(
    role: AgentRole,
    promptContent: string,
    modelConfig: ModelConfig
  ): Promise<CLISpawnResult> {
    if (!fs.existsSync(this.triadDir)) {
      fs.mkdirSync(this.triadDir, { recursive: true });
    }

    const binary = this.locateOpenCodeBinary();
    if (!binary) {
      return {
        success: false,
        output: '',
        exitCode: null,
        signalUsed: null,
        durationMs: 0,
        error: 'OpenCode CLI not found at %APPDATA%\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe'
      };
    }

    // Write full prompt to .triad/builder_prompt.md so opencode reads it as context
    const promptFile = path.join(this.triadDir, 'builder_prompt.md');
    fs.writeFileSync(promptFile, promptContent, 'utf-8');

    // Short message that tells opencode to read the full prompt from the file
    const shortMessage = `Read ".triad/builder_prompt.md" which contains your full task instructions. Execute it now.`;
    const modelId = modelConfig.provider === 'opencode'
      ? `opencode/${modelConfig.model}`
      : `${modelConfig.provider}/${modelConfig.model}`;

    const sessionId = `triad-${role}`;
    const key = `${role}-${Date.now()}`;
    const startTime = Date.now();

    // Build args: --format json for structured output, --thinking for reasoning, --model, --session
    const args = [
      ...binary.args,
      'run',
      '--format', 'json',
      '--thinking',
      '--session', sessionId,
      '--model', modelId,
      '--dangerously-skip-permissions',
      shortMessage
    ];

    this.emitLog(role, `[CLI] Spawning: opencode --session ${sessionId} --model ${modelId} --format json --thinking`);
    this.emitLog(role, `[CLI] Prompt file: ${promptFile} (${promptContent.length} chars)`);

    return new Promise<CLISpawnResult>((resolve) => {
      let resolved = false;
      const finish = (result: CLISpawnResult) => {
        if (resolved) return;
        resolved = true;
        this.ptys.delete(key);
        this.outputs.delete(key);
        this.lastActivity.delete(key);
        if (this.ptys.size === 0) this.stopWatchdog();
        resolve(result);
      };

      let ptyProcess: pty.IPty;
      try {
        ptyProcess = pty.spawn(binary.cmd, args, {
          name: 'xterm-color',
          cols: 160,
          rows: 40,
          cwd: this.workspacePath,
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } as { [key: string]: string }
        });
      } catch (e: any) {
        finish({
          success: false,
          output: '',
          exitCode: null,
          signalUsed: null,
          durationMs: Date.now() - startTime,
          error: `PTY spawn failed: ${e.message}`
        });
        return;
      }

      this.ptys.set(key, ptyProcess);
      this.outputs.set(key, '');
      this.lastActivity.set(key, Date.now());
      this.startWatchdog(key);

      ptyProcess.onData((data) => {
        this.lastActivity.set(key, Date.now());
        const clean = this.stripANSI(data);
        const current = this.outputs.get(key) || '';
        this.outputs.set(key, current + clean);

        // Parse JSON format output if possible, else show raw
        const lines = clean.split('\n').filter(l => l.trim());
        for (const line of lines) {
          // Try to parse as JSON event
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'thinking' && evt.content) {
              this.emitLog(role, `[CLI THINKING] ${evt.content.toString().substring(0, 250)}`);
            } else if (evt.type === 'assistant' && evt.content) {
              this.emitLog(role, `[CLI ASSISTANT] ${evt.content.toString().substring(0, 250)}`);
            } else if (evt.type === 'tool_call' && evt.name) {
              this.emitLog(role, `[CLI TOOL] ${evt.name} ${JSON.stringify(evt.input || {}).substring(0, 150)}`);
            } else if (evt.type === 'tool_result') {
              const preview = typeof evt.content === 'string' ? evt.content.substring(0, 200) : JSON.stringify(evt.content).substring(0, 200);
              this.emitLog(role, `[CLI RESULT] ${preview}`);
            } else if (evt.type === 'error' && evt.message) {
              this.emitLog(role, `[CLI ERROR] ${evt.message}`);
            }
            continue; // handled as JSON
          } catch {
            // Not JSON — just raw text
          }
          if (line.length > 2) {
            this.emitLog(role, line.substring(0, 300));
          }
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[CLISpawner] ${role} exited (code=${exitCode} signal=${signal}) after ${elapsed}s`);

        const capturedOutput = this.outputs.get(key) || '';
        const outputFile = OUTPUT_FILES[role];

        if (outputFile && capturedOutput.trim()) {
          try {
            fs.writeFileSync(path.join(this.triadDir, outputFile), capturedOutput.trim(), 'utf-8');
            this.emitLog(role, `[CLI] Wrote ${outputFile} (${capturedOutput.length} chars)`);
          } catch (e: any) {
            console.error(`[CLISpawner] Failed to write ${outputFile}: ${e.message}`);
          }
        } else if (outputFile === 'done.signal' && exitCode === 0) {
          try {
            fs.writeFileSync(path.join(this.triadDir, 'done.signal'), '');
            this.emitLog(role, '[CLI] Wrote empty done.signal');
          } catch (e: any) {}
        }

        finish({
          success: exitCode === 0,
          output: capturedOutput.trim(),
          exitCode: exitCode ?? null,
          signalUsed: signal ? String(signal) : null,
          durationMs: Date.now() - startTime
        });
      });
    });
  }

  private emitLog(role: string, message: string): void {
    if (this.broadcast) {
      const cleanMsg = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      this.broadcast('log', {
        role,
        message: `[CLI:${role}] ${cleanMsg}`,
        project: path.basename(this.workspacePath)
      });
    }
  }

  spawnByCLI(cli: CLIType, role: AgentRole, prompt: string, modelConfig?: ModelConfig): Promise<CLISpawnResult> {
    switch (cli) {
      case 'opencode':
      case 'claude-code':
        return this.spawnOpenCode(role, prompt, modelConfig || { cli: 'opencode', model: 'deepseek-v4-flash-free' });
      default:
        return Promise.resolve({
          success: false, output: '', exitCode: null, signalUsed: null, durationMs: 0,
          error: `Unsupported CLI type: ${cli}`
        });
    }
  }

  kill(role: AgentRole): void {
    this.ptys.forEach((p, key) => {
      if (key.startsWith(role)) {
        try { p.kill(); } catch (e) {}
        this.ptys.delete(key);
      }
    });
  }

  private killByKey(key: string): void {
    const p = this.ptys.get(key);
    if (p) {
      try { p.kill(); } catch (e) {}
      this.ptys.delete(key);
    }
  }

  killAll(): void {
    this.stopWatchdog();
    this.ptys.forEach((p) => {
      try { p.kill(); } catch (e) {}
    });
    this.ptys.clear();
    this.outputs.clear();
  }

  getOutput(key: string): string {
    return this.outputs.get(key) || '';
  }

  isRunning(): boolean {
    return this.ptys.size > 0;
  }
}
