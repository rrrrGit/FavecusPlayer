'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args).then(result => {
  if (!result.ok) throw new Error(result.error); return result.value;
});
contextBridge.exposeInMainWorld('favecusMini', {
  state: invoke('mini:state'), command: invoke('mini:command'), volume: invoke('mini:volume'), restore: invoke('mini:restore'), expand: invoke('mini:expand'),
  onState: callback => { const handler = (_event, state) => callback(state); ipcRenderer.on('mini:state', handler); return () => ipcRenderer.removeListener('mini:state', handler); },
  onCollapse: callback => { const handler = () => callback(); ipcRenderer.on('mini:collapsed', handler); return () => ipcRenderer.removeListener('mini:collapsed', handler); }
});
