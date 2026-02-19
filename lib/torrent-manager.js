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
        this.swarm = new Hyperswarm()
        this.torrents = new Map() // key -> torrent info
        this.stores = new Map() // key -> Corestore instance (for isolation)

        this.swarm.on('connection', (conn) => {
            // Replicate all active stores
            for (const store of this.stores.values()) {
                store.replicate(conn)
            }
        })
    }

    async seed(sourcePath) {
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Path not found: ${sourcePath}`)
        }

        // Создаём уникальное хранилище для каждой раздачи
        const sessionId = crypto.randomBytes(16).toString('hex')
        const sessionPath = path.join(this.storagePath, 'sessions', sessionId)
        const sessionStore = new Corestore(sessionPath)

        console.log(`[Seed] Starting seed for: ${sourcePath}`)
        const drive = new Hyperdrive(sessionStore)
        await drive.ready()

        const key = b4a.toString(drive.key, 'hex')
        const name = path.basename(sourcePath)
        const stat = fs.statSync(sourcePath)
        const isDirectory = stat.isDirectory()

        console.log(`[Seed] Drive ready, key: ${key}, type: ${isDirectory ? 'directory' : 'file'}`)

        const controller = new AbortController()
        const torrent = {
            key,
            name,
            size: stat.size,
            type: isDirectory ? 'seeding-dir' : 'seeding',
            drive,
            store: sessionStore,
            sessionPath,
            peers: 0,
            progress: 0,
            controller,
            activeTransfer: true,
            fileCount: 0
        }
        this.torrents.set(key, torrent)
        this.stores.set(key, sessionStore)

        try {
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
        
        // Создаём уникальное хранилище для каждой загрузки
        const sessionId = crypto.randomBytes(16).toString('hex')
        const sessionPath = path.join(this.storagePath, 'sessions', sessionId)
        const sessionStore = new Corestore(sessionPath)
        
        const drive = new Hyperdrive(sessionStore, key)
        await drive.ready()

        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true })
        }

        console.log(`[Download] Drive ready. Joining swarm...`)
        const discovery = this.swarm.join(drive.discoveryKey, { server: true, client: true })

        const controller = new AbortController()
        const torrent = {
            key: keyHex,
            name: 'Identifying...',
            size: 0,
            type: 'downloading',
            drive,
            store: sessionStore,
            sessionPath,
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
        this._startDownload(keyHex)

        return torrent
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

    async _startDownload(keyHex) {
        const torrent = this.torrents.get(keyHex)
        if (!torrent) return
        const drive = torrent.drive
        const signal = torrent.controller.signal

        try {
            torrent.activeTransfer = true
            console.log(`[Download] Waiting for metadata: ${keyHex}`)
            await drive.core.update({ signal })

            // Получаем список всех файлов
            const entries = []
            while (entries.length === 0 && this.torrents.has(keyHex)) {
                if (signal.aborted) throw new Error('AbortError')
                await drive.core.update({ signal })
                for await (const entry of drive.list()) {
                    if (entry.value.blob) {
                        entries.push(entry)
                    }
                }
                if (entries.length === 0) await new Promise(r => setTimeout(r, 2000))
            }

            if (!this.torrents.has(keyHex)) return

            // Определяем тип контента
            const hasMultipleFiles = entries.length > 1
            const hasRootFile = entries.some(e => e.key === '/file')
            const isDirectory = hasMultipleFiles || !hasRootFile

            if (isDirectory) {
                // Скачивание директории
                torrent.type = 'downloading-dir'
                torrent.name = `downloaded-${keyHex.slice(0, 6)}`
                torrent.fileCount = entries.length
                
                // Считаем общий размер
                let totalSize = 0
                for (const entry of entries) {
                    totalSize += entry.value.blob.length || 0
                }
                torrent.size = totalSize
                
                this.emit('update', this.getTorrents())

                const baseSavePath = path.join(torrent.saveDir, torrent.name)
                let downloadedSize = 0

                for (const entry of entries) {
                    if (signal.aborted) throw new Error('AbortError')
                    
                    const filePath = entry.key.startsWith('/') ? entry.key.slice(1) : entry.key
                    const fullPath = path.join(baseSavePath, filePath)
                    
                    const dir = path.dirname(fullPath)
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true })
                    }

                    console.log(`[Download] ${torrent.key.slice(0, 6)}: ${filePath}`)
                    
                    const readStream = drive.createReadStream(entry.key)
                    const writeStream = fs.createWriteStream(fullPath)
                    
                    await new Promise((resolve, reject) => {
                        readStream.on('data', (chunk) => {
                            downloadedSize += chunk.length
                            torrent.progress = Math.round((downloadedSize / torrent.size) * 100)
                            this.emit('update', this.getTorrents())
                        })
                        readStream.pipe(writeStream)
                            .on('finish', resolve)
                            .on('error', reject)
                    })
                }
            } else {
                // Скачивание одного файла
                const entry = entries[0]
                torrent.name = `downloaded-${keyHex.slice(0, 6)}`
                torrent.size = entry.value.blob.length || 0
                torrent.fileCount = 1
                this.emit('update', this.getTorrents())

                const savePath = path.join(torrent.saveDir, torrent.name)
                let downloaded = 0
                const readStream = drive.createReadStream('/file')
                const writeStream = fs.createWriteStream(savePath)

                readStream.on('data', (chunk) => {
                    downloaded += chunk.length
                    torrent.progress = Math.round((downloaded / torrent.size) * 100)
                    this.emit('update', this.getTorrents())
                })

                await pipeline(readStream, writeStream, { signal })
            }

            torrent.progress = 100
            torrent.activeTransfer = false
            this.emit('update', this.getTorrents())

        } catch (err) {
            torrent.activeTransfer = false
            if (err.name === 'AbortError' || signal.aborted) {
                console.log(`[Download] Aborted: ${keyHex}`)
            } else {
                console.error(`[Download] Error: ${err.message}`)
                if (this.torrents.has(keyHex)) {
                    torrent.error = err.message
                    this.emit('update', this.getTorrents())
                }
            }
        }
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
            fileCount: t.fileCount
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
            await store.close().catch(() => {})
        }
        this.stores.clear()
    }
}
