import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.join(__dirname, '../../triad_vault.db');
console.log(`[DB] Path: ${DB_PATH}`);

export interface DbProject {
  id: number;
  name: string;
  intent: string;
  status: string;
  max_loops: number;
  loop_count: number;
  model_config: string | null;
  created_at: string;
}

export interface DbTask {
  id: string;
  project_name: string;
  description: string;
  status: string;
  retry_count: number;
  auditor_notes: string | null;
  reviewer_notes: string | null;
  files_impacted: string | null;
}

export interface DbLog {
  id: number;
  project_name: string;
  session_id: string;
  message: string;
  timestamp: string;
}

export class TriadDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        intent TEXT,
        status TEXT DEFAULT 'idle',
        max_loops INTEGER DEFAULT 50,
        loop_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        auditor_notes TEXT,
        reviewer_notes TEXT,
        files_impacted TEXT,
        PRIMARY KEY (id, project_name),
        FOREIGN KEY(project_name) REFERENCES projects(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT,
        session_id TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT,
        architect TEXT,
        builder TEXT,
        reviewer TEXT,
        auditor TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS global_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT,
        lesson TEXT,
        project_name TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_name TEXT,
        git_branch TEXT,
        status TEXT DEFAULT 'active',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        task_count INTEGER DEFAULT 0,
        completed_count INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        FOREIGN KEY(project_name) REFERENCES projects(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        project_name TEXT,
        role TEXT,
        cli TEXT,
        model TEXT,
        task_id TEXT,
        status TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        output_file TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
    `);

    this.migrateAddColumn('projects', 'loop_count', 'INTEGER DEFAULT 0');
    this.migrateAddColumn('projects', 'max_loops', 'INTEGER DEFAULT 50');
    this.migrateAddColumn('projects', 'model_config', 'TEXT');
    this.migrateAddColumn('projects', 'pause_state', 'TEXT');
    this.migrateAddColumn('projects', 'checkpoint_path', 'TEXT');
    this.migrateAddColumn('tasks', 'files_impacted', 'TEXT');
    this.migrateAddColumn('tasks', 'reviewer_notes', 'TEXT');
    this.migrateAddColumn('prompt_history', 'reviewer', 'TEXT');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interruptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT,
        session_id TEXT,
        type TEXT,
        provider TEXT,
        model TEXT,
        task_id TEXT,
        phase TEXT,
        occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        resolution TEXT
      );
    `);
  }

  private migrateAddColumn(table: string, column: string, typeDef: string) {
    // Check if column already exists
    const cols: any = this.db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = cols.some((c: any) => c.name === column);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
    }
  }

  upsertProject(name: string, intent: string, status: string = 'idle', maxLoops: number = 50, loopCount: number = 0, modelConfig?: string) {
    const existing = this.getProject(name);
    if (existing) {
      return this.db.prepare(`
        UPDATE projects SET intent = ?, status = ?, max_loops = ?, loop_count = ?, model_config = ? WHERE name = ?
      `).run(intent, status, maxLoops, loopCount, modelConfig || null, name);
    } else {
      return this.db.prepare(`
        INSERT INTO projects (name, intent, status, max_loops, loop_count, model_config) VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, intent, status, maxLoops, loopCount, modelConfig || null);
    }
  }

  getProject(name: string): DbProject | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as DbProject | undefined;
  }

  listProjects(): DbProject[] {
    return this.db.prepare('SELECT name, status FROM projects').all() as DbProject[];
  }

  deleteProject(name: string) {
    this.db.prepare('DELETE FROM projects WHERE name = ?').run(name);
  }

  saveTask(task: { id: string; description?: string; status?: string; retry_count?: number; auditor_notes?: string; reviewer_notes?: string; files_impacted?: string[] }, projectName: string) {
    return this.db.prepare(`
      INSERT OR REPLACE INTO tasks (id, project_name, description, status, retry_count, auditor_notes, reviewer_notes, files_impacted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      projectName,
      task.description,
      task.status,
      task.retry_count,
      task.auditor_notes,
      task.reviewer_notes,
      task.files_impacted ? JSON.stringify(task.files_impacted) : null
    );
  }

  getTasks(projectName: string): DbTask[] {
    return this.db.prepare('SELECT * FROM tasks WHERE project_name = ?').all(projectName) as DbTask[];
  }

  clearTasks(projectName: string) {
    return this.db.prepare('DELETE FROM tasks WHERE project_name = ?').run(projectName);
  }

  addLog(projectName: string, sessionId: string, message: string) {
    return this.db.prepare('INSERT INTO logs (project_name, session_id, message) VALUES (?, ?, ?)').run(projectName, sessionId, message);
  }

  getLogSessions(projectName: string): DbLog[] {
    return this.db.prepare('SELECT DISTINCT session_id, timestamp FROM logs WHERE project_name = ? ORDER BY timestamp DESC').all(projectName) as DbLog[];
  }

  getLogContent(sessionId: string): DbLog[] {
    return this.db.prepare('SELECT message, timestamp FROM logs WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as DbLog[];
  }

  savePromptVersion(projectName: string, arch: string, build: string, review: string, aud: string) {
    return this.db.prepare('INSERT INTO prompt_history (project_name, architect, builder, reviewer, auditor) VALUES (?, ?, ?, ?, ?)').run(projectName, arch, build, review, aud);
  }

  getLatestPrompts(projectName: string) {
    return this.db.prepare('SELECT * FROM prompt_history WHERE project_name = ? ORDER BY timestamp DESC LIMIT 1').get(projectName);
  }

  // v2 session management
  upsertSession(session: {
    id: string; project_name: string; git_branch: string;
    status?: string; task_count?: number; completed_count?: number; retry_count?: number
  }) {
    const existing = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id);
    if (existing) {
      return this.db.prepare(`
        UPDATE sessions SET status = ?, task_count = ?, completed_count = ?, retry_count = ?, ended_at = CASE WHEN ? IN ('completed','failed') THEN CURRENT_TIMESTAMP ELSE ended_at END
        WHERE id = ?
      `).run(session.status || 'active', session.task_count || 0, session.completed_count || 0, session.retry_count || 0, session.status || 'active', session.id);
    } else {
      return this.db.prepare(`
        INSERT INTO sessions (id, project_name, git_branch, status, task_count, completed_count, retry_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(session.id, session.project_name, session.git_branch, session.status || 'active', session.task_count || 0, session.completed_count || 0, session.retry_count || 0);
    }
  }

  getSessions(projectName: string) {
    return this.db.prepare('SELECT * FROM sessions WHERE project_name = ? ORDER BY started_at DESC').all(projectName);
  }

  // v2 agent run tracking
  saveAgentRun(run: {
    session_id: string; project_name: string; role: string; cli: string;
    model: string; task_id?: string; status?: string; output_file?: string
  }) {
    return this.db.prepare(`
      INSERT INTO agent_runs (session_id, project_name, role, cli, model, task_id, status, output_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.session_id, run.project_name, run.role, run.cli, run.model, run.task_id || null, run.status || 'started', run.output_file || null);
  }

  updateAgentRun(id: number, status: string) {
    return this.db.prepare('UPDATE agent_runs SET status = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
  }

  getAgentRuns(sessionId: string) {
    return this.db.prepare('SELECT * FROM agent_runs WHERE session_id = ? ORDER BY started_at ASC').all(sessionId);
  }

  // Get sessions across all projects for dashboard
  getAllSessions() {
    return this.db.prepare('SELECT id, project_name, status, started_at, task_count, completed_count FROM sessions ORDER BY started_at DESC LIMIT 50').all();
  }

  // Interruptions
  saveInterruption(data: { project_name: string; session_id?: string; type: string; provider?: string; model?: string; task_id?: string; phase?: string }) {
    return this.db.prepare(`
      INSERT INTO interruptions (project_name, session_id, type, provider, model, task_id, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(data.project_name, data.session_id || null, data.type, data.provider || null, data.model || null, data.task_id || null, data.phase || null);
  }

  resolveInterruption(id: number, resolution: string) {
    return this.db.prepare('UPDATE interruptions SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE id = ?').run(resolution, id);
  }

  getInterruptions(projectName: string) {
    return this.db.prepare('SELECT * FROM interruptions WHERE project_name = ? ORDER BY occurred_at DESC').all(projectName);
  }

  getProjectByName(name: string) {
    return this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
  }
}

export const db = new TriadDatabase();
