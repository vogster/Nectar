import fs from 'fs'
import path from 'path'

export class SettingsManager {
    constructor(configPath = './nectar-data/config.json') {
        this.configPath = path.resolve(configPath)
        this.settings = {
            // Основные настройки
            downloadPath: './downloads',
            seedPath: path.dirname(this.configPath), // По умолчанию совпадает с папкой конфига

            // Сетевые настройки
            port: 3000,
            maxConnections: 100,
            enableDHT: true,

            // Настройки загрузки
            autoStartDownloads: true,
            maxConcurrentDownloads: 3,
            maxUploadSpeed: 0, // 0 = без ограничений (MB/s)
            maxDownloadSpeed: 0,

            // UI настройки
            theme: 'dark',
            language: 'en',
            minimizeToTray: false,
            startMinimized: false,

            // Уведомления
            notifyOnDownloadComplete: true,
            notifyOnPeerConnect: false,

            // Приватность
            enableAnalytics: false,
            shareUsageStats: false
        }

        this.load()
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = fs.readFileSync(this.configPath, 'utf-8')
                const saved = JSON.parse(data)
                this.settings = { ...this.settings, ...saved }
                console.log('[Settings] Loaded from', this.configPath)
            } else {
                this.save()
                console.log('[Settings] Created default config')
            }
        } catch (err) {
            console.error('[Settings] Load error:', err.message)
        }
    }

    save() {
        try {
            const dir = path.dirname(this.configPath)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            fs.writeFileSync(this.configPath, JSON.stringify(this.settings, null, 2))
            console.log('[Settings] Saved to', this.configPath)
        } catch (err) {
            console.error('[Settings] Save error:', err.message)
        }
    }

    get(key) {
        return this.settings[key]
    }

    set(key, value) {
        this.settings[key] = value

        // Если меняем путь данных, обновляем и путь конфига для будущих сохранений
        if (key === 'seedPath') {
            const newConfigPath = path.join(value, 'config.json')
            // Мы не переносим файл физически здесь (это сделает пользователь или сервер при рестарте),
            // но запоминаем, куда писать в следующий раз.
            this.configPath = path.resolve(newConfigPath)
        }

        this.save()
    }

    getAll() {
        return { ...this.settings }
    }

    update(newSettings) {
        this.settings = { ...this.settings, ...newSettings }

        if (newSettings.seedPath) {
            this.configPath = path.resolve(path.join(newSettings.seedPath, 'config.json'))
        }

        this.save()
    }

    reset() {
        const defaultSettings = {
            downloadPath: './downloads',
            seedPath: './nectar-data',
            port: 3000,
            maxConnections: 100,
            enableDHT: true,
            autoStartDownloads: true,
            maxConcurrentDownloads: 3,
            maxUploadSpeed: 0,
            maxDownloadSpeed: 0,
            theme: 'dark',
            language: 'en',
            minimizeToTray: false,
            startMinimized: false,
            notifyOnDownloadComplete: true,
            notifyOnPeerConnect: false,
            enableAnalytics: false,
            shareUsageStats: false
        }
        this.settings = defaultSettings
        this.save()
    }
}
