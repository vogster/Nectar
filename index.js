import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import b4a from 'b4a'
import fs from 'fs'
import { pipeline } from 'stream/promises'

const store = new Corestore('./pear-data')
const swarm = new Hyperswarm()

swarm.on('connection', (conn) => {
  console.log('--- Новое подключение! ---')
  conn.on('error', (err) => console.error('Ошибка соединения:', err.message))
  store.replicate(conn)
})

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

// Ожидание появления файла с retry-логикой
async function waitForFile(drive, filePath, retries = 10, interval = 3000) {
  for (let i = 0; i < retries; i++) {
    await drive.core.update()
    const entry = await drive.entry(filePath)
    if (entry) return true
    console.log(`Файл ещё не получен, попытка ${i + 1}/${retries}...`)
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

async function main() {
  const arg = process.argv[2]

  // Определяем режим по виду аргумента:
  // hex-строка 64 символа → режим скачивания
  // всё остальное (путь к файлу) → режим раздачи
  const isKey = arg && /^[0-9a-f]{64}$/i.test(arg)

  const argumentKey = isKey ? arg : null
  const key = argumentKey ? b4a.from(argumentKey, 'hex') : null

  const drive = new Hyperdrive(store, key)
  await drive.ready()

  const discovery = swarm.join(drive.discoveryKey, { server: true, client: true })
  await discovery.flushed()
  console.log('Поиск пиров...')

  // Graceful shutdown
  const shutdown = async (reason) => {
    console.log(`\nЗавершаю работу (${reason})...`)
    await swarm.destroy()
    await store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  if (!argumentKey) {
    // -------------------------
    // РЕЖИМ РАЗДАЧИ
    // -------------------------
    console.log('--- РЕЖИМ СОЗДАТЕЛЯ ---')

    const sourceFile = arg
    if (!sourceFile) {
      console.error('Укажите путь к файлу: node index.js /path/to/file')
      process.exit(1)
    }
    if (!fs.existsSync(sourceFile)) {
      console.error(`Файл не найден: ${sourceFile}`)
      process.exit(1)
    }

    const stat = fs.statSync(sourceFile)
    console.log(`Добавляю файл (${(stat.size / 1024 / 1024).toFixed(1)} MB) через стрим...`)

    const readStream = fs.createReadStream(sourceFile)
    const writeStream = drive.createWriteStream('/file')
    await pipeline(readStream, writeStream)

    console.log('Файл успешно добавлен в P2P-сеть!')
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

    // Опциональный третий аргумент — куда сохранить файл
    const savePath = process.argv[3] || './downloaded-file'

    console.log('Жду подключения к пиру...')
    try {
      await waitForPeer(swarm)
    } catch (err) {
      console.error(err.message)
      await shutdown('timeout')
    }

    console.log('Пир найден! Жду файл...')
    const found = await waitForFile(drive, '/file')

    if (!found) {
      console.error('Файл так и не появился. Проверьте ключ и доступность раздающего.')
      await shutdown('not-found')
      return
    }

    console.log(`Скачиваю файл → ${savePath}`)

    const readStream = drive.createReadStream('/file')
    const writeStream = fs.createWriteStream(savePath)
    await pipeline(readStream, writeStream)

    console.log(`Готово! Файл сохранён: ${savePath}`)
    await shutdown('done')
  }
}

main().catch(async (err) => {
  console.error('Критическая ошибка:', err)
  await swarm.destroy()
  await store.close()
  process.exit(1)
})