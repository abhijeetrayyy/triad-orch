# Triad Engine — Comprehensive Analysis

## Table of Contents
1. [Critical Bugs](#1-critical-bugs)
2. [Architecture Gaps](#2-architecture-gaps)
3. [Missing Features](#3-missing-features)
4. [Code Quality Issues](#4-code-quality-issues)
5. [Security Concerns](#5-security-concerns)
6. [Priority Action Items](#6-priority-action-items)

---

## 1. Critical Bugs

### 1.1 Infinite Loop When Status Is `completed`/`failed`

**File:** `src/main.ts:57-60` + `src/core/orchestrator.ts:112-114`

The `tick()` method returns early when status is `completed` or `failed` (`orchestrator.ts:122-125`), but the while loop in `main.ts` keeps calling it every 2 seconds forever. There is **no break condition** in the main loop.

**Evidence:** The `triad-evolution` log shows ~100 consecutive identical entries:
```
[4:57:20 am] --- Tick 2 [Status: completed] ---
[4:57:20 am] Process finished with status: completed
```
repeating endlessly until the process is manually killed.

**Same issue with `max_loops`:** When `loop_count >= max_loops` (`orchestrator.ts:112-114`), tick returns but the while loop continues calling it forever.

### 1.2 Migration Command Doesn't Migrate Tasks

**File:** `src/main.ts:11-29`

The `migrate` command only migrates project-level data (name, intent, status, prompts). It **does not migrate tasks or logs** from the file-based `ledger.json` files. After migration, the database has project records but zero task data.

### 1.3 Rate Limit Handling Destroys Task Progress

**File:** `src/core/orchestrator.ts:134-138`

When a rate limit is hit, the current task is set to `failed` but its `retry_count` is NOT incremented. The task gets re-picked on next tick, hits rate limit again, and this loops until `max_loops` is exhausted. Meanwhile `loop_count` increments on every iteration, burning through the budget.

**Evidence:** The triad-evolution log shows 8 consecutive rate limits in a single tick for 8 separate tasks — each task failed without a single retry.

### 1.4 Fragile JSON Parsing — Architect Response

**File:** `src/core/orchestrator.ts:163`

```typescript
const tasks: string[] = JSON.parse(response.match(/\[.*\]/s)![0]);
```

- If the regex doesn't match (model returns unexpected format), this **crashes with a TypeError** (cannot read property of null).
- If the model wraps JSON in markdown code blocks, the regex won't match.
- The `!` non-null assertion bypasses TypeScript checking but will throw at runtime.

### 1.5 Fragile JSON Parsing — Builder Response

**File:** `src/core/orchestrator.ts:203`

```typescript
const toolCall: ToolCall = JSON.parse(response.match(/\{.*\}/s)![0]);
```

Same issues as the Architect parsing:
- Won't match JSON inside markdown code blocks (e.g., `\`\`\`json\n{...}\n\`\`\``).
- Will crash if model returns unexpected text.

### 1.6 Stuck Tasks in `awaiting_audit` Lead to Silent Replan

**File:** `src/core/orchestrator.ts:172-179`

If the API call to the Auditor fails (not a FAIL response, but a network error), the task stays in `awaiting_audit` state. On the next tick:
1. `handleExecution()` finds no `pending` or `failed` tasks.
2. Not all tasks are `completed` (some are `awaiting_audit`).
3. Sets status to `idle`.
4. Next tick calls `handlePlanning()` which **clears all tasks** (`db.clearTasks()`) and generates a brand new plan.
5. All prior work is silently discarded.

### 1.7 State Machine Doesn't Handle `planning` Status

**File:** `src/core/orchestrator.ts:118-126`

The `Ledger.status` type includes `'planning'` (`src/core/types.ts:14`) but the `tick()` switch statement only handles `idle`, `executing`, `auditing`, `completed`, `failed`. If status is ever set to `planning`, the switch falls through without incrementing `loop_count` or calling `saveState()` — the engine becomes inert.

### 1.8 `loop_count` Not Persisted Across Restarts

**File:** `src/core/orchestrator.ts:43`

`this.ledger.loop_count` is initialized to 0 in the constructor and is **never loaded from the database**. If the engine process is killed and restarted, `loop_count` resets to 0, potentially exceeding `max_loops` over multiple restarts.

### 1.9 `SharedMemory` Keyword Matching Is Inverted

**File:** `src/core/memory.ts:35`

```typescript
const relevant = memory.filter(m => query.toLowerCase().includes(m.task.toLowerCase()));
```

This checks if the user's intent (`query`) contains the entire previous task description as a substring — which is almost never true. The logic should be reversed: check if the task description contains keywords from the query. As a result, `getRelevantLessons()` **always returns an empty string**, making global memory useless.

### 1.10 Playwright Browser Launch for Non-Existent Files

**File:** `src/core/visual-bridge.ts:12-30`

`captureScreenshot()` launches a full Chromium browser instance before checking if the HTML file exists. If the file doesn't exist, Playwright navigates to `file://...` which fails, the error is silently caught (`orchestrator.ts:233`), but the browser was already launched and closed. This wastes ~500ms+ on every audit cycle for non-HTML tasks.

---

## 2. Architecture Gaps

### 2.1 No Graceful Shutdown

**Files:** `src/main.ts`, `src/core/orchestrator.ts`

- **No SIGINT/SIGTERM handler.** If the user presses Ctrl+C, the engine dies immediately without saving state.
- **No engine stop mechanism.** The `main.ts` while loop has no way to exit cleanly. The only option is killing the process.

### 2.2 No Concurrency Control / Project Locking

**File:** `desktop/main.js:40-46`

The Electron app can launch the engine for the same project multiple times. There's no:
- Project-level lock file or DB flag.
- Prevention of duplicate sessions.
- Mechanism to detect a running session.

This leads to data races where two engine instances write to the same DB and workspace simultaneously.

### 2.3 Electron Terminal Spawning Uses `exec()` Instead of `node-pty`

**File:** `desktop/main.js:5,36`

`node-pty` is imported (line 5) but **never used**. The code uses `exec()` + Windows `start` command instead. `node-pty` would provide:
- Direct PTY integration in the Electron window.
- Real-time stdout/stderr capture without OS terminal windows.
- Cross-platform terminal management.

### 2.4 No Workspace File Versioning

**Files:** `src/core/orchestrator.ts`, `src/core/tools.ts`

The `files_impacted` array accumulates filenames but there's no diff/change tracking. The engine cannot:
- See what changed between ticks.
- Roll back to a previous state.
- Detect regressions in existing files.

### 2.5 Single-File Logging Per Session — No Rotation

**File:** `src/core/orchestrator.ts:36-38`

Logs are appended to a single file per session. For long-running projects (1000+ ticks), this file grows unbounded. No log rotation, truncation, or size limits.

### 2.6 No Task Dependency Graph

**File:** `src/core/types.ts`

Tasks are a flat queue with no dependency ordering. If Task A (setup HTML) fails but Task B (add CSS) runs first, it may write to a non-existent HTML file. The engine relies on the Architect ordering tasks correctly in the initial plan, with no runtime dependency checking.

### 2.7 Database Schema Lacks `files_impacted` Column

**File:** `src/core/database.ts:27-37`

The `tasks` table doesn't have a `files_impacted` column or a separate junction table. The `files_impacted` field from `Task` objects is saved to SQL via `saveTask()` (`database.ts:83-88`) but the column doesn't exist in the schema — it's silently dropped by the ORM.

### 2.8 No Project Delete from Database

**File:** `desktop/main.js:82-89`

The `delete-project` IPC handler only removes the project folder from disk. It does **not** delete the project from the SQLite database (`triad_vault.db`), leaving orphaned records.

---

## 3. Missing Features

### 3.1 API Key Validation at Startup

**File:** `src/core/model-provider.ts:36`

The engine only checks for API key existence when the first API call is made. If keys are missing/invalid, the error is opaque and caught by the generic error handler. There should be a health-check endpoint or startup validation.

### 3.2 No Engine Status Feedback to Dashboard

**File:** `src/core/orchestrator.ts:60-61`

The `broadcast()` method silently catches all errors (`catch (e) {}`). If the dashboard server is down, the engine silently proceeds with no feedback. There's no reconnect logic from the engine side.

### 3.3 Dashboard Log Feed Is Not Cleared on Project Switch

**File:** `dashboard.html:266-272`

When switching projects, the log feed (`#log-feed`) is not cleared. Old logs from the previous project remain visible alongside new ones until the page is refreshed.

### 3.4 Dashboard Uses `alert()` for Save Confirmation

**File:** `dashboard.html:232`

`alert('Intelligence Commited.')` blocks the UI. Should be a non-blocking toast/notification.

### 3.5 No `.env` Template Validation

**File:** `.env`

The engine doesn't validate that all required environment variables are set. If a variable is missing, the error only surfaces at API call time with a generic "API Key missing" error.

### 3.6 No Concurrent Task Execution

**File:** `src/core/orchestrator.ts:170-218`

The engine processes one task per tick, with a 2-second delay between ticks. For a project with 50 tasks, at minimum that's 100 seconds of wall time (not counting API latency which adds 5-60s per task). There's no option for parallel task execution.

### 3.7 Builder Has No Context of Previous Tasks

**File:** `src/core/orchestrator.ts:193-198`

The Builder prompt includes the project file map and the current task description, but not the results of previous tasks. If Task A writes `index.html` and Task B modifies it, the Builder for Task B doesn't know what Task A wrote (unless it uses `read_file`).

### 3.8 No Built-in Log Viewer in Desktop App

**File:** `desktop/main.js`

The Desktop app launches engine sessions in external OS terminal windows. There's no integrated log viewer within the Electron window to see real-time engine output alongside the dashboard.

---

## 4. Code Quality Issues

### 4.1 Hardcoded Paths

| Location | Path | Issue |
|----------|------|-------|
| `src/core/model-provider.ts:8` | `C:/.opencode/opencode.json` | Windows-specific, won't work on macOS/Linux |
| `src/core/orchestrator.ts:61` | `http://localhost:4002` | Hardcoded port, no config |
| `dashboard.html:139` | `http://localhost:4002/api` | Same, hardcoded |
| `src/server/dashboard-api.ts` | Port `4002` | Hardcoded |

### 4.2 Widespread `any` Types

**Files:** `src/core/database.ts`, `src/core/orchestrator.ts`, `src/server/dashboard-api.ts`

`database.ts` uses `any` for all method parameters and return types. `orchestrator.ts` uses `any` for error catching. This defeats TypeScript's type safety.

### 4.3 `callModel` Uses `as any` Cast

**File:** `src/core/orchestrator.ts:157,160,200,240`

```typescript
await callModel(Models.ARCHITECT_PRIMARY.provider as any, ...)
```

The `provider` parameter is typed as `keyof typeof PROVIDERS` but the Models config stores it as a string. Every call site uses `as any` to bypass the type system.

### 4.4 `run_command` Incorrectly Returns `stdout || stderr`

**File:** `src/core/tools.ts:53`

```typescript
return stdout || stderr || "Command executed with no output.";
```

If stdout is empty but stderr has content, only stderr is returned — even if stderr contains warnings (not errors). If both have content, stderr is silently discarded. Should be `stdout + stderr`.

### 4.5 Inconsistent Path Resolution

**File:** `src/main.ts:13` uses `path.join(__dirname, '../projects')`
**File:** `src/core/orchestrator.ts:36` uses `path.join(process.cwd(), 'projects', projectName, 'logs')`
**File:** `src/core/database.ts:5` uses `process.cwd()`

Some modules use `__dirname`, others use `process.cwd()`. When running via `ts-node`, `__dirname` is the source directory. When running via the compiled version, it's the `dist` directory. This leads to inconsistent path resolution depending on how the engine is launched.

### 4.6 Dashboard Uses `require('electron')` in Renderer

**File:** `dashboard.html:138`

```javascript
const { ipcRenderer } = require('electron');
```

This works because `nodeIntegration: true` and `contextIsolation: false` are set in `desktop/main.js:17-18`, but this is a security anti-pattern. Modern Electron apps use preload scripts and contextBridge.

### 4.7 All API Keys Hardcoded in Model Config

**File:** `src/core/model-provider.ts:70-74`

Model names and providers are hardcoded. There's no way to configure different models per project or swap providers without editing source code.

### 4.8 No Input Validation on Dashboard Modals

**File:** `dashboard.html:285-293`

The `launchNew()` function checks `if(!n || !i) return;` but doesn't sanitize or validate project names. A project name with special characters could cause issues with file system operations or terminal commands.

---

## 5. Security Concerns

### 5.1 Live API Keys Committed to Repository

**File:** `.env`

The `.env` file contains 3 live API keys:
- OpenRouter: `sk-or-v1-...`
- OpenCode: `sk-FbsNf...`
- DeepSeek: `sk-07b7...`

These are committed to the project directory (not in `.gitignore` based on directory structure).

### 5.2 Dangerous `exec()` Calls with User Input

**File:** `desktop/main.js:36,54,61,68`

```javascript
const command = `start /min "${windowTitle}" cmd /k "npx ts-node src/main.ts start ${name} \\"${intent}\\""`;
```

The project `name` and `intent` are inserted directly into shell commands. If a user creates a project named `foo & rm -rf /`, it would be executed. Similarly, the `focus-session` handler injects the window title into a PowerShell command.

### 5.3 `nodeIntegration: true` with `contextIsolation: false`

**File:** `desktop/main.js:17-18`

This configuration allows the renderer process full access to Node.js APIs. Any XSS vulnerability in the dashboard could lead to full system compromise.

### 5.4 Nuclear Kill Uses `taskkill /F`

**File:** `desktop/main.js:68`

```javascript
exec(`taskkill /F /FI "WINDOWTITLE eq TRIAD_SESSION_${name}_*" /T`);
```

This forcefully kills all processes whose window title contains the project name. A project name like `_*" /F /T` could lead to unintended process termination.

---

## 6. Priority Action Items

### P0 — CRITICAL (Will Crash or Lose Data)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | Infinite loop on `completed`/`failed` | `main.ts:57-60` | Break the while loop when tick returns or status is terminal |
| 2 | Loop never stops on `max_loops` | `orchestrator.ts:112-114` | Set status to `completed` and break the while loop |
| 3 | Fragile JSON parsing crashes engine | `orchestrator.ts:163,203` | Use robust regex + try/catch with markdown code block handling |
| 4 | Rate limit waste loops | `orchestrator.ts:134-138` | Increment retry_count AND implement backoff instead of direct fail |
| 5 | `awaiting_audit` tasks trigger silent replan | `orchestrator.ts:172-179` | Handle `awaiting_audit` state in tick loop and retry audit |
| 6 | DB not cleaned on project delete | `desktop/main.js:82-89` | Add `db.deleteProject()` call alongside folder deletion |

### P1 — HIGH (Major Feature Gaps)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 7 | No graceful shutdown / state save on exit | `main.ts` | Add `process.on('SIGINT')` handler to call `saveState()` |
| 8 | `SharedMemory` keyword matching broken | `memory.ts:35` | Reverse the comparison logic |
| 9 | `loop_count` not persisted | `orchestrator.ts:43` | Load `loop_count` from DB in constructor |
| 10 | No concurrency control | `desktop/main.js:40-46` | Add DB-level project lock or running flag |
| 11 | Migration doesn't migrate tasks | `main.ts:11-29` | Add task and log migration from file-based ledgers |
| 12 | No `planning` state handler | `orchestrator.ts:118-126` | Add `case 'planning'` or remove from type |

### P2 — MEDIUM (Improvements)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 13 | `node-pty` imported but unused | `desktop/main.js:5` | Use `node-pty` for integrated terminal instead of OS windows |
| 14 | `files_impacted` not in DB schema | `database.ts:27-37` | Add column or junction table |
| 15 | Inconsistent path resolution | multiple files | Standardize on `process.cwd()` or `__dirname` |
| 16 | `run_command` return logic wrong | `tools.ts:53` | Return `stdout + stderr` |
| 17 | No API key validation at startup | `model-provider.ts` | Add startup health check for all configured providers |
| 18 | Dashboard log feed not cleared on project switch | `dashboard.html:266-272` | Clear `#log-feed` on `selectProject()` |
| 19 | `any` types throughout database layer | `database.ts` | Add proper TypeScript interfaces |

### P3 — LOW (Nice to Have)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 20 | Hardcoded localhost:4002 | multiple files | Make configurable via `.env` |
| 21 | `alert()` in dashboard | `dashboard.html:232` | Replace with non-blocking toast |
| 22 | No log rotation | `orchestrator.ts:36-38` | Implement size-based log rotation |
| 23 | No task dependency graph | `types.ts` | Add `depends_on` field to Task |
| 24 | Consecutive Builder tasks have no context chain | `orchestrator.ts:193-198` | Pass previous task results in prompt |
| 25 | `contextIsolation: false` security risk | `desktop/main.js:17-18` | Use preload script with `contextBridge` |
| 26 | Sanitize user input in shell commands | `desktop/main.js:36,54,68` | Validate/escape project names and intents |

---

---

## 7. Runtime Architecture — How Everything Starts and Runs

### Process Topology

```
  start.bat (one-click)
       |
       v
  npm start  →  Electron (desktop/main.js)
       |                |
       |          [auto-starts API Server]
       |                |
       |          waits for HTTP 200 on :4002
       |                |
       v                v
  +----------------+---------------------------+
  |  API Server    |  Electron Desktop         |
  |  (Express+WS)  |  (dashboard.html UI)      |
  |  port 4002     |  (preload.js bridge)      |
  +----------------+---------------------------+
       |                       ^
       |  HTTP / WebSocket     | IPC (contextBridge)
       v                       |
  +----------------+           |
  |  Engine(s)     |---------->|  node-pty sessions
  |  (child PTY)   |  live     |  per project
  |  src/main.ts   |  output   |
  +----------------+           |
       |                       |
       v                       v
  +----------------+---------------------------+
  |  SQLite Vault  |  projects/ workspace     |
  |  triad_vault.db|  logs/                   |
  +----------------+---------------------------+
```

### Startup Sequence (One Click)

1. **`start.bat`** or **`npm start`** is invoked
2. Electron main process (`desktop/main.js`) starts
3. Main process **auto-spawns** the API server as a child process (`npx ts-node src/server/dashboard-api.ts`)
4. Main process polls `http://localhost:4002/api/projects` every 500ms (up to 30 attempts) waiting for the server to be ready
5. Once ready (or timeout), the Electron window loads `dashboard.html`
6. Dashboard connects via WebSocket to `ws://localhost:4002` and fetches project list via REST API
7. User creates a project → `Launch Engine` → Electron spawns a `node-pty` session running `npx ts-node src/main.ts start <project> "<intent>"`
8. Engine output is piped live via IPC → renderer → displayed in the log feed
9. On app close: all PTY sessions killed, API server killed, everything cleans up

### What Runs and What Depends on What

| Component | How Started | Depends On | Port |
|-----------|------------|------------|------|
| Electron Desktop | `npm start` or `start.bat` | nothing | - |
| API Server | auto-started by Electron as child process | nothing | 4002 |
| SQLite DB | created automatically by `database.ts` constructor | nothing | - |
| Engine Sessions | spawned per-project by Electron (node-pty) | API Server (:4002), DB | - |
| Dashboard UI | loaded by Electron from `dashboard.html` | API Server (:4002) for data | - |

### One-Click Launch Methods

| Method | Command | What It Does |
|--------|---------|-------------|
| Start Menu / Desktop | `start.bat` | Installs deps, migrates DB, starts desktop (auto-starts API) |
| npm | `npm start` | Shorthand for `npm run desktop` (auto-starts API internally) |
| npm | `npm run desktop` | Launches Electron only (useful if server is already running) |
| npm | `npm run server` | Starts API server only (for debugging / standalone) |

### File Locations After Fixes

- `desktop/main.js` — Electron main process: auto-starts API, manages PTY sessions, health check
- `desktop/preload.js` — Secure context bridge exposing `electronAPI` to renderer
- `dashboard.html` — Frontend UI (loaded by Electron)
- `src/server/dashboard-api.ts` — Express + WebSocket API (port 4002)
- `src/core/database.ts` — SQLite DB (auto-creates schema on first load)
- `start.bat` — One-click launcher for Windows

---

## Fix Status — All P0 and P1 items resolved

All 12 P0-P1 critical issues have been fixed across these files:

| File | Fixes Applied |
|------|---------------|
| `src/main.ts` | SIGINT/SIGTERM graceful shutdown, break loop on terminal status, migration now migrates tasks + logs, standardised path resolution |
| `src/core/orchestrator.ts` | `tick()` returns `boolean` to signal stop; status checks at top; `completed`/`failed`/`max_loops` all stop loop; `planning` state handled; `awaiting_audit` tasks no longer trigger replan; robust `extractJsonArray`/`extractJsonObject` parsers with markdown code block support; rate limit increments `retry_count`; `loop_count` loaded from DB; `files_impacted` persisted |
| `src/core/database.ts` | Added `files_impacted` column to tasks, `loop_count` to projects, `deleteProject()` method, `ON DELETE CASCADE`, proper TypeScript interfaces for all DB rows, WAL mode for concurrency |
| `src/core/memory.ts` | Keyword matching now splits query into words >3 chars and checks if any match task descriptions (reversed logic) |
| `src/core/tools.ts` | `run_command` now returns `stdout + stderr` combined instead of `stdout \|\| stderr` |
| `src/core/model-provider.ts` | Added `validateApiKeys()` startup health check function |
| `src/server/dashboard-api.ts` | Added `GET /api/projects/:name/delete` endpoint, updated to use `getLogSessions` |
| `dashboard.html` | Replaced `alert()` with toast notification; log feed cleared on project switch; switched from `ipcRenderer` to `electronAPI` bridge; API URL now derived dynamically |
| `desktop/main.js` | **Rewrite**: auto-starts API server as child process; health check before loading UI; pipes PTY engine output to renderer via IPC; kills all processes on quit; `sanitizeShellArg()` for all inputs; DB cleanup on project delete; `before-quit` cleanup |
| `desktop/preload.js` | **New file** — secure context bridge exposing `electronAPI` with `onEngineOutput`, `getEngineOutput`, `startProject`, `stopProject`, `deleteProject`, etc. |
| `dashboard.html` | API URL fixed for Electron `file://` protocol; toast instead of `alert()`; log feed cleared on project switch; switched from `ipcRenderer` to `electronAPI` bridge |
| `package.json` | `npm start` now launches desktop (auto-starts API); `postinstall` installs Playwright Chromium; `main` points to desktop/main.js |
| `start.bat` | **New file** — one-click Windows launcher: installs deps, runs DB migration, starts Electron |

### Runtime Startup Flow Fixed

| Before | After |
|--------|-------|
| `npm run start-all` ran server + desktop concurrently with no ordering | `npm start` runs desktop which auto-starts API server and waits for health check |
| Electron loaded dashboard.html immediately — server might not be ready | Electron polls `:4002/api/projects` up to 30×500ms before loading UI |
| Engine sessions launched as hidden OS terminal windows via `exec(start)` | Engine sessions spawned as `node-pty` processes, output piped to renderer |
| No cleanup on quit — orphan processes left behind | `before-quit` kills all PTY sessions + API server |
| Dashboard `API` URL broke in Electron (`file://` protocol) | Detects `file:` protocol and hardcodes `http://localhost:4002/api` |
| `node-pty` imported but never used | PTY processes managed with output capture and live IPC streaming |

**TypeScript:** Compiles with zero errors (`npx tsc --noEmit`).
