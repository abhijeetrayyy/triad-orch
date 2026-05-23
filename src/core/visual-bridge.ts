import { chromium } from 'playwright';
import * as path from 'path';

export class VisualBridge {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async captureScreenshot(filePath: string): Promise<string> {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.baseDir, filePath);
      const fileUrl = `file://${absolutePath.replace(/\\/g, '/')}`;
      
      console.log(`[VisualBridge] Navigating to ${fileUrl}`);
      await page.goto(fileUrl, { waitUntil: 'networkidle' });
      
      const screenshotBuffer = await page.screenshot();
      return screenshotBuffer.toString('base64');
    } catch (error: any) {
      console.error('[VisualBridge] Failed to capture screenshot:', error.message);
      throw error;
    } finally {
      await browser.close();
    }
  }
}
