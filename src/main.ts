import { Orchestrator } from './core/orchestrator';
import * as path from 'path';
import * as fs from 'fs';
import { db } from './core/database';
import { Checkpoint } from './core/types';

const BASE_DIR = path.join(__dirname, '..');

function loadCheckpoint(projectName: string): Checkpoint | null {
  const cpPath = path.join(BASE_DIR, 'projects', projectName, 'checkpoint.json');
  if (fs.existsSync(cpPath)) {
    try { return JSON.parse(fs.readFileSync(cpPath, 'utf-8')); } catch (e) { return null; }
  }
  return null;
}

function resumeFromCheckpoint(name: string, checkpoint: Checkpoint, workspaceDir: string) {
  for (const task of checkpoint.tasks) {
    db.saveTask({
      id: task.id,
      description: task.description,
      status: task.status === 'in_progress' ? 'pending' : task.status,
      retry_count: task.retry_count,
      reviewer_notes: task.reviewer_notes || undefined,
      auditor_notes: task.auditor_notes || undefined,
      files_impacted: [...task.files_created, ...task.files_modified]
    }, name);
  }
  db.upsertProject(name, db.getProject(name)?.intent || '', 'executing', 50, checkpoint.loop_count,
    JSON.stringify(checkpoint.model_config_snapshot));
  console.log(`[${name}] Resuming from task ${checkpoint.current_task_id} (${checkpoint.loop_count} loops done)`);
}

async function migrateProject(p: string, projectsDir: string) {
  const ledgerPath = path.join(projectsDir, p, 'ledger.json');
  if (!fs.existsSync(ledgerPath)) return;
  const l = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
  db.upsertProject(p, l.global_intent, l.status, l.max_loops, l.loop_count);
  if (l.system_prompts) {
    db.savePromptVersion(p, l.system_prompts.architect, l.system_prompts.builder, l.system_prompts.reviewer, l.system_prompts.auditor);
  }
  if (l.task_queue && Array.isArray(l.task_queue)) {
    for (const task of l.task_queue) {
      db.saveTask(task, p);
    }
  }
  const logsDir = path.join(projectsDir, p, 'logs');
  if (fs.existsSync(logsDir)) {
    const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
    for (const logFile of logFiles) {
      const sessionId = logFile.replace('.log', '');
      const content = fs.readFileSync(path.join(logsDir, logFile), 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        db.addLog(p, sessionId, line);
      }
    }
  }
  console.log(`- Migrated: ${p}`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const projectName = args[1];

  if (command === 'migrate') {
    console.log("Migrating existing file-based projects to SQL DB...");
    const projectsDir = path.join(BASE_DIR, 'projects');
    if (fs.existsSync(projectsDir)) {
      const projects = fs.readdirSync(projectsDir);
      for (const p of projects) {
        await migrateProject(p, projectsDir);
      }
    }
    return;
  }

  if (!command || !projectName) {
    console.log("Usage: triad start <project-name> [\"intent\"]");
    return;
  }

  const projectBaseDir = path.join(BASE_DIR, 'projects', projectName);
  const workspaceDir = path.join(projectBaseDir, 'workspace');

  if (command === 'start') {
    const intent = args[2];

    const existing = db.getProject(projectName);
    console.log(`[${projectName}] DB status: ${existing ? existing.status : 'not found'}`);

    // Check for checkpoint first
    const checkpoint = loadCheckpoint(projectName);
    if (checkpoint && checkpoint.status !== 'completed' && existing?.status !== 'idle') {
      console.log(`[${projectName}] Found checkpoint from ${checkpoint.last_checkpoint_at}. Resuming...`);
      resumeFromCheckpoint(projectName, checkpoint, workspaceDir);
    } else if (!existing) {
      console.log(`[${projectName}] Initializing new SQL-backed project...`);
      db.upsertProject(projectName, intent || "Mission Standby", 'idle');

      if (!fs.existsSync(projectBaseDir)) {
        fs.mkdirSync(projectBaseDir, { recursive: true });
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
    } else if (existing.status === 'failed') {
      console.log(`[${projectName}] Previous run failed. Resetting to idle for retry.`);
      db.upsertProject(projectName, existing.intent, 'idle', existing.max_loops, 0);
      db.clearTasks(projectName);
    }

    const orchestrator = new Orchestrator(projectName, workspaceDir);
    console.log(`[${projectName}] Ledger status after init: ${orchestrator.getStatus()}`);
    console.log(`\n--- ENGINE BOOTED: ${projectName} [SQL-SYNC ACTIVE] ---`);

    let running = true;

    process.on('SIGINT', () => {
      console.log(`\n[${projectName}] Graceful shutdown...`);
      running = false;
    });
    process.on('SIGTERM', () => {
      console.log(`\n[${projectName}] Graceful shutdown...`);
      running = false;
    });

    while (running) {
      const shouldStop = await orchestrator.tick();
      if (shouldStop) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`[${projectName}] Engine stopped.`);
    // Write final checkpoint
    const cpPath = path.join(projectBaseDir, 'checkpoint.json');
    try {
      const cp = loadCheckpoint(projectName);
      if (cp) {
        cp.interruption_reason = 'engine_stopped';
        fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2));
      }
    } catch (e) {}
  }
}

main().catch(console.error);
