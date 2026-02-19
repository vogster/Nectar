import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
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

// Ожидание подключения хотя бы одного пира
function waitForPeer(swarm, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (swarm.connections.size > 0) return resolve()

    const timer = setTimeout(() => {
      reject(new Error(`Пир не найден за ${timeout / 1000} секунд`))
    }, timeout)

    swarm.once('connection', () => {
      clearTimeout(timer)
      setTimeout(resolve, 500)
    })
  })
}

// Ожидание появления файлов с retry-логикой
async function waitForFiles(drive, retries = 10, interval = 3000) {
  for (let i = 0; i < retries; i++) {
    await drive.core.update()
    const entries = []
    for await (const entry of drive.list()) {
      entries.push(entry)
    }
    if (entries.length > 0) return entries
    console.log(`Файлы ещё не получены, попытка ${i + 1}/${retries}...`)
    await new Promise((r) => setTimeout(r, interval))
  }
  return []
}

// Рекурсивное скачивание всех файлов из Hyperdrive
async function downloadAll(drive, saveDir) {
  let totalFiles = 0
  let downloadedFiles = 0

  console.log('[Download] Сканирование файлов...')
  
  // Сначала получаем список всех файлов
  const entries = []
  for await (const entry of drive.list()) {
    if (entry.value.blob) {
      entries.push(entry)
      totalFiles++
    }
  }

  if (totalFiles === 0) {
    console.error('[Download] Нет файлов для скачивания')
    return
  }

  console.log(`[Download] Найдено файлов: ${totalFiles}`)

  // Создаём директорию
  if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true })
  }

  // Скачиваем каждый файл
  for (const entry of entries) {
    // Убираем ведущий слэш и создаём путь
    const filePath = entry.key.startsWith('/') ? entry.key.slice(1) : entry.key
    const fullPath = path.join(saveDir, filePath)
    
    // Создаём родительские директории
    const dir = path.dirname(fullPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    console.log(`[Download] ${++downloadedFiles}/${totalFiles}: ${filePath}`)
    
    const readStream = drive.createReadStream(entry.key)
    const writeStream = fs.createWriteStream(fullPath)
    await pipeline(readStream, writeStream)
  }

  console.log(`[Download] Готово! Скачано ${downloadedFiles} файлов`)
}

// Рекурсивная загрузка всех файлов из директории в Hyperdrive
async function seedDirectory(drive, sourceDir) {
  const files = []
  
  console.log('[Seed] Сканирование директории...')
  for await (const file of walkDir(sourceDir)) {
    files.push(file)
  }

  if (files.length === 0) {
    throw new Error('Директория пуста')
  }

  console.log(`[Seed] Найдено файлов: ${files.length}`)

  let uploaded = 0
  const totalSize = files.reduce((sum, f) => sum + fs.statSync(f.fullPath).size, 0)
  let uploadedSize = 0

  for (const { fullPath, relativePath } of files) {
    // Используем относительный путь с ведущим слэшем
    const drivePath = '/' + relativePath.replace(/\\/g, '/')
    
    const stat = fs.statSync(fullPath)
    console.log(`[Seed] ${++uploaded}/${files.length}: ${relativePath} (${(stat.size / 1024).toFixed(1)} KB)`)

    const readStream = fs.createReadStream(fullPath)
    const writeStream = drive.createWriteStream(drivePath)
    await pipeline(readStream, writeStream)
    
    uploadedSize += stat.size
    const progress = ((uploadedSize / totalSize) * 100).toFixed(1)
    console.log(`[Seed] Прогресс: ${progress}%`)
  }

  console.log(`[Seed] Директория загружена: ${files.length} файлов, ${(totalSize / 1024 / 1024).toFixed(2)} MB`)
}

async function main() {
  const arg = process.argv[2]

  // Определяем режим по виду аргумента:
  // hex-строка 64 символа → режим скачивания
  // всё остальное (путь к файлу или директории) → режим раздачи
  const isKey = arg && /^[0-9a-f]{64}$/i.test(arg)
  const argumentKey = isKey ? arg : null

  const swarm = new Hyperswarm()

  // Graceful shutdown
  let store = null
  let drive = null
  let discovery = null

  const shutdown = async (reason) => {
    console.log(`\nЗавершаю работу (${reason})...`)
    if (discovery) await discovery.destroy()
    if (drive) await drive.close()
    if (store) await store.close()
    await swarm.destroy()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  if (!argumentKey) {
    // -------------------------
    // РЕЖИМ РАЗДАЧИ
    // -------------------------
    console.log('--- РЕЖИМ СОЗДАТЕЛЯ ---')

    const sourcePath = arg
    if (!sourcePath) {
      console.error('Укажите путь к файлу или директории: node index.js /path/to/file-or-dir')
      process.exit(1)
    }
    if (!fs.existsSync(sourcePath)) {
      console.error(`Путь не найден: ${sourcePath}`)
      process.exit(1)
    }

    // Создаём уникальное хранилище для этой раздачи
    const sessionId = crypto.randomBytes(16).toString('hex')
    const sessionPath = path.join('./pear-data', 'sessions', sessionId)
    store = new Corestore(sessionPath)
    drive = new Hyperdrive(store)
    await drive.ready()

    const discoveryKey = drive.discoveryKey
    discovery = swarm.join(discoveryKey, { server: true, client: true })
    await discovery.flushed()

    swarm.on('connection', (conn) => {
      console.log('--- Новое подключение! ---')
      conn.on('error', (err) => console.error('Ошибка соединения:', err.message))
      store.replicate(conn)
    })

    const stat = fs.statSync(sourcePath)
    
    if (stat.isDirectory()) {
      // Раздача директории
      console.log(`[Seed] Раздача директории: ${sourcePath}`)
      await seedDirectory(drive, sourcePath)
    } else {
      // Раздача одного файла
      console.log(`[Seed] Раздача файла: ${sourcePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
      const readStream = fs.createReadStream(sourcePath)
      const writeStream = drive.createWriteStream('/file')
      await pipeline(readStream, writeStream)
      console.log('[Seed] Файл загружен')
    }

    console.log('\n✅ Раздача готова!')
    console.log('\nВАШ КЛЮЧ (скопируйте его):')
    console.log(b4a.toString(drive.key, 'hex'))
    console.log('\nОжидаю подключения скачивающих... (Ctrl+C для выхода)')

    // Держим процесс живым для раздачи
    await new Promise(() => {})

  } else {
    // -------------------------
    // РЕЖИМ СКАЧИВАНИЯ
    // -------------------------
    console.log('--- РЕЖИМ СКАЧИВАНИЯ ---')

    const key = b4a.from(argumentKey, 'hex')

    // Создаём уникальное хранилище для этой загрузки
    const sessionId = crypto.randomBytes(16).toString('hex')
    const sessionPath = path.join('./pear-data', 'sessions', sessionId)
    store = new Corestore(sessionPath)
    drive = new Hyperdrive(store, key)
    await drive.ready()

    discovery = swarm.join(drive.discoveryKey, { server: true, client: true })
    await discovery.flushed()

    swarm.on('connection', (conn) => {
      console.log('--- Новое подключение! ---')
      conn.on('error', (err) => console.error('Ошибка соединения:', err.message))
      store.replicate(conn)
    })

    console.log('Поиск пиров...')

    // Опциональный третий аргумент — куда сохранить (файл или директорию)
    const savePath = process.argv[3] || './downloaded'

    console.log('Жду подключения к пиру...')
    try {
      await waitForPeer(swarm)
    } catch (err) {
      console.error(err.message)
      await shutdown('timeout')
    }

    console.log('Пир найден! Жду файлы...')
    const entries = await waitForFiles(drive)

    if (entries.length === 0) {
      console.error('Файлы так и не появились. Проверьте ключ и доступность раздающего.')
      await shutdown('not-found')
      return
    }

    // Определяем, что это: один файл или директория
    const hasMultipleFiles = entries.length > 1
    const hasRootFile = entries.some(e => e.key === '/file')

    if (hasMultipleFiles || !hasRootFile) {
      // Скачивание директории со структурой
      console.log(`[Download] Скачивание директории → ${savePath}`)
      await downloadAll(drive, savePath)
    } else {
      // Скачивание одного файла
      console.log(`[Download] Скачивание файла → ${savePath}`)
      const readStream = drive.createReadStream('/file')
      const writeStream = fs.createWriteStream(savePath)
      await pipeline(readStream, writeStream)
    }

    console.log(`\n✅ Готово! Файлы сохранены: ${savePath}`)
    await shutdown('done')
  }
}

main().catch(async (err) => {
  console.error('Критическая ошибка:', err)
  await swarm?.destroy()
  await store?.close()
  process.exit(1)
})
