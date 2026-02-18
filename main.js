import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { startServer } from './server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow
let p2pServer

async function createWindow() {
    // Start the P2P backend server
    p2pServer = await startServer()

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#0b0e14',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'public/icon.png') // Optional
    })

    // IPC Handlers for native dialogs
    ipcMain.handle('dialog:selectFile', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            properties: ['openFile']
        })
        if (canceled) return null
        return filePaths[0]
    })

    ipcMain.handle('dialog:selectDirectory', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            properties: ['openDirectory']
        })
        if (canceled) return null
        return filePaths[0]
    })

    mainWindow.loadURL('http://localhost:3000')

    mainWindow.on('closed', function () {
        mainWindow = null
    })
}

app.on('ready', createWindow)

app.on('window-all-closed', async function () {
    if (p2pServer && p2pServer.manager) {
        await p2pServer.manager.stop()
    }
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow()
    }
})
