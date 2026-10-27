'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args).then(result => { if (!result.ok) throw new Error(result.error); return result.value; });
contextBridge.exposeInMainWorld('favecusBrowse', {
  state: invoke('browse:state'), command: invoke('browse:command'), add: invoke('browse:add'),
  onState: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('browse:state', listener); return () => ipcRenderer.removeListener('browse:state', listener); }
});
