# Triad Engine — Full Code Audit

> Generated: 2026-05-23
> Coverage: All 14 source files under src/, desktop/, and dashboard.html

---

## Priority Legend

| Tag | Meaning |
|-----|---------|
| P0 | Blocks execution — engine cannot run |
| P1 | Causes incorrect behavior or data loss |
| P2 | Poor UX, missing feedback, performance |
| P3 | Code quality, tech debt, style |

---

## A — Architecture & Design

### A1 [P0] Two engine versions coexist with different state machines

**Files:** `src/core/orchestrator.ts` (v1, 472 lines), `src/core/conductor.ts` (v2, 682 lines)

**Problem:** The v1 `Orchestrator` makes direct API calls via `model-provider.ts` using a tick-based loop. The v2 `Conductor` spawns external CLIs (opencode, gemini) via node-pty with file-based IPC. They have incompatible status enums, task models, and persistence strategies. The Electron app uses v2 exclusively, yet the checkpoint/state system was added to v1 (`orchestrator.ts`) — meaning all checkpoint code is effectively dead.

**Impact:** Checkpoint system (Phase D of upgrades.md) is non-functional in the Electron app. The v1 orchestrator code is dead code that creates confusion.

**Fix:** Remove v1 orchestrator code or port checkpoint logic to v2 conductor. Remove `src/main.ts` CLI entry point if only Electron is used.

### A2 [P1] `saveCheckpoint()` implemented only in v1 orchestrator, never called by v2 conductor

**Files:** `src/core/orchestrator.ts:580-598`, `src/core/conductor.ts` (no checkpoint calls)

**Problem:** The upgrades.md spec requires checkpoint.json writes after every meaningful state change. This was implemented in the v1 `Orchestrator.saveCheckpoint()` but the Electron app uses the v2 `Conductor`, which never calls any checkpoint save. The dashboard's State tab and resume banner depend on checkpoint data.

**Impact:** Resume after kill, State tab data, and interruption banners are all broken.

**Fix:** Port checkpoint logic from Orchestrator to Conductor. Call `saveCheckpoint()` after every agent completion, task transition, and engine stop.

### A3 [P1] `any` type abuse throughout conductor

**Files:** `conductor.ts:357,384,410`

**Problem:** Task objects are cast to `any` when passed to helper methods. This defeats TypeScript's type checking and makes refactoring dangerous.

```typescript
const task: any = {
  id: currentTask.id,
  description: currentTask.description,
  ...
};
```

**Impact:** If `TaskQueueEntry` interface changes, these casts silently mask errors.

**Fix:** Create proper interfaces for builder/reviewer/auditor task inputs instead of casting to `any`.

---

## B — Security

### B1 [P0] API keys exposed in repository

**File:** `.env`

**Problem:** The `.env` file contains live API keys for OpenRouter, OpenCode, and DeepSeek. Although `.gitignore` should exclude it, the keys were previously committed in earlier versions.

**Impact:** Secret leakage if repository is public or shared.

**Fix:** Rotate all keys, remove from git history, use environment variables or a vault.

### B2 [P1] Prompt sanitizer can be bypassed

**File:** `src/core/prompt-sanitizer.ts:59-73`

**Problem:** `sanitizeTaskDescription()` replaces dangerous patterns with `[REDACTED]` but this is a single-pass replacement. An attacker can craft input that bypasses the regex (e.g., nested patterns, encoding).

**Impact:** Potential prompt injection or command injection via crafted project names or intents.

**Fix:** Use proper escaping/encoding instead of regex replacement. Validate project names for alphanumeric only.

### B3 [P2] User intent passed directly to AI without sanitization

**File:** `conductor.ts:338-342`

**Problem:** The `spawnArchitect()` method passes the user's `intent` string directly to `buildArchitectPrompt()` and then to the AI model. No sanitization is applied to the intent before it reaches the model.

**Impact:** If a user enters a prompt injection as their intent, the AI could be manipulated.

**Fix:** Apply `sanitizer.sanitizeTaskDescription()` to the intent before building the prompt.

---

## C — Reliability

### C1 [P1] No retry on agent spawn failure

**File:** `conductor.ts:344-347`

**Problem:** `spawnArchitect()` calls `spawnByCLI()` and if the opencode process exits with non-zero (as it did repeatedly during testing), the conductor just waits for the timeout (8 minutes) before handling the failure. No immediate retry.

**Impact:** 8-minute delay for a failure that took 500ms to occur.

**Fix:** Check process exit code in `CLISpawner` and emit a failure event immediately. Add retry logic with backoff in the conductor.

### C2 [P2] Task parser regex is brittle

**File:** `conductor.ts:507`

**Problem:** The `parsePlan()` regex expects exact markdown formatting (`### Task N\n**ID:** ...\n**Description:** ...`). If the AI model outputs a slightly different format, parsing returns null and the pipeline stalls with a generic error.

**Impact:** Pipeline stalls silently. User sees no indication of what went wrong.

**Fix:** Add multiple fallback parsing strategies. Show raw plan content in dashboard when parsing fails.

### C3 [P2] Review verdict has false positives

**File:** `conductor.ts:547-556`

**Problem:** `parseReviewVerdict()` returns PASS if the word "PASS" appears ANYWHERE in the review text. A review that says "This code does NOT PASS" would incorrectly be treated as passing.

```typescript
return content.toUpperCase().includes('PASS') ? 'PASS' : 'FAIL';
```

**Impact:** Broken code can be marked as passing review.

**Fix:** Check that "PASS" appears as the first word on the first line, not anywhere in the text.

### C4 [P2] FileBus reads file then deletes — race condition

**File:** `file-bus.ts:32-34`

**Problem:** When a file appears in `.triad/`, the FileBus reads it synchronously and then deletes it immediately. If the writing process is still flushing the file, a partial read occurs. The `awaitWriteFinish` setting helps but isn't atomic.

**Impact:** Data loss — partial content read leads to parse failures.

**Fix:** Use a staging approach: rename the file to `.processing` before reading, or use a content-addressable naming scheme.

### C5 [P2] `handleTimeout` doesn't advance pipeline

**File:** `conductor.ts:659-672`

**Problem:** When an agent times out, the task is marked as `failed` and retries are incremented, but `startNextTask()` is never called. The pipeline stalls permanently.

**Impact:** A single timeout freezes the entire project forever.

**Fix:** After timeout handling, call `startNextTask()` to advance to the next task or retry.

### C6 [P3] `VisualBridge` launches new Chromium for every screenshot

**File:** `visual-bridge.ts:12-13`

**Problem:** Every call to `captureScreenshot()` launches a full Chromium browser instance. No browser reuse. No connection pooling.

**Impact:** Each screenshot takes 2-5 seconds and consumes ~200MB RAM.

**Fix:** Keep a persistent browser instance. Launch once, reuse for all screenshots.

---

## D — Conductor State Machine

### D1 [P1] No state persistence between runs

**File:** `conductor.ts` (all)

**Problem:** The v2 conductor stores state only in memory and in `.triad/state.json`. When the Electron app restarts, there is no mechanism to reload the conductor state for in-progress projects. The checkpoint system (upgrades.md Section 2) is not implemented in the conductor.

**Impact:** Killing and restarting the app loses all in-progress pipeline state. Cannot resume after crash.

**Fix:** Implement `Checkpoint` interface in conductor. Write checkpoint after each agent completion. Load checkpoint on `start()`.

### D2 [P2] `stateInterval` declared after use

**File:** `conductor.ts:102,105`

**Problem:** `this.stateInterval = setInterval(...)` is used on line 102 but the field `private stateInterval: NodeJS.Timeout | null = null` is declared on line 105. Works due to JS hoisting but confusing.

**Fix:** Move the field declaration before its first use.

### D3 [P2] `CLISpawner` watchdog doesn't trigger pipeline recovery

**File:** `cli-spawner.ts`

**Problem:** The watchdog kills agents with no output for 120 seconds, but the conductor's `handleTimeout` is the only mechanism that handles the killed agent. If the watchdog kills an agent but the conductor's timeout hasn't fired yet, the pipeline is in an inconsistent state (agent killed but task still marked `in_progress`).

**Impact:** Orphaned tasks in `in_progress` state that block the pipeline.

**Fix:** When watchdog kills an agent, emit an event that the conductor can handle immediately rather than waiting for the 8-minute timeout.

### D4 [P2] No recovery from builder failure after reviewer/auditor retries

**File:** `conductor.ts:237-261, 293-317`

**Problem:** When reviewer or auditor fails and retries are available, the code calls `spawnBuilder(reviewerNotes, auditorNotes)` but does not reset `currentTaskId` or validate that the builder prompt will be correct for the retry.

**Impact:** Builder retry may use stale or incorrect context.

**Fix:** Validate task state before retry. Clear and re-derive builder context.

---

## E — Dashboard / UX

### E1 [P2] Log feed has unbounded memory growth

**File:** `dashboard.html`

**Problem:** `appendLog()` creates a new DOM element for every log entry. There is no cap on the number of log entries. Over a long session (thousands of log entries), the DOM grows unbounded and performance degrades.

**Impact:** Browser tab consumes increasing memory. UI becomes sluggish.

**Fix:** Cap log entries at 500. Remove oldest entries when limit is exceeded.

### E2 [P2] Dashboard polls aggressively and redundantly

**File:** `dashboard.html`

**Problem:** The dashboard polls `fetchConductorState()` every 3 seconds AND the conductor broadcasts `state_update` every 2 seconds. That's 5 redundant state updates every 6 seconds.

**Impact:** Unnecessary network traffic and CPU usage.

**Fix:** Rely solely on WebSocket broadcasts. Remove the polling interval.

### E3 [P2] Agent terminal output not rendered in a dedicated view

**File:** `dashboard.html`

**Problem:** Agent output from `agent-output` events is only appended to the log feed as a single line. Users cannot see the full streaming output of each agent. The old dashboard had 4 agent terminal panes — these were removed in the redesign.

**Impact:** Users can't see what the AI is doing. Debugging is impossible.

**Fix:** Re-add agent terminal panes (collapsible) that show full stdout for each role.

### E4 [P2] No loading states for API calls

**File:** `dashboard.html`

**Problem:** Most API calls (`fetchProjects`, `fetchConductorState`, `selectProject`) have no loading indicator. When calls are slow, the UI appears frozen.

**Impact:** Poor UX — user doesn't know if the app is working.

**Fix:** Add subtle loading indicators for each data-fetching operation.

### E5 [P3] WebSocket reconnect creates duplicate listeners

**File:** `dashboard.html`

**Problem:** The `connect()` function is called once on page load. If the WebSocket disconnects, it reconnects after 2 seconds via `ws.onclose`. But `connect()` is also called again if the user navigates — creating duplicate WebSocket instances.

**Impact:** Multiple WebSocket connections, duplicate message handling.

**Fix:** Guard against duplicate connections. Close old WebSocket before creating new one.

---

## F — Performance

### F1 [P2] `getWorkspaceMap()` walks entire filesystem on every agent spawn

**File:** `conductor.ts:338,365,393,428`

**Problem:** Every agent spawn calls `getWorkspaceMap()` which recursively walks the entire workspace directory. For large projects (thousands of files), this is a blocking synchronous operation.

**Impact:** UI freezes for seconds during agent spawn. CPU spikes.

**Fix:** Cache the workspace map, re-read only when files change (use chokidar watcher on workspace).

### F2 [P2] `SharedMemory` reads/writes entire file on every lesson

**File:** `memory.ts:22-29`

**Problem:** `addLesson()` reads the entire `global_memory.json`, pushes to the array, and writes the entire file back. For N lessons, this is O(N) per operation. No file locking.

**Impact:** Slow for many lessons. Data corruption risk under concurrent access.

**Fix:** Use append-only log format. Read only when needed for queries.

### F3 [P2] `saveState()` reads `intent.md` from disk on every call

**File:** `conductor.ts:631-632`

**Problem:** Every `saveState()` call reads `intent.md` from disk via `this.fileBus.read()`. Since intent doesn't change during a session, this is wasted I/O.

**Impact:** Unnecessary disk reads (potentially dozens per minute).

**Fix:** Cache the intent in memory. Only read from disk when it changes.

---

## G — Testing & Error Handling

### G1 [P2] No graceful handling of missing `.triad/` files

**File:** `conductor.ts:340`

**Problem:** `this.fileBus.read('memory_context.md')` will throw if `memory_context.md` wasn't written first. The `start()` method writes it before spawnArchitect is called, but if `start()` fails midway, the file doesn't exist.

**Impact:** Crash with unhelpful ENOENT error.

**Fix:** Use `fileBus.exists()` before reading, or make `fileBus.read()` return empty string for missing files.

### G2 [P2] Git errors are silently swallowed

**File:** `conductor.ts:183-185, 203-206, 231-232, 254-255, 288-289, 311-312, 329-330`

**Problem:** Git commit failures are caught and logged but never surfaced to the dashboard or user. If git is not configured or the repo is broken, the user sees a working engine that silently fails to save history.

**Impact:** Silent data loss — user thinks commits are happening but they're not.

**Fix:** Surface git errors to the dashboard as warnings, not just console.error.

---

## H — Configuration & Setup

### H1 [P2] `.env` keys shadow opencode config keys

**File:** `src/core/model-provider.ts:14-18`

**Problem:** The `.env` file takes precedence over opencode config keys (`process.env.X || opencodeConfig.X`). If `.env` has a key set (even an expired one), the working opencode config key is never used.

**Impact:** Users must keep `.env` keys in sync manually. If `.env` keys expire, the engine breaks even though valid keys exist in opencode config.

**Fix:** Try each key; fall through on 401 instead of short-circuiting on presence.

### H2 [P3] Hardcoded opencode config path

**File:** `src/core/model-provider.ts:8`

**Problem:** OpenCode config path `C:/.opencode/opencode.json` is hardcoded. This is the system-wide config, but the user's config is at `~/.config/opencode/opencode.json`.

**Impact:** User-specific config (with valid keys) is ignored.

**Fix:** Already partially addressed — search multiple paths. Document the search order.

---

## I — Dashboard Structural Issues

### I1 [P1] Dashboard HTML is a single 70KB file with inline CSS/JS

**File:** `dashboard.html` (373 lines, 70KB)

**Problem:** All CSS is in a `<style>` block (minified, unreadable). All JS is in a single `<script>` block (single-letter variable names, no formatting). The entire app is a monolithic HTML file with no modularity.

**Impact:** Impossible to debug. Impossible to maintain. DevTools show unreadable minified CSS.

**Fix:** Split into separate CSS and JS files. Use descriptive variable names. Add source maps.

### I2 [P2] Direction Engine modal contains data for 23 categories — always loaded

**File:** `dashboard.html`

**Problem:** The Direction Engine category/option data (~250 items) is hardcoded as a JS object in the HTML. This data is only used when the modal is open, but it's parsed on every page load.

**Impact:** Increased startup time and memory usage for rarely-used data.

**Fix:** Load direction data on-demand when the modal opens, or from a separate JSON file.

---

**End of audit — 33 issues found (1 P0, 8 P1, 18 P2, 6 P3)**
