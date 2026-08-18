require('dotenv').config()

const http = require('http')
const crypto = require('crypto')
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
const { syncRates, getLatestRates, fetchWingaRates, syncBranches, getSyncState, getLatestDbUpdate, loadSnapshot, getSnapshotInfo } = require('./services/syncService')
const { getRates, setCurrentRates } = require('./services/rateEngine')
const db = require('./config/db')

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

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.setHeader('Surrogate-Control', 'no-store')
  res.setHeader('Vary', 'Origin')
  res.setHeader('X-Request-ID', req.auditContext?.requestId || crypto.randomUUID())

  const originalJson = res.json.bind(res)
  res.json = function (body) {
    res.setHeader('X-Generated-At', new Date().toISOString())
    return originalJson(body)
  }
  next()
})

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
  io.emit('rates:update', { ...data, generatedAt: new Date().toISOString() })
})

app.get('/health', (_req, res) => {
  res.json({
    service: 'Winga Forex Bureau API',
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

app.get('/', (_req, res) => {
  res.json({
    status: 'online',
    service: 'Winga Backend API',
  })
})

app.get('/api/rates/public', async (_req, res) => {
  try {
    const dbRates = await getLatestRates()
    if (dbRates.rates?.length) {
      return res.json({
        rates: dbRates.rates,
        lastUpdated: dbRates.lastUpdated,
        source: dbRates.source,
      })
    }
    return res.json({
      rates: [],
      lastUpdated: new Date().toISOString(),
      source: 'unavailable',
    })
  } catch (err) {
    console.error('[api] Failed to fetch public rates:', err.message)
    return res.json({
      rates: [],
      lastUpdated: new Date().toISOString(),
      source: 'unavailable',
    })
  }
})

app.get('/api/winga-rates.php', async (req, res) => {
  const branch = req.query.branch || 'HEAD OFFICE'
  try {
    const { rates } = await fetchWingaRates(branch)
    const message = rates.map((r) => ({ ...r, source: 'winga-live' }))
    return res.json({ message })
  } catch (err) {
    console.error('[api] winga-rates proxy failed:', err.message)
    return res.status(503).json({ error: 'Winga rates unavailable', source: 'unavailable' })
  }
})

app.get('/api/winga-branches.php', async (_req, res) => {
  try {
    const result = await syncBranches()
    if (result.branches?.length) {
      return res.json({ message: result.branches })
    }
    return res.json({
      message: [
        { branch_name: 'HEAD OFFICE', branch_abbr: 'HO', city: 'Dar es Salaam', country: 'Tanzania', status: 'active' },
      ],
    })
  } catch (err) {
    console.error('[api] winga-branches proxy failed:', err.message)
    return res.json({
      message: [
        { branch_name: 'HEAD OFFICE', branch_abbr: 'HO', city: 'Dar es Salaam', country: 'Tanzania', status: 'active' },
      ],
    })
  }
})

function formatDuration(ms) {
  if (ms == null || ms < 0) return null
  const d = Math.floor(ms / 86400000)
  const h = Math.floor((ms % 86400000) / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

app.get('/api/debug/cache', async (_req, res) => {
  const syncState = getSyncState()

  const cacheHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store',
    'Vary': 'Origin',
  }

  const latestDb = await getLatestDbUpdate()

  const oldestAge = syncState.oldestEffectiveAgeMs
  const newestAge = syncState.newestEffectiveAgeMs

  return res.json({
    serverTime: new Date().toISOString(),

    lastWingaFetch: syncState.lastWingaFetchAt,
    lastWingaFetchError: syncState.lastWingaFetchError,
    lastWingaFetchAgeMs: syncState.lastWingaFetchAgeMs,
    lastWingaFetchRateCount: syncState.lastWingaFetchRateCount,

    providerTimestamp: syncState.providerTimestamp,
    providerAgeMs: syncState.providerAgeMs,
    providerAgeHuman: syncState.providerAgeMs != null ? formatDuration(syncState.providerAgeMs) : null,

    lastSuccessfulSync: {
      timestamp: syncState.lastSuccessfulSyncAt,
      ageMs: syncState.lastSuccessfulSyncAgeMs,
      ageHuman: syncState.lastSuccessfulSyncAgeMs != null ? formatDuration(syncState.lastSuccessfulSyncAgeMs) : null,
    },
    lastRejectedSync: {
      timestamp: syncState.lastRejectedSyncAt,
      ageMs: syncState.lastRejectedSyncAgeMs,
      ageHuman: syncState.lastRejectedSyncAgeMs != null ? formatDuration(syncState.lastRejectedSyncAgeMs) : null,
    },

    syncDecision: syncState.lastSyncDecision,
    staleReason: syncState.staleReason,

    wingaDataAge: {
      oldestEffectiveDateAndTime: syncState.oldestEffectiveDateAndTime,
      oldestAgeMs: oldestAge,
      oldestAgeHuman: oldestAge != null ? formatDuration(oldestAge) : null,
      newestEffectiveDateAndTime: syncState.newestEffectiveDateAndTime,
      newestAgeMs: newestAge,
      newestAgeHuman: newestAge != null ? formatDuration(newestAge) : null,
      staleThresholdMs: syncState.staleThresholdMs,
      isStale: oldestAge != null ? oldestAge > syncState.staleThresholdMs : null,
    },

    lastDatabaseUpdate: latestDb
      ? {
          latestUpdatedAt: latestDb.latest,
          latestEffectiveDateTime: latestDb.latestEffective,
          totalRows: Number(latestDb.total),
          adminPublishedRows: Number(latestDb.adminCount || 0),
          wingaSyncedRows: Number(latestDb.wingaCount || 0),
          databaseConnected: true,
        }
      : {
          databaseConnected: false,
          latestUpdatedAt: null,
          latestEffectiveDateTime: null,
          totalRows: 0,
        },

    databaseTimestamp: latestDb?.latest || null,
    databaseAgeMs: latestDb?.latest ? Date.now() - new Date(latestDb.latest).getTime() : null,
    databaseAgeHuman: latestDb?.latest ? formatDuration(Date.now() - new Date(latestDb.latest).getTime()) : null,

    snapshot: getSnapshotInfo(),

    inMemoryCache: {
      lastUpdated: syncState.inMemoryCacheAt,
      ageMs: syncState.inMemoryCacheAgeMs,
      ttlMs: syncState.inMemoryCacheTtlMs,
      isFresh: syncState.inMemoryCacheFresh,
      rateCount: syncState.inMemoryRateCount,
    },

    syncConfig: {
      syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS) || 15_000,
      staleThresholdMs: syncState.staleThresholdMs,
      wingaCredentialsConfigured: syncState.wingaCredentialsConfigured,
    },

    cacheHeaders,

    layers: [
      { name: 'Browser HTTP cache', status: 'BYPASSED', detail: 'fetch(cache:"no-store") + Cache-Control: no-store on all responses' },
      { name: 'Nginx reverse proxy', status: 'BYPASSED', detail: 'No proxy_cache configured; proxy_hide_header + add_header no-store on /api/' },
      { name: 'CDN', status: 'N/A', detail: 'No CDN configured in deployment' },
      { name: 'Service worker', status: 'NOT REGISTERED', detail: 'No service worker, no workbox in the application' },
      { name: 'React Query', status: 'BYPASSED', detail: 'staleTime: 0, refetchOnWindowFocus: true, refetchInterval: 15000ms' },
      { name: 'localStorage', status: 'NO RATE DATA', detail: 'Only auth tokens, branch selection, and favorites are persisted' },
      { name: 'IndexedDB', status: 'NOT USED', detail: 'No IndexedDB access in the codebase' },
      { name: 'Backend in-memory (syncService cachedRates)', status: syncState.inMemoryCacheFresh ? 'FRESH' : 'STALE', detail: `TTL=${syncState.inMemoryCacheTtlMs}ms, age=${syncState.inMemoryCacheAgeMs}ms` },
      { name: 'Backend in-memory (rateEngine currentRates)', status: 'UPDATED', detail: 'Now refreshed every sync cycle via setCurrentRates; no TTL, no invalidation' },
      { name: 'Winga upstream API', status: syncState.lastWingaFetchError ? 'ERROR' : syncState.lastSyncDecision === 'rejected-stale' ? 'STALE' : 'LIVE', detail: `Last fetch age=${syncState.lastWingaFetchAgeMs}ms, rates=${syncState.lastWingaFetchRateCount}, decision=${syncState.lastSyncDecision}` },
    ],
  })
})

async function broadcastRates() {
  try {
    const dbRates = await getLatestRates()
    if (dbRates.rates?.length) {
      const ratesMap = dbRates.rates.reduce((acc, r) => {
        acc[r.currency_code] = { buy: r.buying_rate, sell: r.selling_rate }
        return acc
      }, {})
      io.emit('rates:update', { rates: ratesMap, source: dbRates.source, generatedAt: new Date().toISOString() })
      return
    }
    io.emit('rates:update', { rates: {}, source: 'unavailable', generatedAt: new Date().toISOString() })
  } catch (err) {
    console.error('[socket] Broadcast failed:', err.message)
    io.emit('rates:update', { rates: {}, source: 'unavailable', generatedAt: new Date().toISOString() })
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
    if (!db.isReady()) {
      const snapshot = loadSnapshot()
      if (snapshot?.rates && Object.keys(snapshot.rates).length > 0) {
        const ratesMap = Object.entries(snapshot.rates).reduce((acc, [code, quote]) => {
          acc[code] = { buy: quote.buy, sell: quote.sell }
          return acc
        }, {})
        setCurrentRates(ratesMap)
        console.log(`[startup] Loaded ${Object.keys(ratesMap).length} rates from snapshot into cache (DB unavailable)`)
      } else {
        console.warn('[startup] Database not configured and no snapshot available — rates will be unavailable until DB is connected or Winga returns fresh data')
      }
    }

     const result = await syncRates()
    if (result.success) {
      if (result.stale) {
        console.warn(`[startup] Initial sync: Winga data is STALE (${result.staleReason}). Keeping verified database/in-memory rates.`)
      } else {
        console.log(`[startup] Initial sync complete: ${result.ratesCount} rates from Winga`)
      }
    } else {
      console.error(`[startup] Initial sync failed: ${result.error}`)
    }
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