require('dotenv').config()

const http = require('http')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const csrf = require('csurf')
const rateLimit = require('express-rate-limit')
const { Server } = require('socket.io')

const authRoutes = require('./routes/auth')
const analyticsRoutes = require('./routes/analytics')
const adminRoutes = require('./routes/admin')
const { attachAuditContext } = require('./middleware/audit')
const { syncRates, getLatestRates, fetchWingaRates, syncBranches } = require('./services/syncService')
const { getRates, refreshFromProvider } = require('./services/rateEngine')

const app = express()
const server = http.createServer(app)

const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const corsOptions = allowedOrigins.length
  ? { origin: allowedOrigins, credentials: true }
  : { origin: true }

const io = new Server(server, {
  cors: corsOptions,
})

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 140,
  standardHeaders: true,
  legacyHeaders: false,
})

app.use(helmet())
app.use(cors(corsOptions))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(attachAuditContext)
app.use('/api', limiter)

if (process.env.NODE_ENV === 'production') {
  const missing = ['FRONTEND_ORIGIN', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'WINGA_API_KEY', 'WINGA_API_SECRET']
    .filter((key) => !process.env[key])
  if (missing.length > 0) {
    console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
}

const csrfProtection = csrf({ cookie: { httpOnly: false, name: 'XSRF-TOKEN' } })
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() })
})

const rateRoutes = require('./routes/rates')
app.use('/api/auth', authRoutes)
app.use('/api/rates', rateRoutes)
app.use('/api/analytics', analyticsRoutes)
app.use('/api/admin', adminRoutes)

rateRoutes.onRateUpdate((data) => {
  io.emit('rates:update', data)
})

app.get('/health', (_req, res) => {
  res.json({
    service: 'Winga Forex Bureau API',
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/rates/public', async (_req, res) => {
  try {
    const dbRates = await getLatestRates()
    if (dbRates.rates?.length) {
      return res.json({
        rates: dbRates.rates,
        lastUpdated: dbRates.lastUpdated,
        source: 'database',
      })
    }
    const rates = getRates()
    if (Object.keys(rates).length > 0) {
      const formatted = Object.entries(rates).map(([code, quote], idx) => ({
        currency_code: code,
        currency_name: code,
        currency_actual_name: code,
        currency_sequence: idx + 1,
        buying_rate: quote.buy,
        selling_rate: quote.sell,
        effective_date_and_time: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      }))
      return res.json({
        rates: formatted,
        lastUpdated: new Date().toISOString(),
        source: 'exchangerate-api',
      })
    }
    return res.json({
      rates: [],
      lastUpdated: new Date().toISOString(),
      source: 'unavailable',
    })
  } catch (err) {
    console.error('[api] Failed to fetch public rates:', err.message)
    const rates = getRates()
    const formatted = Object.entries(rates).map(([code, quote], idx) => ({
      currency_code: code,
      currency_name: code,
      currency_actual_name: code,
      currency_sequence: idx + 1,
      buying_rate: quote.buy,
      selling_rate: quote.sell,
      effective_date_and_time: new Date().toISOString(),
    }))
    return res.json({
      rates: formatted,
      lastUpdated: new Date().toISOString(),
      source: 'exchangerate-api',
    })
  }
})

async function broadcastRates() {
  try {
    const dbRates = await getLatestRates()
    if (dbRates.rates?.length) {
      const ratesMap = dbRates.rates.reduce((acc, r) => {
        acc[r.currency_code] = { buy: r.buying_rate, sell: r.selling_rate }
        return acc
      }, {})
      io.emit('rates:update', { rates: ratesMap, source: 'database' })
      return
    }
    const rates = getRates()
    if (Object.keys(rates).length > 0) {
      io.emit('rates:update', { rates, source: 'exchangerate-api' })
    }
  } catch (err) {
    console.error('[socket] Broadcast failed:', err.message)
    const rates = getRates()
    if (Object.keys(rates).length > 0) {
      io.emit('rates:update', { rates, source: 'exchangerate-api' })
    }
  }
}

const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL_MS) || 15_000
setInterval(async () => {
  try {
    await syncRates()
    await broadcastRates()
  } catch (err) {
    console.error('[sync] Scheduled sync failed:', err.message)
  }
}, SYNC_INTERVAL)

if (process.env.NODE_ENV === 'production' && process.env.SERVE_STATIC) {
  const path = require('path')
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '..', 'public_html-ready')
  app.use(express.static(staticDir))
  app.get(/.*/, (req, res) => {
    if (req.path.startsWith('/api/')) return res.sendStatus(404)
    res.sendFile(path.join(staticDir, 'index.html'))
  })
}

io.on('connection', async (socket) => {
  await broadcastRates()
})

const runInitialSync = async () => {
  try {
    await refreshFromProvider('HEAD OFFICE')
  } catch (err) {
    console.error('[startup] Initial sync failed:', err.message)
  }
}

const port = Number(process.env.PORT || 4000)
runInitialSync().then(() => {
  server.listen(port, () => {
    console.log(`Winga backend running on port ${port}`)
  })
}).catch((err) => {
  console.error('[startup] Failed to initialize server:', err)
  process.exit(1)
})