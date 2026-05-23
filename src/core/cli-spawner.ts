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

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
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

    const opencodePath = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
      : 'opencode';
    const cmd = process.platform === 'win32' && fs.existsSync(opencodePath) ? opencodePath : 'opencode';
    const ptyProcess = pty.spawn(cmd, [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: this.workspacePath,
      env: process.env as { [key: string]: string }
    });

    this.outputs.set(role, '');

    ptyProcess.onData((data) => {
      const current = this.outputs.get(role) || '';
      this.outputs.set(role, current + data);
      if (this.broadcast) {
        this.broadcast('agent-output', { role, data, project: path.basename(this.workspacePath) });
      }
    });

    setTimeout(() => {
      ptyProcess.write(promptContent + '\n');
    }, 800);

    this.ptys.set(role, ptyProcess);
    return ptyProcess;
  }

  spawnGemini(role: AgentRole, promptContent: string): pty.IPty {
    const geminiPath = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js')
      : '';
    const cmd = process.platform === 'win32' && fs.existsSync(geminiPath) ? process.execPath : 'gemini';
    const args = process.platform === 'win32' && fs.existsSync(geminiPath) ? [geminiPath] : [];
    const ptyProcess = pty.spawn(cmd, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: this.workspacePath,
      env: process.env as { [key: string]: string }
    });

    this.outputs.set(role, '');

    ptyProcess.onData((data) => {
      const current = this.outputs.get(role) || '';
      this.outputs.set(role, current + data);
      if (this.broadcast) {
        this.broadcast('agent-output', { role, data, project: path.basename(this.workspacePath) });
      }
    });

    setTimeout(() => {
      ptyProcess.write(promptContent + '\n');
    }, 800);

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
