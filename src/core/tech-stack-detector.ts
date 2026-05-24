import * as fs from 'fs';
import * as path from 'path';

export interface TechStackInfo {
  type: 'static' | 'dev-server' | 'build-output';
  framework: string;
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | null;
  devServerCommand: string | null;
  buildCommand: string | null;
  devServerPort: number | null;
  entryPoint: string | null;
  outputDir: string | null;
  hasPlaywright: boolean;
  resolvedEntry: string | null; // absolute path to the HTML file or dev server URL
}

const PACKAGE_JSON_INDICATORS: Record<string, string> = {
  'next': 'next.js',
  'react-scripts': 'react (CRA)',
  'vite': 'vite',
  '@angular/cli': 'angular',
  'vue': 'vue',
  '@vue/cli-service': 'vue',
  'nuxt': 'nuxt',
  'svelte': 'svelte',
  'astro': 'astro',
  'gatsby': 'gatsby',
  'parcel': 'parcel',
  'webpack': 'webpack',
  'rollup': 'rollup',
  'esbuild': 'esbuild',
  'turbo': 'turborepo',
  'lerna': 'lerna',
  'nx': 'nx',
};

const STATIC_SERVERS: Record<string, string> = {
  'next': 'next dev',
  'react-scripts': 'react-scripts start',
  'vite': 'vite',
  '@angular/cli': 'ng serve',
  '@vue/cli-service': 'vue-cli-service serve',
  'nuxt': 'nuxt dev',
  'astro': 'astro dev',
  'gatsby': 'gatsby develop',
  'parcel': 'parcel',
  'svelte': 'svelte-kit dev',
};

const BUILD_COMMANDS: Record<string, string> = {
  'next': 'next build',
  'react-scripts': 'react-scripts build',
  'vite': 'vite build',
  '@angular/cli': 'ng build',
  '@vue/cli-service': 'vue-cli-service build',
  'nuxt': 'nuxt generate',
  'astro': 'astro build',
  'gatsby': 'gatsby build',
  'parcel': 'parcel build',
  'svelte': 'svelte-kit build',
};

const OUTPUT_DIRS: Record<string, string> = {
  'next': '.next',
  'react-scripts': 'build',
  'vite': 'dist',
  '@angular/cli': 'dist',
  '@vue/cli-service': 'dist',
  'nuxt': '.output',
  'astro': 'dist',
  'gatsby': 'public',
  'parcel': 'dist',
  'svelte': '.svelte-kit',
};

const DEV_SERVER_PORTS: Record<string, number> = {
  'next': 3000,
  'react-scripts': 3000,
  'vite': 5173,
  '@angular/cli': 4200,
  '@vue/cli-service': 8080,
  'nuxt': 3000,
  'astro': 4321,
  'gatsby': 8000,
  'parcel': 1234,
  'svelte': 5173,
};

export class TechStackDetector {

  detect(workspacePath: string): TechStackInfo {
    const result: TechStackInfo = {
      type: 'static',
      framework: 'vanilla',
      packageManager: null,
      devServerCommand: null,
      buildCommand: null,
      devServerPort: null,
      entryPoint: null,
      outputDir: null,
      hasPlaywright: false,
      resolvedEntry: null,
    };

    // 1. Check for package.json to detect framework and package manager
    const pkgPath = path.join(workspacePath, 'package.json');
    let pkg: any = null;
    if (fs.existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const allDeps = Object.keys(deps);

        // Detect package manager
        if (fs.existsSync(path.join(workspacePath, 'pnpm-lock.yaml'))) result.packageManager = 'pnpm';
        else if (fs.existsSync(path.join(workspacePath, 'yarn.lock'))) result.packageManager = 'yarn';
        else if (fs.existsSync(path.join(workspacePath, 'bun.lockb'))) result.packageManager = 'bun';
        else if (fs.existsSync(path.join(workspacePath, 'package-lock.json'))) result.packageManager = 'npm';

        // Detect framework from package.json
        for (const [pkgName, label] of Object.entries(PACKAGE_JSON_INDICATORS)) {
          if (allDeps.includes(pkgName)) {
            result.framework = label;
            result.type = 'dev-server';
            result.devServerCommand = STATIC_SERVERS[pkgName] || null;
            result.buildCommand = BUILD_COMMANDS[pkgName] || null;
            result.devServerPort = DEV_SERVER_PORTS[pkgName] || null;
            result.outputDir = OUTPUT_DIRS[pkgName] || null;
            break;
          }
        }

        // Override dev server from scripts if present
        if (pkg.scripts?.dev && !result.devServerCommand) {
          result.devServerCommand = `${this.packageManagerCmd(result.packageManager)} run dev`;
          result.type = 'dev-server';
        }

        result.hasPlaywright = allDeps.includes('playwright') || allDeps.includes('@playwright/test');
      } catch (e) {
        // package.json exists but is broken - treat as static
      }
    }

    // 2. Check for framework-specific config files (for projects without package.json)
    if (result.framework === 'vanilla') {
      if (fs.existsSync(path.join(workspacePath, 'next.config.js')) || fs.existsSync(path.join(workspacePath, 'next.config.mjs'))) { result.framework = 'next.js'; result.type = 'dev-server'; result.devServerCommand = 'next dev'; result.devServerPort = 3000; }
      else if (fs.existsSync(path.join(workspacePath, 'vite.config.js')) || fs.existsSync(path.join(workspacePath, 'vite.config.ts'))) { result.framework = 'vite'; result.type = 'dev-server'; result.devServerCommand = 'vite'; result.devServerPort = 5173; }
      else if (fs.existsSync(path.join(workspacePath, 'angular.json'))) { result.framework = 'angular'; result.type = 'dev-server'; result.devServerCommand = 'ng serve'; result.devServerPort = 4200; }
      else if (fs.existsSync(path.join(workspacePath, 'nuxt.config.js')) || fs.existsSync(path.join(workspacePath, 'nuxt.config.ts'))) { result.framework = 'nuxt'; result.type = 'dev-server'; result.devServerCommand = 'nuxt dev'; result.devServerPort = 3000; }
      else if (fs.existsSync(path.join(workspacePath, 'astro.config.mjs')) || fs.existsSync(path.join(workspacePath, 'astro.config.js'))) { result.framework = 'astro'; result.type = 'dev-server'; result.devServerCommand = 'astro dev'; result.devServerPort = 4321; }
      else if (fs.existsSync(path.join(workspacePath, 'svelte.config.js')) || fs.existsSync(path.join(workspacePath, 'svelte.config.ts'))) { result.framework = 'svelte'; result.type = 'dev-server'; result.devServerCommand = 'svelte-kit dev'; result.devServerPort = 5173; }
      else if (fs.existsSync(path.join(workspacePath, 'gatsby-config.js')) || fs.existsSync(path.join(workspacePath, 'gatsby-config.ts'))) { result.framework = 'gatsby'; result.type = 'dev-server'; result.devServerCommand = 'gatsby develop'; result.devServerPort = 8000; }
    }

    // 3. Find entry point
    result.entryPoint = this.findEntryPoint(workspacePath, result);

    // 4. Resolve final entry — file path for static, URL for dev-server
    if (result.type === 'static' && result.entryPoint) {
      result.resolvedEntry = path.resolve(workspacePath, result.entryPoint);
    } else if (result.type === 'dev-server' && result.devServerPort) {
      result.resolvedEntry = `http://localhost:${result.devServerPort}`;
    }

    return result;
  }

  private findEntryPoint(ws: string, info: TechStackInfo): string | null {
    // Framework-specific entry points
    if (info.framework === 'next.js') return 'pages/index.tsx'; // not directly usable, dev server needed
    if (info.framework === 'nuxt') return 'pages/index.vue';

    // Common static entry names
    const candidates = ['index.html', 'build/index.html', 'dist/index.html', '.output/public/index.html',
      'public/index.html', 'src/index.html', 'app/index.html', 'out/index.html'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(ws, c))) return c;
    }

    // Deep search for index.html (one level)
    try {
      const files = fs.readdirSync(ws);
      for (const f of files) {
        const fp = path.join(ws, f);
        if (fs.statSync(fp).isDirectory() && !f.startsWith('.') && f !== 'node_modules') {
          const indexPath = path.join(fp, 'index.html');
          if (fs.existsSync(indexPath)) return path.join(f, 'index.html');
        }
      }
    } catch (e) {}

    // Last resort: look for any .html file
    try {
      const htmls = this.findFiles(ws, '.html', 1);
      if (htmls.length > 0) return htmls[0];
    } catch (e) {}

    return null;
  }

  private findFiles(dir: string, ext: string, maxDepth: number): string[] {
    const results: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > maxDepth) return;
      try {
        const files = fs.readdirSync(d);
        for (const f of files) {
          const fp = path.join(d, f);
          if (f.startsWith('.') || f === 'node_modules') continue;
          try {
            if (fs.statSync(fp).isDirectory()) {
              walk(fp, depth + 1);
            } else if (f.endsWith(ext)) {
              results.push(path.relative(dir, fp));
            }
          } catch (e) {}
        }
      } catch (e) {}
    };
    walk(dir, 0);
    return results;
  }

  private packageManagerCmd(pm: string | null): string {
    if (pm === 'pnpm') return 'pnpm';
    if (pm === 'yarn') return 'yarn';
    if (pm === 'bun') return 'bun';
    return 'npm';
  }
}
