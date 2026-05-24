import * as fs from 'fs';
import * as path from 'path';

export interface SecurityCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export class SecurityGuard {
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * ECC-style security checks before any commit.
   * Mirrors security-review and governance-capture hooks from ECC.
   */
  async runPreCommitChecks(changedFiles: string[]): Promise<SecurityCheck[]> {
    const checks: SecurityCheck[] = [];

    checks.push(await this.checkHardcodedSecrets(changedFiles));
    checks.push(await this.checkInputValidation(changedFiles));
    checks.push(await this.checkXSSPrevention());
    checks.push(await this.checkAuthIntegrity());
    checks.push(await this.checkErrorMessages(changedFiles));

    return checks;
  }

  private async checkHardcodedSecrets(files: string[]): Promise<SecurityCheck> {
    const patterns = [
      /sk-[a-zA-Z0-9]{32,}/,
      /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i,
      /ghp_[a-zA-Z0-9]{36}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN\s+(RSA|DSA|EC|OPENSSH)?\s*PRIVATE\s+KEY/,
      /password\s*[:=]\s*['"][^'"]{6,}['"]/i,
      /secret\s*[:=]\s*['"][^'"]{6,}['"]/i,
      /token\s*[:=]\s*['"][^'"]{8,}['"]/i,
    ];

    const found: string[] = [];
    for (const f of files) {
      try {
        const fp = path.join(this.workspacePath, f);
        if (!fs.existsSync(fp) || f.startsWith('.triad')) continue;
        const content = fs.readFileSync(fp, 'utf-8');
        for (const pattern of patterns) {
          if (pattern.test(content)) {
            found.push(f);
            break;
          }
        }
      } catch (e) {}
    }

    return {
      name: 'Hardcoded Secrets',
      passed: found.length === 0,
      detail: found.length > 0 ? `Found in: ${found.join(', ')}` : 'No secrets detected',
    };
  }

  private async checkInputValidation(files: string[]): Promise<SecurityCheck> {
    // Check if .ts/.tsx/.js files use validation
    const validationSignatures = [/zod/, /joi/, /yup/, /validator/, /class-validator/, /@Is/, /@Validate/];
    const hasCode = files.some(f => /\.(ts|tsx|js|jsx)$/.test(f));
    if (!hasCode) return { name: 'Input Validation', passed: true, detail: 'No backend code to check' };

    let hasValidation = false;
    for (const f of files) {
      if (!/\.(ts|tsx)$/.test(f)) continue;
      try {
        const content = fs.readFileSync(path.join(this.workspacePath, f), 'utf-8');
        if (validationSignatures.some(p => p.test(content))) {
          hasValidation = true;
          break;
        }
      } catch (e) {}
    }

    return {
      name: 'Input Validation',
      passed: hasValidation || !files.some(f => f.includes('api') || f.includes('server') || f.includes('route')),
      detail: hasValidation ? 'Validation library detected' : 'No validation detected — ensure inputs are validated',
    };
  }

  private async checkXSSPrevention(): Promise<SecurityCheck> {
    // Check for dangerouslySetInnerHTML or innerHTML patterns
    const htmlFiles = this.findFiles(/\.(html|jsx|tsx|vue|svelte|astro)$/);
    const dangerous: string[] = [];
    for (const f of htmlFiles) {
      try {
        const content = fs.readFileSync(path.join(this.workspacePath, f), 'utf-8');
        if (/dangerouslySetInnerHTML|\.innerHTML\s*=|v-html/.test(content)) {
          dangerous.push(f);
        }
      } catch (e) {}
    }

    return {
      name: 'XSS Prevention',
      passed: dangerous.length === 0,
      detail: dangerous.length > 0 ? `Potential XSS in: ${dangerous.join(', ')}` : 'No XSS patterns detected',
    };
  }

  private async checkAuthIntegrity(): Promise<SecurityCheck> {
    const authFiles = this.findFiles(/\.(ts|tsx|js|jsx)$/).filter(f =>
      f.includes('auth') || f.includes('login') || f.includes('middleware')
    );
    if (authFiles.length === 0) return { name: 'Auth Integrity', passed: true, detail: 'No auth files detected' };

    let hasAuth = false;
    for (const f of authFiles) {
      try {
        const content = fs.readFileSync(path.join(this.workspacePath, f), 'utf-8');
        if (/verify|jwt\.|authenticate|authoriz|session|token/.test(content)) {
          hasAuth = true;
          break;
        }
      } catch (e) {}
    }

    return {
      name: 'Auth Integrity',
      passed: hasAuth,
      detail: hasAuth ? 'Auth mechanisms detected' : 'No auth validation found in auth files',
    };
  }

  private async checkErrorMessages(files: string[]): Promise<SecurityCheck> {
    const leaked: string[] = [];
    for (const f of files) {
      if (!/\.(ts|tsx|js|jsx|py|go|rs)$/.test(f)) continue;
      try {
        const content = fs.readFileSync(path.join(this.workspacePath, f), 'utf-8');
        if (/catch\s*\(.*\)\s*\{[^}]*res\.send\([^}]*err/.test(content) ||
            /catch\s*\(.*\)\s*\{[^}]*console\.error\(.*stack/.test(content)) {
          leaked.push(f);
        }
      } catch (e) {}
    }

    return {
      name: 'Error Message Scrubbing',
      passed: leaked.length === 0,
      detail: leaked.length > 0 ? `Raw errors exposed in: ${leaked.join(', ')}` : 'Error handling looks safe',
    };
  }

  private findFiles(pattern: RegExp, max: number = 50): string[] {
    const results: string[] = [];
    try {
      const walk = (d: string) => {
        if (results.length >= max) return;
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (results.length >= max) return;
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const fp = path.join(d, e.name);
            if (e.isDirectory()) walk(fp);
            else if (pattern.test(e.name)) results.push(path.relative(this.workspacePath, fp));
          }
        } catch (err) {}
      };
      walk(this.workspacePath);
    } catch (e) {}
    return results;
  }
}
