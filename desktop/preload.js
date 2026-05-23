const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // v2 Conductor IPC
  startProject: (name, intent) => ipcRenderer.invoke('start-project', { name, intent }),
  stopProject: (name) => ipcRenderer.invoke('stop-project', name),
  pauseProject: (name) => ipcRenderer.invoke('pause-project', name),
  resumeProject: (name, newModelConfig) => ipcRenderer.invoke('resume-project', name, newModelConfig),
  getProjectState: (name) => ipcRenderer.invoke('get-project-state', name),
  getActiveConductors: () => ipcRenderer.invoke('get-active-conductors'),

  // Git IPC
  getGitLog: (name) => ipcRenderer.invoke('get-git-log', name),
  getGitDiff: (name, fromHash, toHash) => ipcRenderer.invoke('get-git-diff', { name, fromHash, toHash }),
  getGitBranches: (name) => ipcRenderer.invoke('get-git-branches', name),
  restoreSession: (name, commitHash) => ipcRenderer.invoke('restore-session', { name, commitHash }),

  // Events from main process
  onConductorEvent: (callback) => ipcRenderer.on('conductor-event', (_e, d) => callback(d)),

  // Legacy (kept for compatibility)
  onProcessListUpdate: (callback) => ipcRenderer.on('process-list-update', (_e, d) => callback(d)),
  onEngineOutput: (callback) => ipcRenderer.on('engine-output', (_e, d) => callback(d)),
  openProjectFolder: (name) => ipcRenderer.send('open-project-folder', name),
  getActiveProcesses: () => ipcRenderer.invoke('get-active-processes'),
  getEngineOutput: (projectName) => ipcRenderer.invoke('get-engine-output', projectName),
  deleteProject: (name) => ipcRenderer.invoke('delete-project', name),
  focusSession: (title) => ipcRenderer.send('focus-session', title),
});
