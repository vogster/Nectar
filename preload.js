const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory')
})
