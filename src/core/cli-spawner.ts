import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { AgentRole, CLIType, ModelConfig } from './types';

type BroadcastFn = (event: string, data: any) => void;

interface PTYOutput {
  role: AgentRole;
  data: string;
}

export class CLISpawner {
  private workspacePath: string;
  private ptys: Map<AgentRole, pty.IPty> = new Map();
  private outputs: Map<AgentRole, string> = new Map();
  private broadcast: BroadcastFn | null = null;
  private lastActivity: Map<AgentRole, number> = new Map();
  private watchdogInterval: NodeJS.Timeout | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.startWatchdog();
  }

  private startWatchdog(): void {
    this.watchdogInterval = setInterval(() => {
      const now = Date.now();
      this.ptys.forEach((_, role) => {
        const last = this.lastActivity.get(role) || now;
        if (now - last > 120000) { // 2 min no output = stuck
          console.error(`[CLISpawner] Watchdog: ${role} stuck (no output for ${((now - last)/1000).toFixed(0)}s)`);
          this.kill(role);
        }
      });
    }, 15000);
  }

  private stopWatchdog(): void {
    if (this.watchdogInterval) { clearInterval(this.watchdogInterval); this.watchdogInterval = null; }
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  spawnOpenCode(role: AgentRole, promptContent: string, modelConfig: ModelConfig): pty.IPty {
    const triadDir = path.join(this.workspacePath, '.triad');
    if (!fs.existsSync(triadDir)) {
      fs.mkdirSync(triadDir, { recursive: true });
    }

    const configFile = `opencode_${role}_config.json`;
    const config = {
      provider: modelConfig.provider || 'deepseek',
      model: modelConfig.model,
      instructions: `You are the ${role} agent for Triad Engine. Always write your final output to .triad/${this.getExpectedOutput(role)}. Do not modify any file outside your assigned scope. Do not include markdown fences in file outputs.`
    };
    fs.writeFileSync(path.join(triadDir, configFile), JSON.stringify(config, null, 2));

    const npmDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm')
      : '';
    const opencodePath = npmDir ? path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe') : '';
    const opencodeShell = npmDir ? path.join(npmDir, 'opencode.cmd') : '';
    const spawnCmd =
      process.platform === 'win32' && fs.existsSync(opencodePath) ? opencodePath :
      process.platform === 'win32' && fs.existsSync(opencodeShell) ? 'cmd.exe' :
      'opencode';
    const spawnArgs =
      spawnCmd === 'cmd.exe' ? ['/c', opencodeShell, 'run', promptContent] :
      ['run', promptContent];
    const ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: this.workspacePath,
      env: process.env as { [key: string]: string }
    });

    this.outputs.set(role, '');
    this.lastActivity.set(role, Date.now());

    ptyProcess.onData((data) => {
      this.lastActivity.set(role, Date.now());
      const current = this.outputs.get(role) || '';
      this.outputs.set(role, current + data);
      if (this.broadcast) {
        this.broadcast('agent-output', { role, data, project: path.basename(this.workspacePath) });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[CLISpawner] ${role} exited (code=${exitCode} signal=${signal})`);
      if (exitCode !== 0) {
        console.error(`[CLISpawner] ${role} failed with exit code ${exitCode}`);
      }
      this.lastActivity.set(role, 0);
    });

    this.ptys.set(role, ptyProcess);
    return ptyProcess;
  }

  spawnGemini(role: AgentRole, promptContent: string): pty.IPty {
    const npmDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm')
      : '';
    const geminiPath = npmDir
      ? path.join(npmDir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js')
      : '';
    const geminiShell = npmDir ? path.join(npmDir, 'gemini.cmd') : '';
    const cmd = process.platform === 'win32' && fs.existsSync(geminiPath) ? process.execPath :
      process.platform === 'win32' && fs.existsSync(geminiShell) ? 'cmd.exe' :
      'gemini';
    const args = process.platform === 'win32' && fs.existsSync(geminiPath) ? [geminiPath, '--prompt', promptContent] :
      process.platform === 'win32' && fs.existsSync(geminiShell) ? ['/c', geminiShell, '--prompt', promptContent] :
      ['--prompt', promptContent];
    const ptyProcess = pty.spawn(cmd, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: this.workspacePath,
      env: process.env as { [key: string]: string }
    });

    this.outputs.set(role, '');
    this.lastActivity.set(role, Date.now());

    ptyProcess.onData((data) => {
      this.lastActivity.set(role, Date.now());
      const current = this.outputs.get(role) || '';
      this.outputs.set(role, current + data);
      if (this.broadcast) {
        this.broadcast('agent-output', { role, data, project: path.basename(this.workspacePath) });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[CLISpawner] ${role} exited (code=${exitCode} signal=${signal})`);
      if (exitCode !== 0) {
        console.error(`[CLISpawner] ${role} failed with exit code ${exitCode}`);
      }
      this.lastActivity.set(role, 0);
    });

    this.ptys.set(role, ptyProcess);
    return ptyProcess;
  }

  spawnByCLI(cli: CLIType, role: AgentRole, prompt: string, modelConfig?: ModelConfig): pty.IPty | null {
    switch (cli) {
      case 'opencode':
        return this.spawnOpenCode(role, prompt, modelConfig || { cli: 'opencode', model: 'deepseek-v4-pro' });
      case 'gemini':
        return this.spawnGemini(role, prompt);
      case 'claude-code':
        console.warn('[CLISpawner] Claude Code CLI not yet implemented, falling back to OpenCode');
        return this.spawnOpenCode(role, prompt, modelConfig || { cli: 'opencode', model: 'deepseek-v4-pro' });
      default:
        console.error(`[CLISpawner] Unknown CLI type: ${cli}`);
        return null;
    }
  }

  kill(role: AgentRole): void {
    const p = this.ptys.get(role);
    if (p) {
      try { p.kill(); } catch (e) {}
      this.ptys.delete(role);
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

  getOutput(role: AgentRole): string {
    return this.outputs.get(role) || '';
  }

  isRunning(role: AgentRole): boolean {
    return this.ptys.has(role);
  }

  getActiveRoles(): AgentRole[] {
    return Array.from(this.ptys.keys());
  }

  private getExpectedOutput(role: AgentRole): string {
    const map: Record<AgentRole, string> = {
      architect: 'plan.md',
      builder: 'done.signal',
      reviewer: 'review.md',
      auditor: 'audit.md'
    };
    return map[role];
  }
}
