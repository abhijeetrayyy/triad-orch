import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';
import si from 'systeminformation';
import { db } from '../core/database';
import { GitManager } from '../core/git-manager';
import { checkAllModels, Models } from '../core/model-provider';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const TRIAD_ROOT = path.join(__dirname, '../../');

function broadcast(data: any) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// API: Internal Broadcast
app.post('/api/internal/broadcast', (req, res) => {
  broadcast(req.body);
  res.sendStatus(200);
});

// API: List Projects (From SQL)
app.get('/api/projects', (req, res) => {
  const projects = db.listProjects().map((p: any) => p.name);
  res.json(projects);
});

// API: Get Project Ledger
app.get('/api/projects/:name/ledger', (req, res) => {
  const project: any = db.getProject(req.params.name);
  if (!project) return res.status(404).send('Project not found');

  const tasks = db.getTasks(req.params.name);
  const prompts: any = db.getLatestPrompts(req.params.name);

  res.json({
    ledger: {
      global_intent: project.intent,
      status: project.status,
      max_loops: project.max_loops,
      loop_count: project.loop_count,
      model_config: project.model_config ? JSON.parse(project.model_config) : undefined,
      task_queue: tasks,
      system_prompts: {
        architect: prompts?.architect,
        builder: prompts?.builder,
        reviewer: prompts?.reviewer,
        auditor: prompts?.auditor
      }
    },
    path: path.join(TRIAD_ROOT, 'projects', req.params.name, 'workspace')
  });
});

// API: Update Ledger
app.post('/api/projects/:name/ledger', (req, res) => {
  const { ledger } = req.body;
  db.upsertProject(req.params.name, ledger.global_intent, ledger.status, ledger.max_loops, ledger.loop_count,
    ledger.model_config ? JSON.stringify(ledger.model_config) : undefined);

  if (ledger.system_prompts) {
    db.savePromptVersion(
      req.params.name,
      ledger.system_prompts.architect,
      ledger.system_prompts.builder,
      ledger.system_prompts.reviewer,
      ledger.system_prompts.auditor
    );
  }

  broadcast({ type: 'ledger_update', projectName: req.params.name, ledger });
  res.sendStatus(200);
});

// API: Project State (v2 — reads from .triad/state.json)
app.get('/api/projects/:name/state', (req, res) => {
  const statePath = path.join(TRIAD_ROOT, 'projects', req.params.name, 'workspace', '.triad', 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      return res.json(state);
    } catch (e) {
      return res.status(500).send('Failed to parse state.json');
    }
  }
  res.status(404).send('No state.json found');
});

// API: Git Log
app.get('/api/projects/:name/git/log', async (req, res) => {
  const workspacePath = path.join(TRIAD_ROOT, 'projects', req.params.name, 'workspace');
  const git = new GitManager(workspacePath);
  try {
    const log = await git.getLog();
    res.json(log);
  } catch (e: any) {
    res.json([]);
  }
});

// API: Git Branches
app.get('/api/projects/:name/git/branches', async (req, res) => {
  const workspacePath = path.join(TRIAD_ROOT, 'projects', req.params.name, 'workspace');
  const git = new GitManager(workspacePath);
  try {
    const branches = await git.getBranches();
    res.json(branches);
  } catch (e: any) {
    res.json([]);
  }
});

// API: Git Diff
app.get('/api/projects/:name/git/diff', async (req, res) => {
  const workspacePath = path.join(TRIAD_ROOT, 'projects', req.params.name, 'workspace');
  const git = new GitManager(workspacePath);
  const fromHash = req.query.from as string;
  const toHash = req.query.to as string;
  if (!fromHash || !toHash) return res.status(400).send('Missing from/to query params');
  try {
    const diff = await git.getDiff(fromHash, toHash);
    res.send(diff);
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

// API: Git Restore
app.post('/api/projects/:name/git/restore', async (req, res) => {
  const workspacePath = path.join(TRIAD_ROOT, 'projects', req.params.name, 'workspace');
  const git = new GitManager(workspacePath);
  const { commit } = req.body;
  if (!commit) return res.status(400).send('Missing commit hash');
  try {
    await git.restore(commit);
    res.sendStatus(200);
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

// API: Project Logs
app.get('/api/projects/:name/logs', (req, res) => {
  const logs = db.getLogSessions(req.params.name).map((l: any) => l.session_id);
  res.json(logs);
});

app.get('/api/projects/:name/logs/:session_id', (req, res) => {
  const content = db.getLogContent(req.params.session_id);
  const text = content.map((c: any) => `[${c.timestamp}] ${c.message}`).join('\n');
  res.send(text);
});

// API: Delete Project
app.get('/api/projects/:name/delete', (req, res) => {
  db.deleteProject(req.params.name);
  res.sendStatus(200);
});

// API: Model Health Status
app.get('/api/models/status', async (req, res) => {
  const status = await checkAllModels();
  res.json({ models: Models, status });
});

// API: Available Models List
let modelsCache: Record<string, string[]> = {};
let modelsCacheTime = 0;
app.get('/api/models/list', async (req, res) => {
  const force = req.query.refresh === '1';
  if (!force && modelsCacheTime > Date.now() - 60000) {
    return res.json(modelsCache);
  }
  const result: Record<string, string[]> = {};
  try {
    const orResp = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      timeout: 8000
    });
    result.OPENROUTER = orResp.data.data.map((m: any) => m.id).filter((id: string) => id.endsWith(':free') || !id.includes(':'));
  } catch (e) { result.OPENROUTER = []; }

  try {
    const ocResp = await axios.get('https://opencode.ai/zen/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENCODE_API_KEY}` },
      timeout: 8000
    });
    result.OPENCODE = ocResp.data.data.map((m: any) => m.id);
  } catch (e) { result.OPENCODE = []; }

  result.DEEPSEEK = ['deepseek-v4-pro', 'deepseek-v4-flash'];

  modelsCache = result;
  modelsCacheTime = Date.now();
  res.json(result);
});

// API: Get Checkpoint
app.get('/api/projects/:name/checkpoint', (req, res) => {
  const cpPath = path.join(TRIAD_ROOT, 'projects', req.params.name, 'checkpoint.json');
  if (fs.existsSync(cpPath)) {
    try { return res.json(JSON.parse(fs.readFileSync(cpPath, 'utf-8'))); } catch (e) { return res.status(500).send('Failed to parse checkpoint'); }
  }
  res.status(404).send('No checkpoint found');
});

// API: Pause Project
app.post('/api/projects/:name/pause', (req, res) => {
  broadcast({ type: 'pause', projectName: req.params.name });
  res.sendStatus(200);
});

// API: Resume Project
app.post('/api/projects/:name/resume', (req, res) => {
  const newModelConfig = req.body?.model_config;
  broadcast({ type: 'resume', projectName: req.params.name, new_model_config: newModelConfig });
  res.sendStatus(200);
});

// API: Intent Change
app.post('/api/projects/:name/intent-change', (req, res) => {
  const { action, intent } = req.body;
  const project = db.getProject(req.params.name);
  if (!project) return res.status(404).send('Project not found');

  if (action === 're_plan') {
    const tasks = db.getTasks(req.params.name);
    for (const task of tasks) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        db.saveTask({ id: task.id, description: task.description, status: 'superseded', retry_count: task.retry_count, auditor_notes: task.auditor_notes || undefined, reviewer_notes: task.reviewer_notes || undefined, files_impacted: task.files_impacted ? JSON.parse(task.files_impacted) : undefined }, req.params.name);
      }
    }
    // Archive checkpoint
    const cpPath = path.join(TRIAD_ROOT, 'projects', req.params.name, 'checkpoint.json');
    if (fs.existsSync(cpPath)) {
      const archiveDir = path.join(TRIAD_ROOT, 'projects', req.params.name, 'checkpoint_archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      fs.renameSync(cpPath, path.join(archiveDir, `checkpoint_${Date.now()}.json`));
    }
    db.upsertProject(req.params.name, intent || project.intent, 'planning', project.max_loops, 0);
  } else if (action === 'continue') {
    db.upsertProject(req.params.name, intent || project.intent, project.status, project.max_loops, project.loop_count);
  }
  res.sendStatus(200);
});

// API: Generate Direction Prompt
app.post('/api/projects/:name/generate-direction', async (req, res) => {
  const { selected_options, custom_text, target, include_completed_tasks, include_file_manifest, include_workspace_state } = req.body;
  const checkpointPath = path.join(TRIAD_ROOT, 'projects', req.params.name, 'checkpoint.json');
  const workspaceDir = path.join(TRIAD_ROOT, 'projects', req.params.name, 'workspace');
  let context = '';

  // Load checkpoint
  let checkpoint: any = {};
  if (fs.existsSync(checkpointPath)) {
    try { checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8')); } catch (e) {}
  }

  // Load project from DB
  const project = db.getProject(req.params.name);
  const prompts: any = db.getLatestPrompts(req.params.name);

  // Build context
  if (include_completed_tasks && checkpoint.tasks) {
    const completed = checkpoint.tasks.filter((t: any) => t.status === 'completed');
    const pending = checkpoint.tasks.filter((t: any) => t.status !== 'completed');
    context += `Completed tasks:\n${completed.map((t: any) => `- ${t.id}: ${t.description}`).join('\n')}\n\n`;
    context += `Pending tasks:\n${pending.map((t: any) => `- ${t.id}: ${t.description}`).join('\n')}\n\n`;
  }

  if (include_file_manifest && checkpoint.file_manifest) {
    context += `File manifest:\nCreated: ${checkpoint.file_manifest.created.join(', ')}\n`;
    context += `Modified: ${checkpoint.file_manifest.modified.join(', ')}\n`;
    context += `Deleted: ${checkpoint.file_manifest.deleted.join(', ')}\n\n`;
  }

  if (include_workspace_state && fs.existsSync(workspaceDir)) {
    const files = listFiles(workspaceDir);
    context += `Workspace files:\n${files.map(f => `  ${f}`).join('\n')}\n\n`;
  }

  context += `Current intent: ${project?.intent || 'N/A'}\n\n`;
  context += `User-selected directions:\n${selected_options.map((o: string) => `- ${o}`).join('\n')}\n`;
  if (custom_text) context += `\nCustom direction: ${custom_text}\n`;

  try {
    const { callModel } = require('../core/model-provider');
    const systemPrompt = `You are a senior development planner generating a precise project direction update.

CURRENT PROJECT STATE:
${context}

YOUR JOB:
Generate a precise, updated ${target} that:
1. Explicitly acknowledges what is already complete (do not redo it)
2. Integrates the selected directions as new goals
3. References specific files where relevant
4. Is written for an AI coding agent — specific, technical, unambiguous
5. Does NOT contain vague phrases — every direction is concrete

Output ONLY the updated ${target} text. No explanation. No preamble.`;

    const response = await callModel('DEEPSEEK' as any, 'deepseek-chat', systemPrompt,
      `Generate an updated ${target} for this project.`);
    const tokensUsed = response.length; // approximate
    res.json({ generated: response, model_used: 'deepseek-chat', tokens_used: tokensUsed });
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

// API: Workspace Tree
app.get('/api/projects/:name/workspace-tree', (req, res) => {
  const workspaceDir = path.join(TRIAD_ROOT, 'projects', req.params.name, 'workspace');
  if (!fs.existsSync(workspaceDir)) return res.json([]);
  const files = listFiles(workspaceDir);
  res.json(files);
});

// Helper: recursive file listing
function listFiles(dir: string, baseDir: string = dir): string[] {
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      if (fs.statSync(fullPath).isDirectory()) {
        result.push(...listFiles(fullPath, baseDir));
      } else {
        result.push(path.relative(baseDir, fullPath));
      }
    }
  } catch (e) {}
  return result;
}

// API: Global Memory
app.get('/api/global-memory', (req, res) => {
  const entries = db.getTasks(''); // placeholder
  const memPath = path.join(TRIAD_ROOT, 'global_memory.json');
  if (fs.existsSync(memPath)) {
    try { return res.json(JSON.parse(fs.readFileSync(memPath, 'utf-8'))); } catch (e) {}
  }
  res.json([]);
});

// API: System Stats
app.get('/api/system/stats', async (req, res) => {
  const [cpu, mem, load, osInfo] = await Promise.all([si.cpu(), si.mem(), si.currentLoad(), si.osInfo()]);
  res.json({
    cpu: `${Math.round(load.currentLoad)}%`,
    memory: `${Math.round((mem.active / mem.total) * 100)}%`,
    os: `${osInfo.platform} ${osInfo.distro}`
  });
});

export function startServer(port = 4002) {
  server.listen(port, () => {
    console.log(`[Control Center] v2 API running on http://localhost:${port}`);
  });
  return { app, server, broadcast };
}

// Auto-start when run directly via `npx ts-node src/server/dashboard-api.ts`
if (process.argv[1] && process.argv[1].includes('dashboard-api')) {
  startServer();
}
