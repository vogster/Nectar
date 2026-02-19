import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { startServer, stopServer } from './server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow
let p2pServer
let isShuttingDown = false

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

    ipcMain.handle('dialog:selectPath', async (event, options = {}) => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            properties: options.allowDirectory ? ['openDirectory', 'openFile'] : ['openFile']
        })
        if (canceled) return null
        return filePaths[0]
    })

    mainWindow.loadURL(`http://localhost:${process.env.PORT || 3000}`)

    mainWindow.on('closed', function () {
        mainWindow = null
    })
}

app.on('ready', createWindow)

app.on('window-all-closed', async function () {
    if (isShuttingDown) return
    isShuttingDown = true
    // Stop the server and cleanup all resources
    await stopServer(p2pServer)
    app.quit()
})

app.on('before-quit', async function (event) {
    // Ensure cleanup on explicit quit (e.g., Cmd+Q on macOS)
    if (isShuttingDown) return
    isShuttingDown = true
    
    if (p2pServer) {
        event.preventDefault()
        await stopServer(p2pServer)
        app.quit()
    }
})

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow()
    }
})
