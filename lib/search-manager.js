import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import crypto from 'crypto'
import { EventEmitter } from 'events'

export class SearchManager extends EventEmitter {
    constructor(rootStore, swarm) {
        super()
        this.rootStore = rootStore
        this.swarm = swarm

        // Мой локальный каталог
        const searchNamespace = rootStore.namespace('search-public')
        this.searchDrive = new Hyperdrive(searchNamespace)

        // Каталоги других пиров: peerKey -> { drive, driveKey }
        this.peerCatalogs = new Map()

        // Топик для поиска пиров с каталогами
        this.searchTopic = b4a.from(
            crypto.createHash('sha256')
                .update('nectar-search-v1')
                .digest()
        )

        this._init()
    }

    async _init() {
        await this.searchDrive.ready()
        console.log('[Search] My catalog ready, key:', b4a.toString(this.searchDrive.key, 'hex').slice(0, 16) + '...')

        // Репликация и обмен ключами
        this.swarm.on('connection', (conn, peerInfo) => {
            console.log(`[Search] New connection with ${b4a.toString(peerInfo.publicKey, 'hex').slice(0, 8)}`)
            this.searchDrive.replicate(conn)
            this._exchangeCatalogKeys(conn)
        })

        // Также проверяем уже существующие соединения (на случай если мы пропустили событие)
        for (const conn of this.swarm.connections) {
            this.searchDrive.replicate(conn)
            this._exchangeCatalogKeys(conn)
        }

        // Присоединяемся к топику поиска
        this.swarm.join(this.searchTopic, { server: true, client: true })
        console.log('[Search] Joined global search topic')
    }

    _exchangeCatalogKeys(conn) {
        const myId = b4a.toString(this.swarm.keyPair.publicKey, 'hex')
        const myCatalogKey = b4a.toString(this.searchDrive.key, 'hex')

        const handshake = JSON.stringify({
            type: 'nectar-search-handshake',
            catalogKey: myCatalogKey,
            peerKey: myId
        })

        conn.write(handshake)

        conn.on('data', (data) => {
            try {
                const msg = JSON.parse(data.toString())
                if (msg.type === 'nectar-search-handshake') {
                    this._addPeerCatalog(msg.peerKey, msg.catalogKey, conn)
                }
            } catch (err) { }
        })
    }

    async _addPeerCatalog(peerKey, catalogKey, conn) {
        if (this.peerCatalogs.has(peerKey)) return

        console.log(`[Search] Found peer catalog from ${peerKey.slice(0, 8)}: ${catalogKey.slice(0, 8)}`)

        const peerDriveKey = b4a.from(catalogKey, 'hex')
        const peerStore = this.rootStore.namespace('external-search-' + peerKey)
        const peerDrive = new Hyperdrive(peerStore, peerDriveKey)

        await peerDrive.ready()
        peerDrive.replicate(conn)

        this.peerCatalogs.set(peerKey, {
            drive: peerDrive,
            driveKey: catalogKey
        })
    }

    /**
     * Добавить раздачу в мой публичный каталог
     */
    async addToCatalog(torrent) {
        try {
            const entry = {
                key: torrent.key,
                name: torrent.name,
                size: torrent.size,
                fileCount: torrent.fileCount,
                type: torrent.type,
                createdAt: torrent.createdAt || new Date().toISOString()
            }

            await this.searchDrive.put(`/torrents/${torrent.key}.json`, JSON.stringify(entry))
            console.log(`[Search] Added to catalog: ${torrent.name}`)
        } catch (err) {
            console.error('[Search] Failed to add to catalog:', err.message)
        }
    }

    /**
     * Удалить раздачу из моего каталога
     */
    async removeFromCatalog(keyHex) {
        try {
            await this.searchDrive.del(`/torrents/${keyHex}.json`)
        } catch (err) { }
    }

    /**
     * Глобальный поиск по всем каталогам
     */
    async search(query) {
        const results = []
        const q = query.toLowerCase()

        // 1. Поиск в моем каталоге
        await this._searchInDrive(this.searchDrive, q, 'local', results)

        // 2. Поиск в каталогах пиров
        for (const [peerKey, catalog] of this.peerCatalogs) {
            await this._searchInDrive(catalog.drive, q, peerKey, results)
        }

        // Удаляем дубликаты по ключу торрента
        const uniqueResults = Array.from(new Map(results.map(r => [r.key, r])).values())
        return uniqueResults.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    async _searchInDrive(drive, query, peerKey, results) {
        try {
            await drive.core.update().catch(() => { })
            for await (const entry of drive.list('/torrents/')) {
                try {
                    const data = await drive.get(entry.key)
                    if (!data) continue

                    const torrent = JSON.parse(data.toString())

                    // Валидация данных торрента
                    if (!torrent || !torrent.name || !torrent.key) continue

                    if (torrent.name.toLowerCase().includes(query)) {
                        results.push({
                            ...torrent,
                            peerKey: peerKey // Кто раздает (для информации)
                        })
                    }
                } catch (parseErr) {
                    console.warn(`[Search] Failed to parse entry ${entry.key}:`, parseErr.message)
                }
            }
        } catch (err) {
            console.warn(`[Search] Failed to search in drive for peer ${peerKey}:`, err.message)
        }
    }
}
