# Hybrid CLI Builder Integration Plan

## Architecture Change

```
BEFORE (all direct API):
  Architect → callModel() → parse JSON
  Builder   → callModel() → parse JSON → ToolExecutor → append result → repeat (2-10x)
  Reviewer  → callModel() → parse PASS/FAIL
  Auditor   → callModel() → parse PASS/FAIL + lesson

AFTER (hybrid):
  Architect → callModel() → parse JSON plan          (unchanged - 1 call)
  Builder   → spawn opencode CLI PTY per task        (NEW - session retains context)
  Reviewer  → callModel() → parse PASS/FAIL           (unchanged - 1 call)
  Auditor   → callModel() → parse PASS/FAIL + lesson  (unchanged - 1 call)
```

**Token savings:** The builder loop currently sends 500→5000+ tokens per call because it accumulates all tool results as string append. In the CLI approach, opencode maintains warm context in-session — follow-up tools only add minimal token overhead. Estimated 60-80% reduction in builder token usage.

## Files That Need Changes

### 1. `src/core/conductor.ts` — New Builder Flow

**Add fields:**
```typescript
private cliSpawner: CLISpawner | null = null;
private builderPID: number | null = null;
```

**Modify `handleExecution()`** — replace the entire while-loop with:
```
1. Build builder prompt (unchanged - uses PromptBuilder)
2. Write prompt to .triad/builder_prompt.md (so CLI can read it)
3. Spawn opencode CLI via CLISpawner with prompt-file
4. Monitor PTY output stream → emit log events to dashboard
5. Watch for .triad/done.signal OR process exit
6. On completion: extract files_impacted from the CLI output/file diffs
7. Git commit the changed files
```

**Add watchdog timeout:** 120s per task (same as CLISpawner's existing watchdog)

**Add abort handling:** `stop()` must kill the active CLI process via `cliSpawner.killAll()`

### 2. `src/core/cli-spawner.ts` — Fix & Modernize

**Problems to fix:**
1. **Command-line length limit** — write prompt to `.triad/builder_prompt.md` and pass via file
2. **ANSI garbage** — strip ANSI escape codes before writing output
3. **ConPTY failure** — use `--no-color` flag when spawning opencode
4. **Completion detection** — return a Promise that resolves on exit with output
5. **Structured output** — detect DONE signal or exit code 0

**New spawnOpenCode signature:**
```typescript
async spawnOpenCode(role: AgentRole, promptContent: string, modelConfig: ModelConfig): Promise<{ output: string; exitCode: number; files: string[] }>
```

### 3. `src/core/model-provider.ts` — No Changes Needed

Primary/fallback model chain remains for architect, reviewer, auditor. Builder routes through CLISpawner.

### 4. `src/core/tools.ts` — No Changes Needed

Keep as fallback. CLI handles tools natively.

### 5. `src/core/prompt-builder.ts` — Update Builder Prompt

Replace JSON tool call instructions with CLI-native instructions.

### 6. `desktop/main.js` — Minor Change

Add IPC handler for CLI session status.

## Implementation Steps

### Step 1: Fix CLISpawner reliability
- Switch to file-based prompt
- Add `--no-color` flag
- Strip ANSI from output
- Convert to Promise-based API

### Step 2: Update conductor handleExecution
- Replace while-loop with CLI spawn + monitor
- Emit live output as log events

### Step 3: Update prompt-builder for builder role
- CLI-native instructions

### Step 4: Add fallback to direct API
- If CLI fails, fall back to existing callModel() loop

### Step 5: Compile and test
- npx tsc --noEmit
- Manual test

## Verification

1. Compile check: `npx tsc --noEmit`
2. CLI binary check: verify opencode at `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`
3. Manual test: simple project
4. Fallback test: rename opencode binary, verify API fallback
5. Kill test: Kill during builder execution
