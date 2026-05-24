import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { TechStackDetector, TechStackInfo } from './tech-stack-detector';
import { execSync, spawn, ChildProcess } from 'child_process';

export interface UITestAction {
  action: 'click' | 'fill' | 'screenshot' | 'scroll' | 'wait' | 'assert_visible' | 'assert_text' | 'assert_attribute' | 'hover' | 'type' | 'press_key' | 'select' | 'check' | 'uncheck';
  selector?: string;
  value?: string;
  // For scroll
  to?: 'top' | 'bottom' | 'selector';
  // For screenshot
  fullPage?: boolean;
  element?: string;
  // For wait
  ms?: number;
  // For assert_text
  text?: string;
  contains?: string;
  // For assert_attribute
  attribute?: string;
  expected?: string;
  // Description for logging
  description?: string;
}

export interface UITestSpec {
  url: string;
  viewport?: { width: number; height: number };
  tests: UITestAction[];
}

export interface UITestStepResult {
  index: number;
  action: UITestAction;
  status: 'pass' | 'fail' | 'error';
  durationMs: number;
  screenshotPath?: string;
  error?: string;
  expectedValue?: string;
  actualValue?: string;
}

export interface UITestResult {
  passed: boolean;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  errorSteps: number;
  durationMs: number;
  videoPath?: string;
  screenshotsDir: string;
  steps: UITestStepResult[];
  techStack: TechStackInfo;
}

export class UITester {
  private static BROWSER: Browser | null = null;
  private static CONTEXT: BrowserContext | null = null;
  private static PROCESSES: Set<ChildProcess> = new Set();

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
    if (this.broadcastFn) this.broadcastFn('log', { role: 'ui_tester', message });
    console.log(`[UITester] ${message}`);
  }

  async runTests(spec: UITestSpec): Promise<UITestResult> {
    const startTime = Date.now();
    const screenshotsDir = path.join(this.triadDir, 'ui-screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

    const result: UITestResult = {
      passed: true,
      totalSteps: spec.tests.length,
      passedSteps: 0,
      failedSteps: 0,
      errorSteps: 0,
      durationMs: 0,
      screenshotsDir,
      steps: [],
      techStack: new TechStackDetector().detect(this.workspacePath),
    };

    // Detect and resolve the target
    let targetUrl = spec.url;
    if (targetUrl.startsWith('http')) {
      this.log(`Using provided URL: ${targetUrl}`);
    } else if (result.techStack.type === 'dev-server') {
      this.log(`Detected framework: ${result.techStack.framework} — starting dev server`);
      const devServerUrl = await this.startDevServer(result.techStack);
      if (devServerUrl) {
        targetUrl = devServerUrl;
        result.techStack.resolvedEntry = devServerUrl;
        this.log(`Dev server running at ${devServerUrl}`);
      }
    }

    if (!targetUrl.startsWith('http')) {
      const absPath = path.resolve(this.workspacePath, targetUrl || 'index.html');
      if (!fs.existsSync(absPath)) {
        this.log(`No valid target found. Static path check failed: ${absPath}`);
        result.passed = false;
        result.steps.push({
          index: -1,
          action: { action: 'screenshot', description: 'Entry point resolution failed' },
          status: 'error',
          durationMs: 0,
          error: `No valid target URL or HTML file found. Detected framework: ${result.techStack.framework}. Resolved entry: ${absPath}`,
        });
        return result;
      }
      targetUrl = `file://${absPath.replace(/\\/g, '/')}`;
    }

    this.log(`Target URL: ${targetUrl}`);
    const viewport = spec.viewport || { width: 1280, height: 720 };

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        viewport,
        recordVideo: {
          dir: screenshotsDir,
          size: viewport,
        },
      });
      page = await context.newPage();

      // Catch all console/error events
      page.on('console', msg => this.log(`[browser ${msg.type()}] ${msg.text()}`));
      page.on('pageerror', err => this.log(`[browser error] ${err.message}`));

      this.log(`Navigating to ${targetUrl}...`);
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });

      for (let i = 0; i < spec.tests.length; i++) {
        const action = spec.tests[i];
        const stepStart = Date.now();
        const stepResult: UITestStepResult = {
          index: i,
          action,
          status: 'pass',
          durationMs: 0,
        };

        try {
          this.log(`[${i + 1}/${spec.tests.length}] ${action.description || action.action} ${action.selector || ''}`);

          switch (action.action) {
            case 'click':
              await page.click(action.selector!, { timeout: 5000 });
              break;
            case 'fill':
              await page.fill(action.selector!, action.value || '');
              break;
            case 'type':
              await page.type(action.selector!, action.value || '');
              break;
            case 'press_key':
              await page.keyboard.press(action.value || 'Enter');
              break;
            case 'hover':
              await page.hover(action.selector!, { timeout: 5000 });
              break;
            case 'select':
              await page.selectOption(action.selector!, action.value || '');
              break;
            case 'check':
              await page.check(action.selector!, { timeout: 5000 });
              break;
            case 'uncheck':
              await page.uncheck(action.selector!, { timeout: 5000 });
              break;
            case 'scroll':
              if (action.to === 'bottom') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
              else if (action.to === 'top') await page.evaluate(() => window.scrollTo(0, 0));
              else if (action.selector) await page.locator(action.selector).scrollIntoViewIfNeeded();
              await page.waitForTimeout(300);
              break;
            case 'wait':
              await page.waitForTimeout(action.ms || 1000);
              break;
            case 'screenshot':
              const ssName = `step_${i}_${Date.now()}.png`;
              const ssPath = path.join(screenshotsDir, ssName);
              if (action.fullPage) {
                await page.screenshot({ path: ssPath, fullPage: true });
              } else if (action.selector) {
                await page.locator(action.selector).screenshot({ path: ssPath });
              } else {
                await page.screenshot({ path: ssPath });
              }
              stepResult.screenshotPath = ssPath;
              break;
            case 'assert_visible':
              const visible = await page.locator(action.selector!).isVisible({ timeout: 3000 }).catch(() => false);
              if (!visible) {
                stepResult.status = 'fail';
                stepResult.error = `Element not visible: ${action.selector}`;
                stepResult.expectedValue = 'visible';
                stepResult.actualValue = 'hidden/missing';
              }
              break;
            case 'assert_text':
              const elText = await page.locator(action.selector!).textContent({ timeout: 3000 }).catch(() => null);
              if (action.contains) {
                if (!elText || !elText.includes(action.contains)) {
                  stepResult.status = 'fail';
                  stepResult.error = `Text does not contain "${action.contains}": ${action.selector}`;
                  stepResult.expectedValue = action.contains;
                  stepResult.actualValue = elText || 'null';
                }
              } else if (action.text) {
                if (elText?.trim() !== action.text.trim()) {
                  stepResult.status = 'fail';
                  stepResult.error = `Text mismatch for ${action.selector}`;
                  stepResult.expectedValue = action.text;
                  stepResult.actualValue = elText || 'null';
                }
              }
              break;
            case 'assert_attribute':
              const attrValue = await page.locator(action.selector!).getAttribute(action.attribute!, { timeout: 3000 }).catch(() => null);
              if (attrValue !== action.expected) {
                stepResult.status = 'fail';
                stepResult.error = `Attribute mismatch: ${action.selector}[${action.attribute}]`;
                stepResult.expectedValue = action.expected;
                stepResult.actualValue = attrValue || 'null';
              }
              break;
          }

          stepResult.durationMs = Date.now() - stepStart;

          if (stepResult.status === 'pass') {
            result.passedSteps++;
          } else {
            result.failedSteps++;
            result.passed = false;
          }
        } catch (e: any) {
          stepResult.status = 'error';
          stepResult.error = e.message;
          stepResult.durationMs = Date.now() - stepStart;
          result.errorSteps++;
          result.passed = false;
          this.log(`[ERROR] Step ${i}: ${e.message}`);

          // Capture error screenshot
          try {
            const errSsPath = path.join(screenshotsDir, `error_step_${i}_${Date.now()}.png`);
            await page.screenshot({ path: errSsPath });
            stepResult.screenshotPath = errSsPath;
          } catch (ssErr) {}
        }

        result.steps.push(stepResult);
      }

      // Capture final full-page screenshot
      try {
        const finalSsPath = path.join(screenshotsDir, `final_${Date.now()}.png`);
        await page.screenshot({ path: finalSsPath, fullPage: true });
      } catch (e) {}

    } catch (e: any) {
      this.log(`[FATAL] Test run error: ${e.message}`);
      result.passed = false;
      result.steps.push({
        index: -2,
        action: { action: 'screenshot', description: 'Browser/navigation error' },
        status: 'error',
        durationMs: 0,
        error: e.message,
      });
    } finally {
      try { await page?.close(); } catch (e) {}
      try {
        await context?.close();
        // Extract video path before closing context
        const videoPath = await context?.pages()?.[0]?.video()?.path?.();
        if (videoPath) result.videoPath = videoPath;
      } catch (e) {}
      try { await browser?.close(); } catch (e) {}
    }

    result.durationMs = Date.now() - startTime;
    this.log(`Tests complete: ${result.passedSteps}/${result.totalSteps} passed, ${result.failedSteps} failed, ${result.errorSteps} errors in ${(result.durationMs / 1000).toFixed(1)}s`);

    // Kill dev server if we started one
    await this.killDevServer();

    return result;
  }

  private devServerProcess: ChildProcess | null = null;

  private async startDevServer(info: TechStackInfo): Promise<string | null> {
    if (!info.devServerCommand || !info.devServerPort) return null;

    const pm = info.packageManager || 'npm';
    const ws = this.workspacePath;

    this.log(`Starting dev server: ${pm} ${info.devServerCommand}`);
    // Try to install deps first if node_modules missing
    const nmPath = path.join(ws, 'node_modules');
    if (!fs.existsSync(nmPath)) {
      try {
        this.log(`Installing dependencies (${pm} install)...`);
        execSync(`${pm} install`, { cwd: ws, timeout: 60000, stdio: 'pipe' });
        this.log('Dependencies installed.');
      } catch (e: any) {
        this.log(`npm install failed: ${e.message} — continuing anyway`);
      }
    }

    return new Promise((resolve) => {
      try {
        const cmd = pm;
        const args = info.devServerCommand!.startsWith(`${pm} `)
          ? info.devServerCommand!.split(' ').slice(1)
          : info.devServerCommand!.split(' ');

        const child = spawn(cmd, args, {
          cwd: ws,
          stdio: 'pipe',
          shell: true,
        });

        this.devServerProcess = child;

        let started = false;
        const timeout = setTimeout(() => {
          if (!started) {
            this.log(`Dev server timed out — assuming it's running on port ${info.devServerPort}`);
            resolve(`http://localhost:${info.devServerPort}`);
          }
        }, 30000);

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          // Check for common "ready" signals
          if (!started && (
            text.includes('ready') || text.includes('Local:') ||
            text.includes('localhost') || text.includes('Compiled') ||
            text.includes('running at') || text.includes('server ready')
          )) {
            started = true;
            clearTimeout(timeout);
            setTimeout(() => resolve(`http://localhost:${info.devServerPort}`), 2000);
          }
        });

        child.on('error', () => {
          clearTimeout(timeout);
          resolve(null);
        });

        child.on('exit', (code) => {
          clearTimeout(timeout);
          if (!started) resolve(null);
        });
      } catch (e: any) {
        this.log(`Failed to start dev server: ${e.message}`);
        resolve(null);
      }
    });
  }

  async killDevServer() {
    if (this.devServerProcess) {
      try {
        this.devServerProcess.kill('SIGTERM');
        // Also kill child processes on Windows
        try { execSync(`taskkill /F /T /PID ${this.devServerProcess.pid} 2>nul`, { stdio: 'ignore' }); } catch (e) {}
      } catch (e) {}
      this.devServerProcess = null;
    }
  }

  static async cleanupAll() {
    if (UITester.CONTEXT) { try { await UITester.CONTEXT.close(); } catch (e) {} }
    if (UITester.BROWSER) { try { await UITester.BROWSER.close(); } catch (e) {} }
  }

  generateTestReport(result: UITestResult): string {
    const lines: string[] = [];
    lines.push('# UI Test Report');
    lines.push('');
    lines.push(`**Overall:** ${result.passed ? 'PASS' : 'FAIL'}`);
    lines.push(`**Steps:** ${result.passedSteps}/${result.totalSteps} passed, ${result.failedSteps} failed, ${result.errorSteps} errors`);
    lines.push(`**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
    lines.push(`**Tech Stack:** ${result.techStack.framework} (${result.techStack.type})`);
    if (result.techStack.devServerPort) lines.push(`**Dev Server Port:** ${result.techStack.devServerPort}`);
    if (result.videoPath) lines.push(`**Video:** ${result.videoPath}`);
    lines.push('');
    lines.push('## Steps');
    lines.push('');
    lines.push('| # | Action | Status | Duration | Details |');
    lines.push('|---|---|---|---|---|');
    for (const step of result.steps) {
      const statusIcon = step.status === 'pass' ? '✅' : step.status === 'fail' ? '❌' : '⚠️';
      const desc = step.action.description || step.action.action;
      const detail = step.error ? `Error: ${step.error}` : '';
      lines.push(`| ${step.index} | ${desc} | ${statusIcon} ${step.status} | ${step.durationMs}ms | ${detail} |`);
    }
    lines.push('');
    if (result.failedSteps > 0 || result.errorSteps > 0) {
      lines.push('## Failures');
      lines.push('');
      for (const step of result.steps) {
        if (step.status !== 'pass') {
          lines.push(`- **Step ${step.index}:** ${step.action.description || step.action.action} — ${step.error}`);
          if (step.expectedValue) lines.push(`  Expected: \`${step.expectedValue}\``);
          if (step.actualValue) lines.push(`  Actual: \`${step.actualValue}\``);
          if (step.screenshotPath) lines.push(`  Screenshot: ${step.screenshotPath}`);
        }
      }
    }
    return lines.join('\n');
  }

  parseTestSpec(content: string): UITestSpec | null {
    try {
      const json = JSON.parse(content.trim());
      if (json.tests && Array.isArray(json.tests)) return json as UITestSpec;
      if (Array.isArray(json)) return { url: '', tests: json as UITestAction[] };
    } catch (e) {}
    // Try to extract JSON from markdown code block
    const jsonMatch = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try { const parsed = JSON.parse(jsonMatch[1]); if (parsed.tests) return parsed as UITestSpec; } catch (e) {}
    }
    return null;
  }
}
