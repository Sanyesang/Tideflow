const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tideflowDesktop', {
  snapshot: () => ipcRenderer.invoke('tideflow:snapshot'),
  startPaper: config => ipcRenderer.invoke('tideflow:paper-start', config),
  stopPaper: () => ipcRenderer.invoke('tideflow:paper-stop'),
  openData: () => ipcRenderer.invoke('tideflow:open-data'),
  exportReport: () => ipcRenderer.invoke('tideflow:export-report'),
  demoCredentialStatus: () => ipcRenderer.invoke('tideflow:demo-credential-status'),
  saveDemoCredentials: credentials => ipcRenderer.invoke('tideflow:demo-credentials-save', credentials),
  clearDemoCredentials: () => ipcRenderer.invoke('tideflow:demo-credentials-clear'),
  preflightDemo: config => ipcRenderer.invoke('tideflow:demo-preflight', config),
  startDemo: config => ipcRenderer.invoke('tideflow:demo-start', config),
  stopDemo: () => ipcRenderer.invoke('tideflow:demo-stop'),
  demoSnapshot: () => ipcRenderer.invoke('tideflow:demo-snapshot'),
  demoJournal: () => ipcRenderer.invoke('tideflow:demo-journal'),
  openDemoData: () => ipcRenderer.invoke('tideflow:demo-open-data'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('tideflow:state', listener);
    return () => ipcRenderer.removeListener('tideflow:state', listener);
  },
  onDemoState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('tideflow:demo-state', listener);
    return () => ipcRenderer.removeListener('tideflow:demo-state', listener);
  },
});
