# Triad Engine — Vision & Complete Rewrite Blueprint

## Current State Assessment

### What's Actually Broken Right Now

| Issue | Root Cause | Impact |
|-------|-----------|--------|
| All Architect calls fail | Model `openrouter/owl-alpha` doesn't exist on OpenRouter | Engine stuck in infinite retry loop |
| All Builder calls would fail | Model `deepseek-v4-flash-free` is wrong name (should be `deepseek/deepseek-v4-flash:free`) | Engine can't execute any task |
| All Auditor calls would fail | Model `google/gemini-2.0-flash-exp:free` doesn't exist on OpenRouter | Engine can't verify any task |
| API keys not validated | No startup health check; keys just silently fail | User has no idea models are broken |
| Log feed is raw ANSI terminal output | PTY output piped directly to DOM without sanitization | Dashboard shows escape codes like `[?9001h[?1004h` |
| No model/API management UI | Dashboard has no concept of models | Can't see what's working, swap models, test keys |
| Task queue is flat array | No dependency graph, no DAG | Tasks execute sequentially even when parallelizable |
| No persistence of model config | Model names hardcoded in `model-provider.ts` | Can't configure per-project or swap at runtime |
| No graceful error recovery | Status goes to `failed` and engine dies | One bad API call kills the entire session |
| Terminal output duplicates in log | Both PTY stdout AND WebSocket broadcast show same messages | Log is confusing, messages appear 2-3x |

### Available Free Models (OpenRouter — Valid Keys)

The OpenRouter API key IS valid ($0.02 used, free tier). These models are available:

| Model ID | Best For | Quality |
|----------|----------|---------|
| `deepseek/deepseek-v4-flash:free` | Builder (fast code gen) | Good |
| `qwen/qwen3-coder:free` | Architect (480B param planning) | Excellent |
| `nousresearch/hermes-3-llama-3.1-405b:free` | Auditor (405B verification) | Excellent |
| `meta-llama/llama-3.3-70b-instruct:free` | General purpose | Good |
| `openrouter/free` | Auto-router to best free model | Variable |

---

## Vision: What This System SHOULD Be

### Core Philosophy

A **self-orchestrating AI development engine** that is:
- **Observable** — every decision, every API call, every failure is visible and debuggable
- **Resilient** — model fails? swap. key expires? fallback. crash? resume.
- **Extensible** — add models, agents, tools without touching core code
- **Manageable** — full control from the Electron dashboard, no config files

---

### 1. Architecture — Clean Agent Pipeline

```
                      ┌─────────────────────────┐
                      │     Electron Dashboard   │
                      │  (preload.js → bridge)   │
                      └──────────┬──────────────┘
                                 │ IPC (contextBridge)
                      ┌──────────▼──────────────┐
                      │     Desktop Main Process │
                      │  Process Manager         │
                      │  Health Monitor          │
                      └──────────┬──────────────┘
                                 │ spawn child
                      ┌──────────▼──────────────┐
                      │     Engine Core          │
                      │  (src/main.ts)           │
                      └──────────┬──────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │  Planner     │  │  Builder     │  │  Auditor     │
      │  (Agent)     │  │  (Agent)     │  │  (Agent)     │
      │              │  │              │  │              │
      │  Breaks      │  │  Executes    │  │  Verifies    │
      │  intent →    │  │  tasks via   │  │  with model  │
      │  tasks       │  │  tools       │  │  + screenshot│
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             │                 │                 │
             ▼                 ▼                 ▼
      ┌──────────────────────────────────────────────┐
      │           Model Router / Provider Layer      │
      │  ┌────────┐ ┌────────┐ ┌────────┐ ┌───────┐  │
      │  │OpenRtr │ │OpenCode│ │DeepSeek│ │Custom │  │
      │  └────────┘ └────────┘ └────────┘ └───────┘  │
      │           Health Checks · Fallback Chains    │
      │           Cost Tracking · Rate Limit Mgmt    │
      └──────────────────────────────────────────────┘
```

### 2. Redesigned Electron Dashboard

#### Main Screen Structure

```
┌─────────────────────────────────────────────────────────┐
│ [T]  │  PROJECTS  │ [+Add]         │ v6.2 STABLE | ONLINE│
├──────┼────────────┴──────────────────────────────────────┤
│      │  ┌──────────────────────────────────────────────┐ │
│      │  │  INTENT  │ ARCHITECT       │ BUILDER │ AUDITOR│ │
│      │  │  [_____] │ [_______] [▼]  │ [_____] │ [____] │ │
│      │  └──────────────────────────────────────────────┘ │
│ Proj │  ┌───── TASK PIPELINE (DAG) ────────────────────┐ │
│  A   │  │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐    │ │
│  B   │  │  │ T1   │→│ T2   │→│ T4   │→│ T6   │    │ │
│  C ● │  │  │ plan │  │ code │  │ test │  │ done │    │ │
│      │  │  └──────┘  └──┬───┘  └──┬───┘  └──────┘    │ │
│      │  │               │  ┌──────┘                   │ │
│      │  │               ▼  ▼                          │ │
│      │  │  ┌──────┐  ┌──────┐  ┌──────┐              │ │
│      │  │  │ T3   │→│ T5   │→│ T7   │              │ │
│      │  │  │ code │  │ test │  │ done │              │ │
│      │  │  └──────┘  └──────┘  └──────┘              │ │
│      │  └────────────────────────────────────────────┘ │
│      │  ┌─── ENGINE LOG (structured) ────────────────┐ │
│      │  │ 10:32 [TOOL] write_file → product.html     │ │
│      │  │ 10:32 [MODEL] Builder → deepseek/flash    │ │
│      │  │ 10:33 [AUDIT] Task T2: PASS ✓             │ │
│      │  └────────────────────────────────────────────┘ │
│      │  ┌─── AUDIT SCREENSHOT ───────────────────────┐ │
│      │  │             [image preview]                 │ │
│      │  └────────────────────────────────────────────┘ │
├──────┴─────────────────────────────────────────────────┤
│ [DASHBOARD] [MODELS] [HISTORY] [SYSTEM]                │
└─────────────────────────────────────────────────────────┘
```

### 3. Models & API Management Tab (NEW — Critical Missing Piece)

```
┌─────────────────────────────────────────────────────────┐
│ MODEL MANAGEMENT                    [Test All] [Refresh] │
├─────────────────────────────────────────────────────────┤
│ ┌── PROVIDERS ────────────────────────────────────────┐ │
│ │  OPENROUTER  ●●●●●●●●●○  $0.02 used    [Edit Key] │ │
│ │  OPenCode    ●●●●●○○○○○  Test: FAIL    [Edit Key] │ │
│ │  DeepSeek    ○○○○○○○○○○  Untested      [Edit Key] │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌── MODEL ASSIGNMENTS ───────────────────────────────┐ │
│ │  ROLE      │ MODEL                    │ STATUS    │ │
│ │───────────┼──────────────────────────┼───────────│ │
│ │ Architect │ qwen/qwen3-coder:free    │ ✅ Ready  │ │
│ │ Fallback  │ meta-llama/llama-3.3-70b │ ✅ Ready  │ │
│ │ Builder   │ deepseek/deepseek-v4     │ ✅ Ready  │ │
│ │ Auditor   │ nousresearch/hermes-3    │ ⚠️ Slow   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌── RECENT MODEL CALLS ──────────────────────────────┐ │
│ │  TIME  │ MODEL                    │ DUR  │ STATUS  │ │
│ │ ──────┼──────────────────────────┼──────┼─────────│ │
│ │ 10:32 │ deepseek/deepseek-v4     │ 1.2s │ ✅ 200  │ │
│ │ 10:30 │ qwen/qwen3-coder         │ 3.1s │ ✅ 200  │ │
│ │ 10:28 │ openrouter/owl-alpha     │ 4.0s │ ❌ 404  │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

### 4. Everything Missing vs What Should Be There

| Current | Should Be | Priority |
|---------|-----------|----------|
| Models hardcoded in source | **Model Manager UI** — configure, test, swap in-app | P0 |
| One flat task list | **Task DAG** — dependency graph, parallel execution, visual pipeline | P0 |
| Raw ANSI log feed | **Structured log view** — filterable, searchable, color-coded by type | P0 |
| No model health monitoring | **Health dashboard** — real-time status of every provider + model | P0 |
| API keys in `.env` file | **Key vault UI** — manage keys in-app, encrypted storage | P0 |
| Infinite retry on model failure | **Smart fallback chains** — try next model, exponential backoff, notify user | P0 |
| Crash = status "failed" | **Resume capability** — pick up where it left off after failure | P0 |
| One engine process per project | **Process manager in dashboard** — see all running engines, kill/restart | P1 |
| PTY output shown raw | **Sanitized terminal** — strip ANSI codes, proper log levels | P1 |
| No project templates | **Project templates** — ecommerce, API, CLI, etc. with preset configs | P1 |
| No cost tracking | **Usage & cost dashboard** — per-model, per-project, per-session | P1 |
| No tool registry | **Tool library** — browse, create, test custom tools from UI | P1 |
| Settings in code | **Settings panel** — all config via UI with validation | P1 |
| No onboarding | **Welcome wizard** — first-run setup, test API keys, create first project | P2 |
| No export/import | **Project export** — zip with workspace + ledger + logs | P2 |
| No keyboard shortcuts | **Command palette** — Ctrl+K for quick actions | P2 |

---

### 5. Recommended Action Plan

#### Phase 1 — Make It Work (Today)
1. Fix model names in `model-provider.ts` to use real available models
2. Add provider health check on startup (visible in dashboard)
3. Add smart fallback with backoff instead of infinite retry
4. Strip ANSI escape codes from PTY output before displaying
5. Delete old DB so fresh schema takes effect

#### Phase 2 — Make It Usable (This Week)
1. Add **Models tab** to Electron dashboard — manage providers, assign models, test connectivity
2. Add **structured logging** — color-coded, filterable, searchable
3. Add **process manager** — see all engine sessions, kill/restart from UI
4. Add **task DAG visualization** — show dependencies, parallel execution
5. Add **settings panel** — configure everything from UI (no code changes)

#### Phase 3 — Make It World-Class (This Month)
1. **Plugin system** — agents as plugins (researcher, planner, builder, auditor, tester)
2. **Vector memory** — replace `global_memory.json` with proper RAG/vector store
3. **Concurrent task execution** — run independent tasks in parallel
4. **Cost-aware routing** — auto-select cheapest working model per task
5. **Project templates** — one-click starter projects
6. **Collaboration** — share projects, export/import, team features

---

### 6. Model Fixes (Immediate)

The current model config needs to be updated to use models that actually exist on OpenRouter:

```typescript
export const Models = {
  ARCHITECT_PRIMARY: { provider: 'OPENROUTER', name: 'qwen/qwen3-coder:free' },
  ARCHITECT_FALLBACK: { provider: 'OPENROUTER', name: 'meta-llama/llama-3.3-70b-instruct:free' },
  BUILDER: { provider: 'OPENROUTER', name: 'deepseek/deepseek-v4-flash:free' },
  AUDITOR: { provider: 'OPENROUTER', name: 'nousresearch/hermes-3-llama-3.1-405b:free' }
};
```

No more DeepSeek direct (key unknown) or OpenCode (provider unknown). All via OpenRouter which has a confirmed working free-tier key.

---

*Generated by vision audit — 2026-05-23*
