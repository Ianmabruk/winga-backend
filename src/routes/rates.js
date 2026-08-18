const express = require('express')
const { authRequired } = require('../middleware/auth')
const { allowRoles } = require('../middleware/roles')
const { getRates, calculateExchange } = require('../services/rateEngine')
const { getLatestRates, fetchWingaRates } = require('../services/syncService')
const db = require('../config/db')

const router = express.Router()

const rateUpdateListeners = []

const onRateUpdate = (fn) => rateUpdateListeners.push(fn)
const emitRateUpdate = (data) => rateUpdateListeners.forEach((fn) => fn(data))

const BRANCH_NAME = 'HEAD OFFICE'

const resolveBranch = (req) => {
  const raw = req.query.branch_name || req.query.branch || BRANCH_NAME
  return String(raw || '').trim() || BRANCH_NAME
}

const formatDuration = (ms) => {
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

router.get('/', async (req, res) => {
  const branchName = resolveBranch(req)

  const result = await getLatestRates(branchName)

  if (result.rates?.length) {
    const rates = result.rates
    return res.json({
      rates,
      lastUpdated: result.lastUpdated,
      source: rates[0].source,
    })
  }

  const inMemoryRates = getRates()
  if (Object.keys(inMemoryRates).length > 0) {
    const rates = Object.entries(inMemoryRates).map(([code, quote], idx) => ({
      branch_name: branchName,
      currency_code: code,
      currency_name: code,
      currency_actual_name: code,
      currency_sequence: idx + 1,
      buying_rate: quote.buy,
      selling_rate: quote.sell,
      effective_date_and_time: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      source: 'winga-live',
    }))
    return res.json({
      rates,
      lastUpdated: new Date().toISOString(),
      source: 'winga-live',
    })
  }

  return res.json({
    rates: [],
    lastUpdated: new Date().toISOString(),
    source: 'unavailable',
  })
})

router.get('/branches', async (_req, res) => {
  res.json({
    branches: [
      {
        branch_name: BRANCH_NAME,
        branch_abbr: 'HO',
        city: 'Dar es Salaam',
        country: 'Tanzania',
        status: 'active',
      },
    ],
  })
})

router.get('/live', async (req, res) => {
  const branchName = resolveBranch(req)
  console.log('[rates] /live called for branch:', JSON.stringify(branchName), 'raw query:', JSON.stringify(req.query))
  try {
    // Preferred flow: serve verified data from DB -> snapshot -> in-memory cache.
    // Avoid triggering a synchronous provider fetch on every client request.
    const dbResult = await getLatestRates(branchName)
    if (dbResult.rates && dbResult.rates.length) {
      return res.json({
        message: dbResult.rates.map((r) => ({ ...r, source: dbResult.source })),
        stale: false,
        provider: 'database',
        providerTimestamp: dbResult.lastUpdated || null,
        staleReason: null,
        rates: dbResult.rates,
      })
    }

    // Fallback to in-memory current rates set by the sync worker
    const inMemoryRates = getRates()
    if (Object.keys(inMemoryRates).length > 0) {
      const rates = Object.entries(inMemoryRates).map(([code, quote], idx) => ({
        branch_name: branchName,
        currency_code: code,
        currency_name: code,
        currency_actual_name: code,
        currency_sequence: idx + 1,
        buying_rate: quote.buy,
        selling_rate: quote.sell,
        effective_date_and_time: new Date().toISOString().replace('T', ' ').replace('Z', ''),
        source: 'winga-live',
      }))
      return res.json({
        message: rates,
        stale: false,
        provider: 'in-memory',
        providerTimestamp: new Date().toISOString(),
        staleReason: null,
        rates,
      })
    }

    // If nothing available, clearly indicate unavailability rather than calling provider synchronously.
    return res.status(503).json({
      message: [],
      stale: true,
      provider: 'unavailable',
      providerTimestamp: null,
      staleReason: 'No verified rates available (DB and in-memory empty)',
      rates: [],
    })
  } catch (err) {
    console.error('[rates] live handler failed:', err.message)
    return res.status(500).json({ error: 'Internal server error', source: 'unavailable' })
  }
})

router.get('/rate-sequences', async (_req, res) => {
  res.json({ sequences: {} })
})

router.post('/calculate', (req, res) => {
  const { amount, from, to, side = 'sell' } = req.body
  const rates = getRates()

  if (!amount || !from || !to || !rates[from] || !rates[to]) {
    return res.status(400).json({ message: 'Invalid calculator payload' })
  }

  // Bureau rate semantics:
  // 'sell' = user sells FROM currency to bureau → bureau uses BUYING rate (what they pay)
  // 'buy'  = user buys FROM currency from bureau → bureau uses SELLING rate (what they charge)
  // This matches the frontend ForexCalculatorPanel mode mapping.
  const fromRate = side === 'sell' ? rates[from].buy : rates[from].sell
  const toRate = rates[to].buy
  const result = calculateExchange({ amount: Number(amount), fromRate, toRate })

  return res.json({ from, to, amount: Number(amount), side, result })
})

router.get('/history', async (req, res) => {
  if (!db.isReady()) {
    return res.json({ history: [] })
  }
  try {
    const branchName = resolveBranch(req)
    const [rows] = await db.query(
      `SELECT branch_name, currency_code, currency_name, currency_actual_name, currency_sequence,
              buying_rate, selling_rate, source, updated_at, effective_date_and_time
       FROM exchange_rates
       WHERE branch_name = ?
       ORDER BY updated_at DESC
       LIMIT 500`,
      [branchName],
    )
    return res.json({ history: rows })
  } catch (err) {
    console.error('[rates] history query failed:', err.message)
    return res.json({ history: [] })
  }
})

// Admin publishes rates. Persists to the database and returns the stored row(s).
router.put('/', authRequired, allowRoles('admin'), async (req, res) => {
  if (!db.isReady()) {
    return res.status(503).json({ message: 'Database not connected - cannot persist rates' })
  }

  const rates = req.body && req.body.rates
  if (!rates || typeof rates !== 'object') {
    return res.status(400).json({ message: 'Invalid payload: expected { rates: { CODE: { buy, sell } } }' })
  }

  const branchName = req.body.branch_name || BRANCH_NAME
  const stored = []

  try {
    for (const [code, quote] of Object.entries(rates)) {
      const buy = Number(quote.buy)
      const sell = Number(quote.sell)
      if (!code || !(buy > 0) || !(sell > 0)) {
        return res.status(400).json({ message: `Invalid rate for ${code}` })
      }
      await db.query(
        'DELETE FROM exchange_rates WHERE branch_name = ? AND currency_code = ?',
        [branchName, code],
      )
      const [result] = await db.query(
        `INSERT INTO exchange_rates
           (branch_name, currency_code, currency_name, currency_actual_name, currency_sequence, buying_rate, selling_rate, source, effective_date_and_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [branchName, code, code, code, 0, buy, sell, 'admin-published', new Date().toISOString().replace('T', ' ').replace('Z', '')],
      )
      stored.push({ currency_code: code, buying_rate: buy, selling_rate: sell, id: result.insertId })
    }

    const rateMap = Object.fromEntries(stored.map((s) => [s.currency_code, { buy: s.buying_rate, sell: s.selling_rate }]))

    emitRateUpdate({ type: 'admin-publish', source: 'admin-published', rates: rateMap })

    console.log(`[rates] Admin published ${stored.length} rates for branch: ${branchName}`)

    return res.json({ success: true, stored, branch_name: branchName })
  } catch (err) {
    console.error('[rates] publish failed:', err.message)
    return res.status(500).json({ message: 'Failed to persist rates', error: err.message })
  }
})

router.get('/health', (req, res) => {
  const { getSyncState, getLatestRates } = require('../services/syncService')
  const syncState = getSyncState ? getSyncState() : null
  res.json({
    status: 'ok',
    service: 'Winga Forex Bureau API',
    timestamp: new Date().toISOString(),
    sync: syncState || {
      lastSyncDecision: 'unknown',
      lastStaleReason: null,
      lastProviderTimestamp: null,
    },
  })
})

module.exports = router
module.exports.onRateUpdate = onRateUpdate