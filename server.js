import express from 'express'
import { WebSocketServer } from 'ws'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { TorrentManager } from './lib/torrent-manager.js'
import { SettingsManager } from './lib/settings-manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

export async function startServer() {
    // 1. Сначала определяем путь к данным (из переменной окружения или дефолтный)
    // Это важно, чтобы и настройки, и данные торрентов жили в одном месте.
    const storagePath = process.env.NECTAR_DATA || './nectar-data'
    const configPath = path.join(storagePath, 'config.json')

    // 2. Инициализируем настройки из этой директории
    const settings = new SettingsManager(configPath)

    // 3. Если в настройках прописан другой seedPath, он имеет приоритет
    const finalStoragePath = process.env.NECTAR_DATA || settings.get('seedPath') || storagePath

    // 4. Инициализируем менеджер торрентов
    const manager = new TorrentManager(finalStoragePath)

    app.use(express.json())
    app.use(express.static('public'))

    // API Endpoints
    app.post('/api/seed', async (req, res) => {
        try {
            const { path: sourcePath, name } = req.body
            if (!sourcePath) return res.status(400).json({ success: false, error: 'Path is required' })
            const key = await manager.seed(sourcePath, name)
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

    app.post('/api/confirm-download', async (req, res) => {
        try {
            const { key, selectedFiles } = req.body
            if (!key) return res.status(400).json({ success: false, error: 'Key is required' })
            await manager.confirmDownload(key, selectedFiles)
            res.json({ success: true })
        } catch (err) {
            console.error('[API] Confirm download error:', err.message)
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.get('/api/torrents', (req, res) => {
        res.json(manager.getTorrents())
    })

    app.post('/api/sync-seed', async (req, res) => {
        try {
            const { key } = req.body
            await manager.syncSeed(key)
            res.json({ success: true })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.post('/api/sync-download', async (req, res) => {
        try {
            const { key } = req.body
            await manager.syncDownload(key)
            res.json({ success: true })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.get('/api/sync-diff', async (req, res) => {
        try {
            const { key } = req.query
            const diff = await manager.getSyncDiff(key)
            res.json({ success: true, diff })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
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

    // Settings API
    app.get('/api/settings', (req, res) => {
        res.json({ success: true, settings: settings.getAll() })
    })

    app.post('/api/settings', (req, res) => {
        try {
            const newSettings = req.body
            settings.update(newSettings)

            // Применяем некоторые настройки на лету
            if (newSettings.port && newSettings.port !== settings.get('port')) {
                console.warn('[Settings] Port changed! Restart the app to apply port change.')
            }
            if (newSettings.seedPath && newSettings.seedPath !== settings.get('seedPath')) {
                console.warn('[Settings] Seed storage path changed! Restart the app to apply new data location.')
            }

            res.json({ success: true, settings: settings.getAll() })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.post('/api/settings/reset', (req, res) => {
        try {
            settings.reset()
            res.json({ success: true, settings: settings.getAll() })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    // Rating API
    app.get('/api/ratings', (req, res) => {
        res.json({ success: true, ratings: manager.getPeerRatings() })
    })

    app.get('/api/ratings/top', (req, res) => {
        const limit = parseInt(req.query.limit) || 10
        const top = manager.getTopPeers(limit)
        res.json({ success: true, top })
    })

    app.get('/api/ratings/:peerKey', (req, res) => {
        const rating = manager.getRating(req.params.peerKey)
        res.json({ success: true, rating })
    })

    app.post('/api/ratings', async (req, res) => {
        try {
            const { peerKey, speed, reliability, communication, comment } = req.body
            if (!peerKey || !speed || !reliability) {
                return res.status(400).json({
                    success: false,
                    error: 'peerKey, speed and reliability are required'
                })
            }

            const ratingId = await manager.ratePeer(peerKey, {
                speed: parseInt(speed),
                reliability: parseInt(reliability),
                communication: communication ? parseInt(communication) : null,
                comment: comment || ''
            })

            res.json({ success: true, ratingId })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.post('/api/ratings/fetch', async (req, res) => {
        try {
            const { peerKey } = req.body
            if (!peerKey) {
                return res.status(400).json({ success: false, error: 'peerKey is required' })
            }

            const ratings = await manager.fetchPeerRatings(peerKey)
            res.json({ success: true, ratings })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.post('/api/ratings/import', async (req, res) => {
        try {
            const { ratings } = req.body
            if (!ratings || !Array.isArray(ratings)) {
                return res.status(400).json({ success: false, error: 'ratings array is required' })
            }

            const imported = await manager.importRatings(ratings)
            res.json({ success: true, imported })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.get('/api/ratings/export', async (req, res) => {
        try {
            const ratings = await manager.exportRatings()
            res.json({ success: true, ratings })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.post('/api/ratings/report', async (req, res) => {
        try {
            const { peerKey } = req.body
            if (!peerKey) {
                return res.status(400).json({ success: false, error: 'peerKey is required' })
            }

            manager.ratingManager.updatePeerStats(peerKey, { reports: 1 })
            res.json({ success: true })
        } catch (err) {
            res.status(500).json({ success: false, error: err.message })
        }
    })

    app.get('/api/ratings/stats', (req, res) => {
        res.json({ success: true, stats: manager.getMyRatingStats() })
    })

    app.get('/api/ratings/drive-key', (req, res) => {
        res.json({ success: true, driveKey: manager.getRatingsDriveKey() })
    })

    app.get('/api/ratings/my-public-key', (req, res) => {
        res.json({ success: true, publicKey: manager.getMyPublicKey() })
    })

    app.get('/api/ratings/seeder-key/:torrentKey', (req, res) => {
        const seederKey = manager.getSeederKey(req.params.torrentKey)
        res.json({ success: true, seederKey })
    })

    // Search API
    app.get('/api/search', async (req, res) => {
        try {
            const query = req.query.q
            if (!query) return res.json({ success: true, results: [] })

            console.log(`[API] Searching for: "${query}"`)
            const results = await manager.search(query)
            res.json({ success: true, results })
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

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message)
                if (data.type === 'refresh') {
                    console.log('[WS] UI requested refresh')
                    ws.send(JSON.stringify({ type: 'update', data: manager.getTorrents() }))
                }
                if (data.type === 'get-seeder-key') {
                    const seederKey = manager.getSeederKey(data.key)
                    if (seederKey) {
                        ws.send(JSON.stringify({ type: 'seeder-key', torrentKey: data.key, seederKey }))
                    }
                }
            } catch (err) {
                console.error('[WS] Message error:', err.message)
            }
        })

        ws.on('close', () => {
            manager.removeListener('update', onUpdate)
        })
    })

    const PORT = process.env.PORT || settings.get('port') || 3000
    return new Promise((resolve) => {
        server.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`)

            // Восстанавливаем торренты после запуска сервера
            setTimeout(() => manager.restoreTorrents(), 1000)

            resolve({ server, manager, wss, settings })
        })
    })
}

export async function stopServer(serverData) {
    if (!serverData) return

    const { server, manager, wss, settings } = serverData

    console.log('[Stop] Stopping server...')

    // Stop WebSocket server
    if (wss) {
        wss.clients.forEach(client => client.close())
        await new Promise(resolve => wss.close(resolve))
        console.log('[Stop] WebSocket server closed')
    }

    // Stop TorrentManager
    if (manager) {
        await manager.stop()
        console.log('[Stop] TorrentManager stopped')
    }

    // Save settings
    if (settings) {
        settings.save()
        console.log('[Stop] Settings saved')
    }

    // Stop HTTP server
    if (server) {
        await new Promise(resolve => server.close(resolve))
        console.log('[Stop] HTTP server closed')
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    startServer().catch(err => {
        console.error('Failed to start server:', err)
        process.exit(1)
    })
}
