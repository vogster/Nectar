import express from 'express'
import { WebSocketServer } from 'ws'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { TorrentManager } from './lib/torrent-manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

export async function startServer() {
    const manager = new TorrentManager()

    app.use(express.json())
    app.use(express.static('public'))

    // API Endpoints
    app.post('/api/seed', async (req, res) => {
        try {
            const { filePath } = req.body
            if (!filePath) return res.status(400).json({ success: false, error: 'Path is required' })
            const key = await manager.seed(filePath)
            res.json({ success: true, key })
        } catch (err) {
            console.error('[API] Seed error:', err.message)
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.post('/api/download', async (req, res) => {
        try {
            const { key, savePath } = req.body
            if (!key) return res.status(400).json({ success: false, error: 'Key is required' })
            await manager.download(key, savePath)
            res.json({ success: true })
        } catch (err) {
            console.error('[API] Download error:', err.message)
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.get('/api/torrents', (req, res) => {
        res.json(manager.getTorrents())
    })

    app.post('/api/remove', async (req, res) => {
        try {
            const { key } = req.body
            await manager.remove(key)
            res.json({ success: true })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    // WebSocket for real-time updates
    wss.on('connection', (ws) => {
        console.log('UI connected via WebSocket')

        // Send initial data
        ws.send(JSON.stringify({ type: 'update', data: manager.getTorrents() }))

        const onUpdate = (torrents) => {
            ws.send(JSON.stringify({ type: 'update', data: torrents }))
        }

        manager.on('update', onUpdate)

        ws.on('close', () => {
            manager.removeListener('update', onUpdate)
        })
    })

    const PORT = process.env.PORT || 3000
    return new Promise((resolve) => {
        server.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`)
            resolve({ server, manager })
        })
    })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    startServer().catch(err => {
        console.error('Failed to start server:', err)
        process.exit(1)
    })
}
