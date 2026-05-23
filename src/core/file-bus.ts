import chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import { type FSWatcher } from 'chokidar';
import { TRIAD_FILES, TriadFileName } from './types';

export class FileBus {
  private triadDir: string;
  private watcher: FSWatcher;
  private handlers: Map<string, (content: string) => void> = new Map();

  constructor(workspacePath: string) {
    this.triadDir = path.join(workspacePath, '.triad');
    if (!fs.existsSync(this.triadDir)) {
      fs.mkdirSync(this.triadDir, { recursive: true });
    }

    this.watcher = chokidar.watch(this.triadDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });

    this.watcher.on('add', (filePath: string) => {
      const filename = path.basename(filePath);
      if (!TRIAD_FILES.includes(filename as TriadFileName)) {
        console.warn(`[FileBus] Unexpected file in .triad/: ${filename}`);
        return;
      }
      const handler = this.handlers.get(filename);
      if (handler) {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.delete(filename);
        handler(content);
      }
    });
  }

  watch(filename: string, handler: (content: string) => void): void {
    this.handlers.set(filename, handler);
  }

  unwatch(filename: string): void {
    this.handlers.delete(filename);
  }

  write(filename: string, content: string): void {
    fs.writeFileSync(path.join(this.triadDir, filename), content, 'utf-8');
  }

  read(filename: string): string {
    try {
      return fs.readFileSync(path.join(this.triadDir, filename), 'utf-8');
    } catch (e) {
      return '';
    }
  }

  delete(filename: string): void {
    const fp = path.join(this.triadDir, filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  exists(filename: string): boolean {
    return fs.existsSync(path.join(this.triadDir, filename));
  }

  clearSignals(): void {
    const signals = ['done.signal', 'fail_signal'];
    signals.forEach(s => this.delete(s));
  }

  clearAll(): void {
    if (fs.existsSync(this.triadDir)) {
      const files = fs.readdirSync(this.triadDir);
      files.forEach(f => {
        if (f !== 'model_config.json' && !f.startsWith('opencode_') && f !== 'screenshots') {
          this.delete(f);
        }
      });
    }
  }

  listFiles(): string[] {
    if (!fs.existsSync(this.triadDir)) return [];
    return fs.readdirSync(this.triadDir);
  }

  async stop(): Promise<void> {
    await this.watcher.close();
  }
}
