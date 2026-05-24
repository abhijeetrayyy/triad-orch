import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { TaskQueueEntry } from './types';

export interface VerificationResult {
  passed: boolean;
  gates: VerificationGate[];
  summary: string;
}

export interface VerificationGate {
  name: string;
  passed: boolean;
  output: string;
  error?: string;
  recommendation?: string;
}

export class Verifier {
  private workspacePath: string;
  private triadDir: string;
  private broadcastFn: ((event: string, data: any) => void) | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.triadDir = path.join(workspacePath, '.triad');
  }

  setBroadcast(fn: (event: string, data: any) => void) {
    this.broadcastFn = fn;
  }

  private log(message: string) {
    if (this.broadcastFn) this.broadcastFn('log', { role: 'verifier', message });
    console.log(`[Verifier] ${message}`);
  }

  /**
   * ECC-style verification loop: build → typecheck → lint → test → security scan.
   * Gates run sequentially — any failure stops the chain unless ignoreFailures is set.
   */
  async runAll(ignoreFailures: boolean = false): Promise<VerificationResult> {
    this.log('Starting ECC verification loop (build → typecheck → lint → test → security scan)');
    const gates: VerificationGate[] = [];

    gates.push(await this.runBuild());
    if (!gates[gates.length - 1].passed && !ignoreFailures) return this.buildResult(gates);

    gates.push(await this.runTypecheck());
    if (!gates[gates.length - 1].passed && !ignoreFailures) return this.buildResult(gates);

    gates.push(await this.runLint());
    if (!gates[gates.length - 1].passed && !ignoreFailures) return this.buildResult(gates);

    gates.push(await this.runTests());
    if (!gates[gates.length - 1].passed && !ignoreFailures) return this.buildResult(gates);

    gates.push(await this.runSecurityScan());

    return this.buildResult(gates);
  }

  async runBuild(): Promise<VerificationGate> {
    this.log('[VERIFY] Build check...');
    const pkgPath = path.join(this.workspacePath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return { name: 'Build', passed: true, output: 'No package.json — skipping build' };
    }

    // Detect build script
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const hasBuild = pkg.scripts?.build;
    if (!hasBuild) {
      return { name: 'Build', passed: true, output: 'No build script — skipping' };
    }

    try {
      const pm = this.detectPackageManager();
      const output = execSync(`${pm} run build`, { cwd: this.workspacePath, stdio: 'pipe', timeout: 60000 }).toString();
      return { name: 'Build', passed: true, output: output.slice(-500) || 'Build succeeded' };
    } catch (e: any) {
      const errOut = (e.stderr?.toString() || e.stdout?.toString() || e.message).slice(-500);
      return { name: 'Build', passed: false, output: '', error: errOut, recommendation: 'Fix build errors before continuing' };
    }
  }

  async runTypecheck(): Promise<VerificationGate> {
    this.log('[VERIFY] TypeScript typecheck...');
    const tsconfig = path.join(this.workspacePath, 'tsconfig.json');
    if (!fs.existsSync(tsconfig)) {
      return { name: 'Typecheck', passed: true, output: 'No tsconfig.json — skipping TypeScript typecheck' };
    }

    try {
      const output = execSync('npx tsc --noEmit', { cwd: this.workspacePath, stdio: 'pipe', timeout: 60000 }).toString();
      return { name: 'Typecheck', passed: true, output: 'TypeScript: no errors' };
    } catch (e: any) {
      const errOut = (e.stdout?.toString() || '').slice(-800);
      return { name: 'Typecheck', passed: false, output: '', error: errOut, recommendation: 'Fix type errors before continuing' };
    }
  }

  async runLint(): Promise<VerificationGate> {
    this.log('[VERIFY] Lint check...');
    const pkgPath = path.join(this.workspacePath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return { name: 'Lint', passed: true, output: 'No package.json — skipping lint' };
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const hasLint = pkg.scripts?.lint;
    if (!hasLint) {
      return { name: 'Lint', passed: true, output: 'No lint script — skipping' };
    }

    try {
      const output = execSync(`${this.detectPackageManager()} run lint`, { cwd: this.workspacePath, stdio: 'pipe', timeout: 60000 }).toString();
      return { name: 'Lint', passed: true, output: output.slice(-300) || 'Lint passed' };
    } catch (e: any) {
      const errOut = (e.stdout?.toString() || e.stderr?.toString() || e.message).slice(-500);
      return { name: 'Lint', passed: false, output: '', error: errOut, recommendation: 'Fix lint errors before continuing' };
    }
  }

  async runTests(): Promise<VerificationGate> {
    this.log('[VERIFY] Test suite...');
    const pkgPath = path.join(this.workspacePath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return { name: 'Tests', passed: true, output: 'No package.json — skipping tests' };
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const hasTest = pkg.scripts?.test;
    if (!hasTest) {
      return { name: 'Tests', passed: true, output: 'No test script — skipping' };
    }

    try {
      const output = execSync(`${this.detectPackageManager()} test`, { cwd: this.workspacePath, stdio: 'pipe', timeout: 120000 }).toString();
      return { name: 'Tests', passed: true, output: output.slice(-500) || 'Tests passed' };
    } catch (e: any) {
      const errOut = (e.stdout?.toString() || e.stderr?.toString() || e.message).slice(-500);
      return { name: 'Tests', passed: false, output: '', error: errOut, recommendation: 'Fix failing tests before continuing' };
    }
  }

  async runSecurityScan(): Promise<VerificationGate> {
    this.log('[VERIFY] Security scan...');
    // Check for hardcoded secrets in workspace files
    const issues: string[] = [];
    const secretPatterns = [
      /(['">]?)(sk-[a-zA-Z0-9]{32,})(['"<\n])/gi,
      /(['">]?)(api[_-]?key\s*[:=]\s*['"][^'"]+['"])/gi,
      /(['">]?)(ghp_[a-zA-Z0-9]{36})(['"<\n])/gi,
      /(['">]?)(-----BEGIN\s+(RSA|DSA|EC|OPENSSH)?\s*PRIVATE\s+KEY)/gi,
    ];

    try {
      const files = this.walkDirLimited(this.workspacePath);
      for (const file of files) {
        if (file.includes('node_modules') || file.includes('.git') || file.endsWith('.lock')) continue;
        try {
          const content = fs.readFileSync(path.join(this.workspacePath, file), 'utf-8');
          for (const pattern of secretPatterns) {
            const matches = content.match(pattern);
            if (matches) {
              issues.push(`${file}: potential secret detected`);
              break;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    if (issues.length > 0) {
      return { name: 'Security Scan', passed: false, output: '', error: issues.join('\n'), recommendation: 'Remove hardcoded secrets immediately. Use environment variables.' };
    }

    return { name: 'Security Scan', passed: true, output: 'No hardcoded secrets detected' };
  }

  private buildResult(gates: VerificationGate[]): VerificationResult {
    const passed = gates.every(g => g.passed);
    const summary = gates.map(g => `[${g.passed ? '✓' : '✗'}] ${g.name}`).join(' → ');
    const failures = gates.filter(g => !g.passed);
    const recs = failures.map(f => `- ${f.name}: ${f.recommendation || f.error?.slice(0, 100)}`).join('\n');

    return {
      passed,
      gates,
      summary: `${summary}\n${failures.length} gates failed.\n${recs}`,
    };
  }

  private detectPackageManager(): string {
    if (fs.existsSync(path.join(this.workspacePath, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(this.workspacePath, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(this.workspacePath, 'bun.lockb'))) return 'bun';
    return 'npm';
  }

  private walkDirLimited(dir: string, maxFiles: number = 200): string[] {
    const results: string[] = [];
    const walk = (d: string) => {
      if (results.length >= maxFiles) return;
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= maxFiles) return;
          const fp = path.join(d, e.name);
          if (e.name.startsWith('.') && e.name !== '.env') continue;
          if (e.isDirectory() && e.name !== 'node_modules') walk(fp);
          else results.push(path.relative(this.workspacePath, fp));
        }
      } catch (err) {}
    };
    walk(this.workspacePath);
    return results;
  }
}
