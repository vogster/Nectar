import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { EventEmitter } from 'events'
import crypto from 'crypto'

// Рекурсивно обходит директорию и возвращает список всех файлов с путями
async function* walkDir(dir, baseDir = dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(baseDir, fullPath)
        if (entry.isDirectory()) {
            yield* walkDir(fullPath, baseDir)
        } else {
            yield { fullPath, relativePath }
        }
    }
}

export class TorrentManager extends EventEmitter {
    constructor(storagePath = './nectar-data') {
        super()
        this.storagePath = storagePath
        this.rootStore = new Corestore(storagePath)
        this.swarm = new Hyperswarm()
        this.torrents = new Map() // key -> torrent info
        this.stores = new Map() // key -> Corestore instance (for isolation)

        // Инициализируем root store
        this.rootStore.on('error', (err) => console.error('[RootStore] Error:', err.message))

        // Глобальная репликация для всех store'ов
        this.swarm.on('connection', (conn, peerInfo) => {
            console.log('[Swarm] New connection, replicating root store...')
            // Реплицируем только root store, этого достаточно для всех сессий/неймспейсов
            this.rootStore.replicate(conn)
        })
    }

    async _init() {
        if (!this.rootStore.opened) {
            await this.rootStore.ready()
            console.log('[TorrentManager] Root store initialized')
        }
    }

    async seed(sourcePath, customName = null) {
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Path not found: ${sourcePath}`)
        }

        console.log(`[Seed] Starting seed for: ${sourcePath}`)

        // Инициализируем root store если нужно
        await this._init()

        // Создаём уникальный неймспейс для этой раздачи
        const namespace = crypto.randomBytes(16).toString('hex')
        const sessionStore = this.rootStore.namespace(namespace)

        const drive = new Hyperdrive(sessionStore)
        await drive.ready()

        const key = b4a.toString(drive.key, 'hex')
        const name = customName || path.basename(sourcePath)
        const stat = fs.statSync(sourcePath)
        const isDirectory = stat.isDirectory()

        console.log(`[Seed] Drive ready, key: ${key}, type: ${isDirectory ? 'directory' : 'file'}`)
        console.log(`[Seed] Joining swarm for discoveryKey: ${drive.discoveryKey.toString('hex').slice(0, 16)}...`)

        const controller = new AbortController()
        const torrent = {
            key,
            name,
            size: stat.size,
            type: isDirectory ? 'seeding-dir' : 'seeding',
            drive,
            store: sessionStore,
            peers: 0,
            progress: 0,
            controller,
            activeTransfer: true,
            fileCount: 0
        }
        this.torrents.set(key, torrent)
        this.stores.set(key, sessionStore)

        try {
            // Сначала записываем метаданные
            console.log(`[Seed] Writing metadata...`)
            const metadata = {
                name: name,
                sourceType: isDirectory ? 'directory' : 'file',
                sourceName: path.basename(sourcePath),
                createdAt: new Date().toISOString()
            }

            // Записываем метаданные и ждём завершения
            await new Promise((resolve, reject) => {
                const metadataStream = drive.createWriteStream('/.metadata.json')
                metadataStream.on('finish', () => {
                    console.log(`[Seed] Metadata written successfully`)
                    resolve()
                })
                metadataStream.on('error', (err) => {
                    console.error(`[Seed] Metadata write error:`, err.message)
                    reject(err)
                })
                metadataStream.write(JSON.stringify(metadata, null, 2))
                metadataStream.end()
            })

            console.log(`[Seed] Metadata done, starting file transfer...`)

            if (isDirectory) {
                // Раздача директории
                console.log(`[Seed] Seeding directory...`)
                let uploaded = 0
                let totalSize = 0

                // Сначала считаем общий размер
                for await (const file of walkDir(sourcePath)) {
                    totalSize += fs.statSync(file.fullPath).size
                }

                let uploadedSize = 0
                for await (const { fullPath, relativePath } of walkDir(sourcePath)) {
                    const drivePath = '/' + relativePath.replace(/\\/g, '/')
                    const fileStat = fs.statSync(fullPath)

                    console.log(`[Seed] ${++uploaded}: ${relativePath}`)
                    const readStream = fs.createReadStream(fullPath)
                    const writeStream = drive.createWriteStream(drivePath)
                    await pipeline(readStream, writeStream, { signal: controller.signal })

                    uploadedSize += fileStat.size
                    torrent.progress = Math.round((uploadedSize / totalSize) * 100)
                    torrent.fileCount = uploaded
                    this.emit('update', this.getTorrents())
                }

                console.log(`[Seed] Directory seeded: ${uploaded} files`)
            } else {
                // Раздача одного файла
                console.log(`[Seed] Writing file to drive...`)
                const readStream = fs.createReadStream(sourcePath)
                const writeStream = drive.createWriteStream('/file')
                await pipeline(readStream, writeStream, { signal: controller.signal })
                torrent.fileCount = 1
            }

            console.log(`[Seed] Files written successfully. Joining swarm...`)
            const discovery = this.swarm.join(drive.discoveryKey, { server: true, client: true })
            console.log(`[Seed] Discovery joined for ${drive.discoveryKey.toString('hex').slice(0, 16)}`)
            torrent.discovery = discovery
            torrent.progress = 100
            torrent.activeTransfer = false

            this._monitorTorrent(key)
            this.emit('update', this.getTorrents())
            return key

        } catch (err) {
            torrent.activeTransfer = false
            if (err.name === 'AbortError') {
                console.log(`[Seed] Aborted: ${key}`)
            } else {
                console.error(`[Seed] error: ${err.message}`)
                this.torrents.delete(key)
                this.stores.delete(key)
                await sessionStore.close().catch(() => { })
                throw err
            }
        }
    }

    async download(keyHex, saveDir = './downloads') {
        if (this.torrents.has(keyHex)) return this.torrents.get(keyHex)

        console.log(`[Download] Starting download for: ${keyHex}`)
        const key = b4a.from(keyHex, 'hex')

        // Инициализируем root store если нужно
        await this._init()

        // Создаём неймспейс на основе ключа для этой загрузки
        const sessionStore = this.rootStore.namespace(keyHex)

        const drive = new Hyperdrive(sessionStore, key)
        await drive.ready()

        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true })
        }

        const discoveryKeyHex = drive.discoveryKey.toString('hex').slice(0, 16)
        console.log(`[Download] Drive ready. Joining swarm for discoveryKey: ${discoveryKeyHex}...`)
        const discovery = this.swarm.join(drive.discoveryKey, { server: false, client: true })
        console.log(`[Download] Discovery joined for ${discoveryKeyHex}`)

        const controller = new AbortController()
        const torrent = {
            key: keyHex,
            name: 'Identifying...',
            size: 0,
            type: 'downloading',
            drive,
            store: sessionStore,
            discovery,
            peers: 0,
            progress: 0,
            saveDir,
            controller,
            activeTransfer: false
        }

        this.torrents.set(keyHex, torrent)
        this.stores.set(keyHex, sessionStore)
        this._monitorTorrent(keyHex)

        // Start by fetching metadata only
        this._fetchMetadata(keyHex)

        return torrent
    }

    async confirmDownload(keyHex, selectedFiles = null) {
        const torrent = this.torrents.get(keyHex)
        if (!torrent) throw new Error('Torrent not found')
        if (torrent.type !== 'metadata-ready') throw new Error('Torrent is not ready for download (metadata not loaded)')

        torrent.selectedFiles = selectedFiles
        torrent.activeTransfer = true
        torrent.type = torrent.fileCount > 1 || !selectedFiles ? 'downloading-dir' : 'downloading'

        this.emit('update', this.getTorrents())

        // Start the actual data transfer
        this._startDownload(keyHex)
    }

    async remove(keyHex) {
        const torrent = this.torrents.get(keyHex)
        if (!torrent) return

        console.log(`[Remove] Removing torrent: ${keyHex}`)

        // 1. Abort active transfers
        torrent.controller.abort()

        // Remove event listeners
        if (torrent._updatePeersFn) {
            torrent.drive.core.removeListener('peer-add', torrent._updatePeersFn)
            torrent.drive.core.removeListener('peer-remove', torrent._updatePeersFn)
        }

        if (torrent.monitorInterval) clearInterval(torrent.monitorInterval)

        try {
            // 2. Destroy discovery handle first
            if (torrent.discovery) {
                await torrent.discovery.destroy()
                console.log(`[Remove] Discovery destroyed: ${keyHex}`)
            }

            // 3. Wait a moment for streams to react to abort
            await new Promise(r => setTimeout(r, 200))

            // 4. Close drive
            await torrent.drive.close()
            console.log(`[Remove] Drive closed: ${keyHex}`)

            // 5. Close and remove isolated store
            if (torrent.store) {
                await torrent.store.close()
                console.log(`[Remove] Store closed: ${keyHex}`)
            }
        } catch (err) {
            console.warn(`[Remove] Cleanup warning for ${keyHex}: ${err.message}`)
        }

        this.torrents.delete(keyHex)
        this.stores.delete(keyHex)
        this.emit('update', this.getTorrents())
    }

    async _fetchMetadata(keyHex) {
        const torrent = this.torrents.get(keyHex)
        if (!torrent) return
        const drive = torrent.drive
        const signal = torrent.controller.signal

        try {
            torrent.type = 'metadata-fetching'
            this.emit('update', this.getTorrents())

            console.log(`[Download] Waiting for peers: ${keyHex}`)
            try {
                await this._waitForPeers(drive, signal, 60000)
            } catch (err) {
                console.error(`[Download] Failed to connect to peers: ${err.message}`)
                torrent.error = 'No peers available. Make sure the seeder is online.'
                this.emit('update', this.getTorrents())
                return
            }

            console.log(`[Download] Peer connected! Waiting for metadata...`)
            await drive.core.update({ signal })

            // Сначала читаем метаданные
            let metadata = null
            for (let i = 0; i < 15 && !metadata; i++) {
                await drive.core.update({ signal })
                try {
                    const metadataEntry = await drive.entry('/.metadata.json')
                    if (metadataEntry) {
                        const metadataStream = drive.createReadStream('/.metadata.json')
                        const metadataChunks = []
                        for await (const chunk of metadataStream) {
                            metadataChunks.push(chunk)
                        }
                        metadata = JSON.parse(Buffer.concat(metadataChunks).toString())
                    }
                } catch (err) { }
                if (!metadata) await new Promise(r => setTimeout(r, 1500))
            }

            // Получаем список всех файлов
            const entries = []
            while (entries.length === 0 && this.torrents.has(keyHex)) {
                if (signal.aborted) throw new Error('AbortError')
                await drive.core.update({ signal })
                for await (const entry of drive.list()) {
                    if (entry.value.blob && entry.key !== '/.metadata.json') {
                        entries.push({
                            path: entry.key,
                            size: entry.value.blob.byteLength || 0
                        })
                    }
                }
                if (entries.length === 0) await new Promise(r => setTimeout(r, 2000))
            }

            torrent.metadata = metadata
            torrent.files = entries
            torrent.name = metadata?.name || `downloaded-${keyHex.slice(0, 6)}`
            torrent.fileCount = entries.length
            torrent.size = entries.reduce((acc, e) => acc + e.size, 0)
            torrent.type = 'metadata-ready'

            this.emit('update', this.getTorrents())
            console.log(`[Metadata] Ready for ${keyHex}: ${torrent.fileCount} files`)

        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error(`[Metadata] Error: ${err.message}`)
                torrent.error = err.message
                this.emit('update', this.getTorrents())
            }
        }
    }

    async _startDownload(keyHex) {
        const torrent = this.torrents.get(keyHex)
        if (!torrent) return
        const drive = torrent.drive
        const signal = torrent.controller.signal
        const entries = torrent.files
        const selectedFiles = torrent.selectedFiles // Array of paths or null for all

        try {
            const filesToDownload = selectedFiles
                ? entries.filter(e => selectedFiles.includes(e.path))
                : entries

            const totalSize = filesToDownload.reduce((acc, e) => acc + e.size, 0)
            torrent.size = totalSize
            torrent.progress = 0
            this.emit('update', this.getTorrents())

            const baseSavePath = torrent.fileCount > 1 || (selectedFiles && selectedFiles.length > 1)
                ? path.join(torrent.saveDir, torrent.name)
                : torrent.saveDir

            let downloadedSize = 0

            for (const entry of filesToDownload) {
                if (signal.aborted) throw new Error('AbortError')

                const filePath = entry.path.startsWith('/') ? entry.path.slice(1) : entry.path
                // If it's a single file download and we didn't use a subfolder
                const fullPath = (torrent.fileCount > 1 || (selectedFiles && selectedFiles.length > 1))
                    ? path.join(baseSavePath, filePath === 'file' ? (torrent.metadata?.sourceName || 'file') : filePath)
                    : path.join(baseSavePath, filePath === 'file' ? (torrent.metadata?.sourceName || 'file') : filePath)

                const dir = path.dirname(fullPath)
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

                console.log(`[Download] ${torrent.key.slice(0, 6)}: ${filePath}`)

                const readStream = drive.createReadStream(entry.path)
                const writeStream = fs.createWriteStream(fullPath)

                await new Promise((resolve, reject) => {
                    readStream.on('data', (chunk) => {
                        downloadedSize += chunk.length
                        torrent.progress = Math.round((downloadedSize / totalSize) * 100)
                        this.emit('update', this.getTorrents())
                    })
                    readStream.pipe(writeStream)
                        .on('finish', resolve)
                        .on('error', reject)
                })
            }

            torrent.progress = 100
            torrent.activeTransfer = false
            this.emit('update', this.getTorrents())

        } catch (err) {
            torrent.activeTransfer = false
            if (err.name !== 'AbortError' && !signal.aborted) {
                console.error(`[Download] Error: ${err.message}`)
                torrent.error = err.message
                this.emit('update', this.getTorrents())
            }
        }
    }

    _waitForPeers(drive, signal, timeout = 30000) {
        return new Promise((resolve, reject) => {
            // Проверяем, есть ли уже пиры
            if (drive.core.peers.length > 0) {
                console.log(`[WaitForPeers] Already connected to ${drive.core.peers.length} peer(s)`)
                return resolve()
            }

            const timer = setTimeout(() => {
                cleanup()
                reject(new Error(`No peers connected within ${timeout / 1000} seconds`))
            }, timeout)

            const checkPeer = () => {
                if (drive.core.peers.length > 0) {
                    cleanup()
                    console.log(`[WaitForPeers] Connected to ${drive.core.peers.length} peer(s)`)
                    resolve()
                }
            }

            const cleanup = () => {
                clearTimeout(timer)
                drive.core.removeListener('peer-add', checkPeer)
            }

            drive.core.on('peer-add', checkPeer)
        })
    }

    _monitorTorrent(keyHex) {
        const torrent = this.torrents.get(keyHex)
        if (!torrent) return

        const updatePeers = () => {
            if (!this.torrents.has(keyHex)) return

            // Accurate peer count from the metadata core
            torrent.peers = torrent.drive.core.peers.length
            this.emit('update', this.getTorrents())
        }

        // Store the function reference to be able to remove it later
        torrent._updatePeersFn = updatePeers;

        // Listen for peer changes for real-time updates
        torrent.drive.core.on('peer-add', updatePeers)
        torrent.drive.core.on('peer-remove', updatePeers)

        // Initial update
        updatePeers()
    }

    getTorrents() {
        return Array.from(this.torrents.values()).map(t => ({
            key: t.key,
            name: t.name,
            size: t.size,
            type: t.type,
            peers: t.peers,
            progress: t.progress,
            error: t.error,
            fileCount: t.fileCount,
            files: t.files // Return file list for selection
        }))
    }

    async stop() {
        console.log(`[Stop] Shutting down TorrentManager...`)
        for (const key of this.torrents.keys()) {
            await this.remove(key)
        }
        await this.swarm.destroy()
        // Close any remaining stores
        for (const store of this.stores.values()) {
            await store.close().catch(() => { })
        }
        this.stores.clear()
        await this.rootStore.close()
    }
}
