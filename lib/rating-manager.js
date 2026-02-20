import Hyperdrive from 'hyperdrive'
import hccrypto from 'hypercore-crypto'
import crypto from 'crypto'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'

// Удалены хардкод-константы RATINGS_CACHE_FILE и IDENTITY_FILE

export class RatingManager {
    constructor(rootStore, swarm, storagePath = './nectar-data') {
        this.rootStore = rootStore
        this.swarm = swarm
        this.storagePath = storagePath

        this.cacheFile = path.join(this.storagePath, 'ratings-cache.json')
        this.identityFile = path.join(this.storagePath, 'rating-identity.json')

        // Создаём отдельный namespace для рейтингов
        const ratingsNamespace = rootStore.namespace('ratings-public')
        this.ratingDrive = new Hyperdrive(ratingsNamespace)

        // Ключи для подписи оценок
        this.keyPair = this._loadOrCreateKeyPair()

        // Локальный кэш рейтингов
        this.localRatings = new Map()      // Мои оценки других пиров
        this.peerRatingsCache = new Map()  // Кэш оценок от других пиров
        this.externalDrives = new Map()    // Ключи драйвов других пиров: peerKey -> driveKey

        // Топик для обмена рейтингами
        this.ratingTopic = b4a.from(
            crypto.createHash('sha256')
                .update('nectar-ratings')
                .digest()
        )

        this._init()
    }

    _loadOrCreateKeyPair() {
        try {
            if (fs.existsSync(this.identityFile)) {
                const data = JSON.parse(fs.readFileSync(this.identityFile, 'utf-8'))
                const keyPair = {
                    publicKey: b4a.from(data.publicKey, 'hex'),
                    secretKey: b4a.from(data.secretKey, 'hex')
                }
                console.log('[Rating] Identity loaded')
                return keyPair
            }
        } catch (err) {
            console.error('[Rating] Key load error:', err.message)
        }

        // Создаём новую пару ключей
        const keyPair = hccrypto.keyPair()

        // Сохраняем
        const dir = path.dirname(this.identityFile)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }

        fs.writeFileSync(this.identityFile, JSON.stringify({
            publicKey: b4a.toString(keyPair.publicKey, 'hex'),
            secretKey: b4a.toString(keyPair.secretKey, 'hex'),
            createdAt: new Date().toISOString()
        }))

        console.log('[Rating] Created new identity')
        return keyPair
    }

    async _init() {
        await this.ratingDrive.ready()

        console.log('[Rating] Drive ready, key:',
            b4a.toString(this.ratingDrive.key, 'hex').slice(0, 16) + '...')

        // Репликация через swarm
        this.swarm.on('connection', (conn, peerInfo) => {
            console.log(`[Rating] New connection with ${b4a.toString(peerInfo.publicKey, 'hex').slice(0, 8)}`)
            this.ratingDrive.replicate(conn)
            this._exchangeDriveKeys(conn)
        })

        // Проверяем существующие соединения
        for (const conn of this.swarm.connections) {
            this.ratingDrive.replicate(conn)
            this._exchangeDriveKeys(conn)
        }

        // Загружаем кэш
        this._loadCache()

        // Публикуем свой drive в DHT
        this.swarm.join(this.ratingTopic, { server: true, client: true })
        console.log('[Rating] Joined ratings topic')
    }

    _exchangeDriveKeys(conn) {
        // Отправляем свой ключ драйва и публичный ключ (identity)
        const myKey = b4a.toString(this.ratingDrive.key, 'hex')
        const myId = b4a.toString(this.keyPair.publicKey, 'hex')

        const handshake = JSON.stringify({
            type: 'nectar-rating-handshake',
            driveKey: myKey,
            peerKey: myId
        })

        conn.write(handshake)

        conn.on('data', (data) => {
            try {
                const msg = JSON.parse(data.toString())
                if (msg.type === 'nectar-rating-handshake') {
                    console.log(`[Rating] Received drive key from ${msg.peerKey.slice(0, 8)}: ${msg.driveKey.slice(0, 8)}`)
                    this.externalDrives.set(msg.peerKey, msg.driveKey)

                    // Реплицируем драйв этого пира
                    const peerDriveKey = b4a.from(msg.driveKey, 'hex')
                    const peerStore = this.rootStore.namespace('external-ratings-' + msg.peerKey)
                    const peerDrive = new Hyperdrive(peerStore, peerDriveKey)
                    peerDrive.ready().then(() => {
                        peerDrive.replicate(conn)
                    })
                }
            } catch (err) {
                // Игнорируем не-JSON данные (вероятно репликация)
            }
        })
    }

    _loadCache() {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'))

                for (const [key, rating] of Object.entries(data.local || {})) {
                    this.localRatings.set(key, rating)
                }
                for (const [key, rating] of Object.entries(data.cache || {})) {
                    this.peerRatingsCache.set(key, rating)
                }
                console.log(`[Rating] Loaded ${this.localRatings.size} local ratings from cache`)
            }
        } catch (err) {
            console.error('[Rating] Cache load error:', err.message)
        }
    }

    _saveCache() {
        try {
            const dir = path.dirname(this.cacheFile)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }

            const cache = {
                version: 1,
                updatedAt: new Date().toISOString(),
                local: Object.fromEntries(this.localRatings),
                cache: Object.fromEntries(this.peerRatingsCache)
            }

            fs.writeFileSync(this.cacheFile, JSON.stringify(cache, null, 2))
        } catch (err) {
            console.error('[Rating] Cache save error:', err.message)
        }
    }

    /**
     * Оценить пира (подписать и сохранить)
     */
    async ratePeer(peerKey, rating) {
        // Проверяем, не оцениваем ли мы свою же раздачу
        const myPublicKey = b4a.toString(this.keyPair.publicKey, 'hex')
        if (peerKey === myPublicKey) {
            throw new Error('Cannot rate yourself')
        }

        const timestamp = Date.now()
        const ratingId = crypto.randomBytes(16).toString('hex')

        // Данные оценки
        const ratingData = {
            id: ratingId,
            peerKey,
            speed: Math.max(1, Math.min(5, rating.speed)),
            reliability: Math.max(1, Math.min(5, rating.reliability)),
            communication: rating.communication ? Math.max(1, Math.min(5, rating.communication)) : null,
            comment: rating.comment || '',
            timestamp
        }

        // Подписываем оценку
        const message = JSON.stringify({
            peerKey,
            speed: ratingData.speed,
            reliability: ratingData.reliability,
            timestamp
        })

        const signature = hccrypto.sign(b4a.from(message), this.keyPair.secretKey)

        const signedRating = {
            ...ratingData,
            signature: b4a.toString(signature, 'hex'),
            signer: b4a.toString(this.keyPair.publicKey, 'hex')
        }

        // Сохраняем в Hyperdrive
        const filePath = `/ratings/${peerKey}/${ratingId}.json`
        await this.ratingDrive.put(filePath, JSON.stringify(signedRating, null, 2))

        // Сохраняем локально
        this._updateLocalRating(peerKey, signedRating)
        this._saveCache()

        console.log(`[Rating] Rated peer ${peerKey.slice(0, 8)}... (${ratingData.speed}/${ratingData.reliability})`)
        return ratingId
    }

    _updateLocalRating(peerKey, rating) {
        const existing = this.localRatings.get(peerKey) || {
            ratings: [],
            averageSpeed: 0,
            averageReliability: 0,
            totalRatings: 0
        }

        existing.ratings.push(rating)
        existing.totalRatings++

        const validRatings = existing.ratings.filter(r => this._verifyRating(r))
        if (validRatings.length > 0) {
            existing.averageSpeed = validRatings.reduce((sum, r) => sum + r.speed, 0) / validRatings.length
            existing.averageReliability = validRatings.reduce((sum, r) => sum + r.reliability, 0) / validRatings.length
        }

        this.localRatings.set(peerKey, existing)
    }

    _verifyRating(rating) {
        try {
            const message = JSON.stringify({
                peerKey: rating.peerKey,
                speed: rating.speed,
                reliability: rating.reliability,
                timestamp: rating.timestamp
            })

            const signature = b4a.from(rating.signature, 'hex')
            const signer = b4a.from(rating.signer, 'hex')

            return hccrypto.verify(b4a.from(message), signature, signer)
        } catch (err) {
            return false
        }
    }

    async _readRatingEntry(drive, key) {
        try {
            const content = await drive.get(key)
            if (!content) return null
            return JSON.parse(content.toString())
        } catch (err) {
            return null
        }
    }

    /**
     * Получить рейтинг пира (локальный + кэш)
     */
    getRating(peerKey) {
        return this.localRatings.get(peerKey) ||
            this.peerRatingsCache.get(peerKey) || null
    }

    /**
     * Запросить рейтинг пира из сети
     */
    async fetchPeerRatings(peerKey) {
        console.log(`[Rating] Fetching ratings for ${peerKey.slice(0, 8)}...`)

        const ratings = []

        try {
            // Ждём подключения к пирам (опционально)
            await this._waitForPeers(5000).catch(() => { })

            // 1. Проверяем свой локальный драйв (на случай если мы скачали чужие данные)
            for await (const entry of this.ratingDrive.list()) {
                if (entry.key.includes(`/ratings/${peerKey}/`)) {
                    ratings.push(await this._readRatingEntry(this.ratingDrive, entry.key))
                }
            }

            // 2. Проверяем все известные внешние драйвы
            for (const [signerKey, driveKey] of this.externalDrives) {
                const peerStore = this.rootStore.namespace('external-ratings-' + signerKey)
                const peerDrive = new Hyperdrive(peerStore, b4a.from(driveKey, 'hex'))
                await peerDrive.ready()

                try {
                    for await (const entry of peerDrive.list()) {
                        if (entry.key.includes(`/ratings/${peerKey}/`)) {
                            ratings.push(await this._readRatingEntry(peerDrive, entry.key))
                        }
                    }
                } catch (err) {
                    console.warn(`[Rating] Failed to list ratings from ${signerKey.slice(0, 8)}`)
                }
            }
        } catch (err) {
            console.error('[Rating] Fetch error:', err.message)
        }

        // Фильтруем пустые и невалидные рейтинги
        const validRatings = ratings.filter(r => r && this._verifyRating(r))

        // Кэшируем найденные рейтинги
        if (validRatings.length > 0) {
            this.peerRatingsCache.set(peerKey, {
                ratings: validRatings,
                averageSpeed: validRatings.reduce((sum, r) => sum + r.speed, 0) / validRatings.length,
                averageReliability: validRatings.reduce((sum, r) => sum + r.reliability, 0) / validRatings.length,
                totalRatings: validRatings.length,
                fetchedAt: Date.now()
            })
            this._saveCache()
        }

        return validRatings;
    }

    _waitForPeers(timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (this.ratingDrive.core.peers.length > 0) {
                return resolve()
            }

            const timer = setTimeout(() => reject(new Error('Timeout')), timeout)

            const check = () => {
                if (this.ratingDrive.core.peers.length > 0) {
                    clearTimeout(timer)
                    resolve()
                }
            }

            this.ratingDrive.core.once('peer-add', check)
        })
    }

    /**
     * Получить все локальные рейтинги
     */
    getAllRatings() {
        const result = []
        for (const [key, rating] of this.localRatings) {
            result.push({
                peerKey: key,
                ...rating,
                trustScore: this.calculateTrustScore(key)
            })
        }
        return result.sort((a, b) => b.trustScore - a.trustScore)
    }

    /**
     * Получить топ пиров
     */
    getTopPeers(limit = 10) {
        return this.getAllRatings().slice(0, limit)
    }

    /**
     * Рассчитать доверие (0-100)
     */
    calculateTrustScore(peerKey) {
        const rating = this.getRating(peerKey)
        if (!rating || rating.totalRatings === 0) return 50

        let score = (rating.averageSpeed + rating.averageReliability) / 2 * 10
        return Math.max(0, Math.min(100, Math.round(score)))
    }

    /**
     * Проверить, является ли пир доверенным
     */
    isTrusted(peerKey, threshold = 70) {
        return this.calculateTrustScore(peerKey) >= threshold
    }

    /**
     * Экспорт всех рейтингов (для передачи другому пиру)
     */
    async exportRatings() {
        const ratings = []

        try {
            // Сканируем все файлы в директории ratings
            for await (const entry of this.ratingDrive.list()) {
                if (entry.key.startsWith('/ratings/') && entry.key.endsWith('.json')) {
                    const content = await this.ratingDrive.get(entry.key)
                    const rating = JSON.parse(content.toString())
                    ratings.push(rating)
                }
            }
        } catch (err) {
            console.error('[Rating] Export error:', err.message)
        }

        return ratings
    }

    /**
     * Импорт рейтингов от другого пира
     */
    async importRatings(ratings) {
        let imported = 0

        for (const rating of ratings) {
            // Верифицируем подпись
            if (!this._verifyRating(rating)) {
                console.warn('[Rating] Invalid signature, skipping')
                continue
            }

            const peerKey = rating.peerKey
            const existing = this.peerRatingsCache.get(peerKey) || {
                ratings: [],
                averageSpeed: 0,
                averageReliability: 0,
                totalRatings: 0
            }

            // Проверяем, нет ли уже такого rating
            if (existing.ratings.find(r => r.id === rating.id)) {
                continue
            }

            existing.ratings.push(rating)
            existing.totalRatings++
            existing.averageSpeed = existing.ratings.reduce((sum, r) => sum + r.speed, 0) / existing.ratings.length
            existing.averageReliability = existing.ratings.reduce((sum, r) => sum + r.reliability, 0) / existing.ratings.length
            existing.fetchedAt = Date.now()

            this.peerRatingsCache.set(peerKey, existing)
            imported++
        }

        this._saveCache()
        console.log(`[Rating] Imported ${imported} ratings`)
        return imported
    }

    /**
     * Удалить рейтинг
     */
    async removeRating(peerKey, ratingId) {
        try {
            // Удаляем файл из Hyperdrive
            const filePath = `/ratings/${peerKey}/${ratingId}.json`
            await this.ratingDrive.del(filePath)

            const rating = this.localRatings.get(peerKey)
            if (rating) {
                rating.ratings = rating.ratings.filter(r => r.id !== ratingId)
                rating.totalRatings = rating.ratings.length

                if (rating.ratings.length > 0) {
                    const validRatings = rating.ratings.filter(r => this._verifyRating(r))
                    if (validRatings.length > 0) {
                        rating.averageSpeed = validRatings.reduce((sum, r) => sum + r.speed, 0) / validRatings.length
                        rating.averageReliability = validRatings.reduce((sum, r) => sum + r.reliability, 0) / validRatings.length
                    } else {
                        rating.averageSpeed = 0
                        rating.averageReliability = 0
                    }
                } else {
                    this.localRatings.delete(peerKey)
                }

                this._saveCache()
            }

            console.log(`[Rating] Removed rating ${ratingId} for peer ${peerKey}`)
            return true
        } catch (err) {
            console.error('[Rating] Remove rating error:', err.message)
            return false
        }
    }

    /**
     * Получить публичный ключ drive с рейтингами
     */
    getRatingsDriveKey() {
        return b4a.toString(this.ratingDrive.key, 'hex')
    }

    /**
     * Получить свой публичный ключ (для проверки "не свой ли это пир")
     */
    getMyPublicKey() {
        return b4a.toString(this.keyPair.publicKey, 'hex')
    }

    /**
     * Получить статистику моей активности
     */
    getMyStats() {
        return {
            totalRatings: Array.from(this.localRatings.values())
                .reduce((sum, r) => sum + r.totalRatings, 0),
            uniquePeers: this.localRatings.size,
            identity: b4a.toString(this.keyPair.publicKey, 'hex').slice(0, 16) + '...'
        }
    }

    /**
     * Обновить статистику пира (uploads/downloads/reports)
     */
    updatePeerStats(peerKey, statsUpdate) {
        const stats = this.peerRatingsCache.get(peerKey) || {
            ratings: [],
            averageSpeed: 0,
            averageReliability: 0,
            totalRatings: 0,
            uploads: 0,
            downloads: 0,
            reports: 0
        }

        if (statsUpdate.uploads) stats.uploads++
        if (statsUpdate.downloads) stats.downloads++
        if (statsUpdate.reports) stats.reports += statsUpdate.reports

        this.peerRatingsCache.set(peerKey, stats)
        this._saveCache()
    }
}
