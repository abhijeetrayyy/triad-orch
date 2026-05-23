const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

// Suppress EPIPE errors from node-pty after process exit (harmless)
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' && err.message.includes('broken pipe')) return;
  console.error('Uncaught Exception:', err);
});

// Register ts-node to handle .ts imports
require('ts-node').register({ project: path.join(__dirname, '..', 'tsconfig.json') });

let mainWindow;
const conductors = new Map();

// Import Conductor class
const { Conductor } = require('../src/core/conductor');
// Import API server
const { startServer } = require('../src/server/dashboard-api');

// --- Create Window ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
  });

  mainWindow.loadFile(path.join(__dirname, '../dashboard.html'));

  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Conductor IPC Handlers ---

function getConductor(projectName) {
  return conductors.get(projectName) || null;
}

function ensureConductor(projectName) {
  if (conductors.has(projectName)) {
    throw new Error(`Conductor already running for project "${projectName}"`);
  }
}

function getProjectWorkspace(projectName) {
  return path.join(__dirname, '..', 'projects', projectName, 'workspace');
}

function ensureProjectDir(projectName) {
  const workspacePath = getProjectWorkspace(projectName);
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }
  return workspacePath;
}

ipcMain.handle('start-project', async (event, { name, intent }) => {
  console.log(`[Main] Starting conductor for project: ${name}`);

  if (conductors.has(name)) {
    console.log(`[Main] Conductor already running for ${name}, stopping first`);
    const existing = conductors.get(name);
    await existing.stop();
    conductors.delete(name);
  }

  const workspacePath = ensureProjectDir(name);
  const conductor = new Conductor(name, workspacePath);

  conductor.setBroadcast((eventName, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conductor-event', { event: eventName, data });
    }
  });

  conductors.set(name, conductor);

  try {
    await conductor.start(intent || '');
    return { success: true, sessionId: conductor.getSessionId() };
  } catch (err) {
    console.error(`[Main] Failed to start conductor for ${name}:`, err.message);
    conductors.delete(name);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-project', async (event, name) => {
  const conductor = conductors.get(name);
  if (conductor) {
    await conductor.stop();
    conductors.delete(name);
    console.log(`[Main] Conductor stopped for project: ${name}`);
    return { success: true };
  }
  return { success: false, error: 'No active conductor found' };
});

ipcMain.handle('pause-project', async (event, name) => {
  const conductor = conductors.get(name);
  if (conductor) {
    await conductor.pause();
    // Write pause state to checkpoint
    const projectDir = path.join(__dirname, '..', 'projects', name);
    const cpPath = path.join(projectDir, 'checkpoint.json');
    if (fs.existsSync(cpPath)) {
      try {
        const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
        cp.status = 'paused';
        cp.interruption_reason = 'user_pause';
        fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2));
      } catch (e) {}
    }
    // Broadcast pause to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conductor-event', {
        event: 'state_update',
        data: { projectName: name, status: 'paused' }
      });
    }
    return { success: true };
  }
  return { success: false, error: 'No active conductor found' };
});

ipcMain.handle('resume-project', async (event, name, newModelConfig) => {
  const conductor = conductors.get(name);
  if (conductor) {
    if (newModelConfig) {
      // Apply model config changes before resume
      const db = require('../src/core/database').db;
      db.upsertProject(name, undefined, undefined, undefined, undefined, JSON.stringify(newModelConfig));
    }
    await conductor.resume();
    // Update checkpoint
    const projectDir = path.join(__dirname, '..', 'projects', name);
    const cpPath = path.join(projectDir, 'checkpoint.json');
    if (fs.existsSync(cpPath)) {
      try {
        const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
        cp.status = 'executing';
        cp.interruption_reason = null;
        if (newModelConfig) cp.model_config_snapshot = newModelConfig;
        fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2));
      } catch (e) {}
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conductor-event', {
        event: 'state_update',
        data: { projectName: name, status: 'executing', model_config: newModelConfig }
      });
    }
    return { success: true };
  }
  return { success: false, error: 'No active conductor found' };
});

ipcMain.handle('get-project-state', async (event, name) => {
  const conductor = conductors.get(name);
  if (conductor) {
    return await conductor.getState();
  }
  return null;
});

ipcMain.handle('get-git-log', async (event, name) => {
  const conductor = conductors.get(name);
  if (conductor) {
    return await conductor.getGitLog();
  }
  // Try reading from workspace directly
  try {
    const workspacePath = getProjectWorkspace(name);
    const { GitManager } = require('../src/core/git-manager');
    const git = new GitManager(workspacePath);
    return await git.getLog();
  } catch (e) {
    return [];
  }
});

ipcMain.handle('get-git-diff', async (event, { name, fromHash, toHash }) => {
  const conductor = conductors.get(name);
  if (conductor) {
    return await conductor.getGitDiff(fromHash, toHash);
  }
  try {
    const workspacePath = getProjectWorkspace(name);
    const { GitManager } = require('../src/core/git-manager');
    const git = new GitManager(workspacePath);
    return await git.getDiff(fromHash, toHash);
  } catch (e) {
    return '';
  }
});

ipcMain.handle('get-git-branches', async (event, name) => {
  const conductor = conductors.get(name);
  if (conductor) {
    return await conductor.getGitBranches();
  }
  try {
    const workspacePath = getProjectWorkspace(name);
    const { GitManager } = require('../src/core/git-manager');
    const git = new GitManager(workspacePath);
    return await git.getBranches();
  } catch (e) {
    return [];
  }
});

ipcMain.handle('restore-session', async (event, { name, commitHash }) => {
  try {
    const workspacePath = getProjectWorkspace(name);
    const { GitManager } = require('../src/core/git-manager');
    const git = new GitManager(workspacePath);
    await git.restore(commitHash);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-active-conductors', async () => {
  const result = [];
  conductors.forEach((conductor, name) => {
    result.push({
      name,
      sessionId: conductor.getSessionId(),
      status: conductor.getStatus(),
    });
  });
  return result;
});

// --- Legacy IPC (maintained for compatibility) ---
ipcMain.on('open-project-folder', (event, name) => {
  const safeName = typeof name === 'string' ? name.replace(/["\n\r&|><$`\\]/g, '').substring(0, 200) : '';
  const projectPath = path.join(__dirname, '../projects', safeName, 'workspace');
  exec(`explorer "${projectPath}"`);
});

ipcMain.handle('delete-project', async (event, name) => {
  const safeName = typeof name === 'string' ? name.replace(/["\n\r&|><$`\\]/g, '').substring(0, 200) : '';
  const projectPath = path.join(__dirname, '../projects', safeName);

  const conductor = conductors.get(safeName);
  if (conductor) {
    await conductor.stop();
    conductors.delete(safeName);
  }

  if (fs.existsSync(projectPath)) {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }

  try {
    http.get(`http://localhost:4002/api/projects/${encodeURIComponent(safeName)}/delete`);
  } catch (e) {
    console.log('[Main] DB cleanup error:', e.message);
  }

  return true;
});

// --- App Lifecycle ---
app.whenReady().then(async () => {
  console.log('[Main] Electron app ready');

  // Start API server in-process (same Node.js runtime, no ABI conflict)
  console.log('[Main] Starting API server...');
  const api = startServer(4002);
  global.__apiServer = api;

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  conductors.forEach((conductor) => {
    conductor.stop().catch(() => {});
  });
  conductors.clear();

  const api = global.__apiServer;
  if (api && api.server) {
    try { api.server.close(); } catch (e) {}
  }
});
