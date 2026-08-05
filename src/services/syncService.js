const axios = require('axios')
const { persistRates, setCurrentRates } = require('./rateEngine')
const db = require('../config/db')

const WINGA_API_KEY = process.env.WINGA_API_KEY
const WINGA_API_SECRET = process.env.WINGA_API_SECRET
const WINGA_BRANCH = process.env.WINGA_BRANCH || 'HEAD OFFICE'

const WINGA_RATES_ENDPOINT =
  'https://forex.wingaforex.co.tz/api/method/forex_bureau.vsd_forex_bureau.doctype.branch.api.get_exchange_rates'

const WINGA_BRANCHES_ENDPOINT =
  'https://forex.wingaforex.co.tz/api/method/forex_bureau.vsd_forex_bureau.doctype.branch.api.get_branches'

const AUTHORIZATION_HEADER = WINGA_API_KEY && WINGA_API_SECRET
  ? `token ${WINGA_API_KEY}:${WINGA_API_SECRET}`
  : ''

const STALE_THRESHOLD_MS = Number(process.env.STALE_THRESHOLD_MS) || (60 * 60 * 1000)

const WINGA_FRESHNESS_FIELD = 'effective_date_and_time'

const formatDuration = (ms) => {
  if (ms == null || ms < 0) return 'unknown'
  const d = Math.floor(ms / 86400000)
  const h = Math.floor((ms % 86400000) / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const validateProviderTimestamp = (effectiveDates) => {
  const now = Date.now()
  const parsed = Object.values(effectiveDates)
    .map(parseEffectiveDate)
    .filter((d) => d !== null)
  if (!parsed.length) {
    return {
      isStale: true,
      reason: `No valid ${WINGA_FRESHNESS_FIELD} found in provider response — cannot determine freshness`,
      oldestDate: null,
      newestDate: null,
      ageMs: null,
    }
  }

  parsed.sort((a, b) => a.getTime() - b.getTime())
  const oldestDate = parsed[0]
  const newestDate = parsed[parsed.length - 1]
  const ageMs = now - newestDate.getTime()

  if (ageMs > STALE_THRESHOLD_MS) {
    return {
      isStale: true,
      reason: `Provider ${WINGA_FRESHNESS_FIELD} (${newestDate.toISOString().replace('T', ' ').replace('Z', '')}) is ${formatDuration(ageMs)} old, exceeding threshold of ${formatDuration(STALE_THRESHOLD_MS)}`,
      oldestDate,
      newestDate,
      ageMs,
    }
  }

  return { isStale: false, reason: null, oldestDate, newestDate, ageMs }
}

const fetchWingaRates = async (branchName = WINGA_BRANCH) => {
  if (!AUTHORIZATION_HEADER) {
    throw new Error('WINGA_API_KEY and WINGA_API_SECRET are not configured')
  }

  const response = await axios.get(WINGA_RATES_ENDPOINT, {
    params: {
      branch_name: branchName,
      _: Date.now(),
      t: Date.now(),
    },
    headers: {
      Authorization: AUTHORIZATION_HEADER,
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Cache-Bypass': 'true',
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 15000,
  })

  const ratesMessage = response.data?.message
  const rates = Array.isArray(ratesMessage)
    ? ratesMessage
    : ratesMessage && typeof ratesMessage === 'object'
      ? Object.values(ratesMessage)
      : []

  if (!rates.length) {
    throw new Error('Winga API returned empty rates — message is not an array or object with numeric keys')
  }

  const effectiveDates = {}
  for (const r of rates) {
    if (r.currency_code && r[WINGA_FRESHNESS_FIELD]) {
      effectiveDates[String(r.currency_code).toUpperCase()] = r[WINGA_FRESHNESS_FIELD]
    }
  }

  const now = Date.now()
  const staleEntries = rates.filter((r) => {
    if (!r[WINGA_FRESHNESS_FIELD]) return false
    const safe = String(r[WINGA_FRESHNESS_FIELD]).trim()
    const iso = safe.includes('T') ? safe : safe.replace(' ', 'T')
    const d = new Date(iso)
    if (isNaN(d.getTime())) return false
    return (now - d.getTime() > STALE_THRESHOLD_MS)
  })

  console.log(`[syncService] Winga API returned ${rates.length} rates for branch: ${branchName}`)

  const validation = validateProviderTimestamp(effectiveDates)

  if (staleEntries.length > 0) {
    const oldest = staleEntries
      .sort((a, b) => {
        const da = new Date(String(a[WINGA_FRESHNESS_FIELD]).trim().replace(' ', 'T'))
        const db = new Date(String(b[WINGA_FRESHNESS_FIELD]).trim().replace(' ', 'T'))
        return da.getTime() - db.getTime()
      })[0]
    console.warn(
      `[syncService] WARNING: Winga API returned STALE data. ` +
        `${staleEntries.length}/${rates.length} rates have ${WINGA_FRESHNESS_FIELD} older than ${formatDuration(STALE_THRESHOLD_MS)}. ` +
        `Oldest: ${oldest?.[WINGA_FRESHNESS_FIELD]}. ` +
        `This indicates a Frappe cache or unsynced Winga database. ` +
        `Currency codes affected: ${[...new Set(staleEntries.map((r) => r.currency_code))].join(', ')}`,
    )
  }

  recordFetchSuccess(rates.length, effectiveDates)
  return { rates, effectiveDates, validation }
}

let cachedRates = {}
let cachedRatesAt = 0
let cachedEffectiveDates = {}
const CACHE_TTL_MS = 15_000

let lastWingaFetchAt = 0
let lastWingaFetchError = null
let lastWingaFetchCount = 0
let lastWingaFetchEffectiveDates = {}

let lastSuccessfulSyncAt = 0
let lastRejectedSyncAt = 0
let lastSyncDecision = 'pending'
let lastStaleReason = null
let lastProviderTimestamp = null

const recordFetchSuccess = (count, effectiveDates = {}) => {
  lastWingaFetchAt = Date.now()
  lastWingaFetchError = null
  lastWingaFetchCount = count
  lastWingaFetchEffectiveDates = effectiveDates
}

const recordFetchError = (error) => {
  lastWingaFetchError = error.message || String(error)
}

const parseEffectiveDate = (dateStr) => {
  if (!dateStr) return null
  try {
    const safe = String(dateStr).trim()
    const iso = safe.includes('T') ? safe : safe.replace(' ', 'T')
    const d = new Date(iso)
    if (isNaN(d.getTime())) return null
    return d
  } catch {
    return null
  }
}

const syncRates = async () => {
  const startTime = Date.now()

  try {
    console.log(`[syncService] Fetching live rates from Winga API`)
    const { rates, sequences, effectiveDates, validation } = await fetchWingaRates()

    lastProviderTimestamp = validation.newestDate
    const now = Date.now()

    if (validation.isStale) {
      lastRejectedSyncAt = now
      lastSyncDecision = 'rejected-stale'
      lastStaleReason = validation.reason

      console.warn(
        `[syncService] SYNC DECISION: Rejected\n` +
          `  Provider timestamp: ${validation.newestDate ? validation.newestDate.toISOString() : '(none)'}\n` +
          `  Current time: ${new Date(now).toISOString()}\n` +
          `  Age: ${validation.newestDate ? formatDuration(now - validation.newestDate.getTime()) : 'unknown'}\n` +
          `  Database timestamp: ${lastSuccessfulSyncAt ? new Date(lastSuccessfulSyncAt).toISOString() : '(never synced)'}\n` +
          `  Reason: ${validation.reason}\n` +
          `  Action: Keeping latest verified database rates. In-memory cache unchanged.`,
      )

      recordFetchSuccess(rates.reduce((acc, r) => { acc[r.currency_code] = true; return acc }, {}), effectiveDates)
      return {
        success: true,
        stale: true,
        provider: 'Winga',
        providerTimestamp: validation.newestDate ? validation.newestDate.toISOString() : null,
        lastVerifiedDatabaseTimestamp: lastSuccessfulSyncAt ? new Date(lastSuccessfulSyncAt).toISOString() : null,
        rates: {},
        duration: Date.now() - startTime,
        source: 'database-kept',
        staleReason: validation.reason,
        decision: 'rejected-stale',
      }
    }

    lastProviderTimestamp = validation.newestDate

    cachedRates = rates
    cachedRatesAt = Date.now()
    cachedEffectiveDates = effectiveDates || {}
    setCurrentRates(rates)

    recordFetchSuccess(Object.keys(rates).length, effectiveDates)

    const formattedRates = Object.entries(rates).map(([code, quote]) => ({
      currency_code: code,
      currency_name: code,
      currency_actual_name: code,
      currency_sequence: sequences[code],
      buying_rate: quote.buy,
      selling_rate: quote.sell,
      effective_date_and_time: cachedEffectiveDates[code] || new Date().toISOString().replace('T', ' ').replace('Z', ''),
    }))

    console.log(`[syncService] Cached ${formattedRates.length} live rates from Winga API`)

    console.log(
      `[syncService] SYNC DECISION: Accepted\n` +
        `  Provider timestamp: ${validation.newestDate ? validation.newestDate.toISOString() : '(none)'}\n` +
        `  Current time: ${new Date(now).toISOString()}\n` +
        `  Age: ${validation.newestDate ? formatDuration(now - validation.newestDate.getTime()) : 'unknown'}\n` +
        `  Database timestamp: ${lastSuccessfulSyncAt ? new Date(lastSuccessfulSyncAt).toISOString() : '(never synced)'}\n` +
        `  Action: Updating database and in-memory cache.`,
    )

    if (db.isReady()) {
      await persistRates(rates, 'winga', WINGA_BRANCH, sequences, effectiveDates)
      console.log(`[syncService] Persisted ${formattedRates.length} rates to database`)
    }

    lastSuccessfulSyncAt = Date.now()
    lastSyncDecision = 'accepted'
    lastStaleReason = null

    return { success: true, ratesCount: formattedRates.length, duration: Date.now() - startTime, source: 'winga', stale: false, decision: 'accepted' }
  } catch (err) {
    recordFetchError(err)
    console.error(`[syncService] Sync failed: ${err.message}`)
    return { success: false, error: err.message, duration: Date.now() - startTime }
  }
}

const syncBranches = async () => {
  try {
    if (!AUTHORIZATION_HEADER) {
      return {
        success: true,
        branchesCount: 1,
        branches: [
          { branch_name: 'HEAD OFFICE', branch_abbr: 'HO', city: 'Dar es Salaam', country: 'Tanzania', status: 'active' },
        ],
        warning: 'No Winga credentials',
      }
    }

    const response = await axios.get(WINGA_BRANCHES_ENDPOINT, {
      params: { _: Date.now() },
      headers: {
        Authorization: AUTHORIZATION_HEADER,
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Cache-Bypass': 'true',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 15000,
    })

    const branchesMessage = response.data?.message
    const branches = Array.isArray(branchesMessage)
      ? branchesMessage
      : branchesMessage && typeof branchesMessage === 'object'
        ? Object.values(branchesMessage)
        : []

    if (!branches.length) {
      throw new Error('Winga API returned empty branches')
    }

    console.log(`[syncService] Synced ${branches.length} branches from Winga API`)

    return { success: true, branchesCount: branches.length, branches }
  } catch (err) {
    console.error(`[syncService] Branches sync failed: ${err.message}`)
    return {
      success: false,
      error: err.message,
      branches: [
        { branch_name: 'HEAD OFFICE', branch_abbr: 'HO', city: 'Dar es Salaam', country: 'Tanzania', status: 'active' },
      ],
    }
  }
}

const getLastSyncStatus = async () => {
  return []
}

const getSyncState = () => {
  const now = Date.now()
  const oldestEffectiveDate = Object.values(lastWingaFetchEffectiveDates).sort().shift()
  const newestEffectiveDate = Object.values(lastWingaFetchEffectiveDates).sort().pop()
  const oldestEffDate = oldestEffectiveDate ? parseEffectiveDate(oldestEffectiveDate) : null
  const newestEffDate = newestEffectiveDate ? parseEffectiveDate(newestEffectiveDate) : null

  return {
    lastWingaFetchAt: lastWingaFetchAt ? new Date(lastWingaFetchAt).toISOString() : null,
    lastWingaFetchError: lastWingaFetchError || null,
    lastWingaFetchRateCount: lastWingaFetchCount,
    lastWingaFetchAgeMs: lastWingaFetchAt ? now - lastWingaFetchAt : null,

    providerTimestamp: lastProviderTimestamp ? lastProviderTimestamp.toISOString() : null,
    providerAgeMs: lastProviderTimestamp ? now - lastProviderTimestamp.getTime() : null,

    lastSuccessfulSyncAt: lastSuccessfulSyncAt ? new Date(lastSuccessfulSyncAt).toISOString() : null,
    lastSuccessfulSyncAgeMs: lastSuccessfulSyncAt ? now - lastSuccessfulSyncAt : null,
    lastRejectedSyncAt: lastRejectedSyncAt ? new Date(lastRejectedSyncAt).toISOString() : null,
    lastRejectedSyncAgeMs: lastRejectedSyncAt ? now - lastRejectedSyncAt : null,
    lastSyncDecision,
    staleReason: lastStaleReason,

    oldestEffectiveDateAndTime: oldestEffectiveDate || null,
    newestEffectiveDateAndTime: newestEffectiveDate || null,
    oldestEffectiveAgeMs: oldestEffDate ? now - oldestEffDate.getTime() : null,
    newestEffectiveAgeMs: newestEffDate ? now - newestEffDate.getTime() : null,

    inMemoryCacheAt: cachedRatesAt ? new Date(cachedRatesAt).toISOString() : null,
    inMemoryCacheAgeMs: cachedRatesAt ? now - cachedRatesAt : null,
    inMemoryCacheTtlMs: CACHE_TTL_MS,
    inMemoryCacheFresh: cachedRatesAt ? (now - cachedRatesAt < CACHE_TTL_MS) : false,
    inMemoryRateCount: Object.keys(cachedRates).length,

    staleThresholdMs: STALE_THRESHOLD_MS,
    wingaCredentialsConfigured: Boolean(AUTHORIZATION_HEADER),
  }
}

const getLatestDbUpdate = async () => {
  if (!db.isReady()) return null
  try {
    const [rows] = await db.query(
      `SELECT MAX(updated_at) AS latest, MAX(effective_date_and_time) AS latestEffective, COUNT(*) AS total,
              SUM(CASE WHEN source = 'admin-published' THEN 1 ELSE 0 END) AS adminCount,
              SUM(CASE WHEN source = 'winga' THEN 1 ELSE 0 END) AS wingaCount
       FROM exchange_rates`,
    )
    return rows[0]
  } catch (err) {
    console.error('[syncService] Failed to query DB update time:', err.message)
    return null
  }
}

const getLatestRates = async (branchName) => {
  try {
    if (db.isReady()) {
      const [rows] = await db.query(
        `SELECT branch_name, currency_code, currency_name, currency_actual_name, currency_sequence,
                buying_rate, selling_rate, source, updated_at, effective_date_and_time
         FROM exchange_rates
         WHERE branch_name = ?
         ORDER BY currency_sequence ASC, currency_code ASC, effective_date_and_time DESC`,
        [branchName || WINGA_BRANCH],
      )
      if (Array.isArray(rows) && rows.length > 0) {
        return {
          rates: rows,
          lastUpdated: rows[0].updated_at || new Date().toISOString(),
          currencyCount: rows.length,
          source: 'database',
        }
      }
    }

    if (Object.keys(cachedRates).length > 0 && Date.now() - cachedRatesAt < CACHE_TTL_MS) {
      const inMemoryRates = Object.entries(cachedRates).map(([code, quote], idx) => ({
        currency_code: code,
        currency_name: code,
        currency_actual_name: code,
        currency_sequence: idx + 1,
        buying_rate: quote.buy,
        selling_rate: quote.sell,
        effective_date_and_time: cachedEffectiveDates[code] || new Date().toISOString().replace('T', ' ').replace('Z', ''),
        updated_at: new Date().toISOString(),
        source: 'winga-live',
      }))
      return {
        rates: inMemoryRates,
        lastUpdated: new Date().toISOString(),
        currencyCount: inMemoryRates.length,
      }
    }

    return { rates: [], lastUpdated: null }
  } catch (err) {
    console.error('[syncService] Failed to fetch latest rates:', err.message)
    return { rates: [], lastUpdated: null }
  }
}

const diagnosticsWingaRates = async (branchName = WINGA_BRANCH) => {
  const startTime = Date.now()
  let error = null
  let status = null
  let statusText = null
  let responseHeaders = {}
  let requestUrl = null
  let data = null

  try {
    if (!AUTHORIZATION_HEADER) {
      throw new Error('WINGA_API_KEY and WINGA_API_SECRET are not configured')
    }

    const cacheBust = `_=${Date.now()}&t=${Date.now()}`
    const response = await axios.get(WINGA_RATES_ENDPOINT, {
      params: { branch_name: branchName, ...Object.fromEntries(new URLSearchParams(cacheBust)) },
      headers: {
        Authorization: AUTHORIZATION_HEADER,
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Cache-Bypass': 'true',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 15000,
      validateStatus: () => true,
    })

    status = response.status
    statusText = response.statusText
    responseHeaders = response.headers || {}
    requestUrl = `${WINGA_RATES_ENDPOINT}?branch_name=${encodeURIComponent(branchName)}&${cacheBust}`
    data = response.data

    if (status !== 200) {
      error = `HTTP ${status}: ${JSON.stringify(data).slice(0, 500)}`
    }
  } catch (err) {
    error = err.message
    if (err.response) {
      status = err.response.status
      statusText = err.response.statusText
      responseHeaders = err.response.headers || {}
    }
  }

  const responseTime = Date.now() - startTime

  return {
    api: 'Winga Exchange Rates',
    endpoint: 'get_exchange_rates',
    requestUrl,
    requestHeaders: {
      Authorization: AUTHORIZATION_HEADER ? `${AUTHORIZATION_HEADER.slice(0, 20)}...` : '(not configured)',
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
    responseStatus: status,
    responseStatusText: statusText,
    responseTimeMs: responseTime,
    responseHeaders,
    branchRequested: branchName,
    data,
    error,
  }
}

const diagnosticsWingaBranches = async () => {
  const startTime = Date.now()
  let error = null
  let status = null
  let statusText = null
  let responseHeaders = {}
  let requestUrl = null
  let data = null

  try {
    if (!AUTHORIZATION_HEADER) {
      throw new Error('WINGA_API_KEY and WINGA_API_SECRET are not configured')
    }

    const cacheBust = `_=${Date.now()}`
    const response = await axios.get(WINGA_BRANCHES_ENDPOINT, {
      params: { ...Object.fromEntries(new URLSearchParams(cacheBust)) },
      headers: {
        Authorization: AUTHORIZATION_HEADER,
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Cache-Bypass': 'true',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 15000,
      validateStatus: () => true,
    })

    status = response.status
    statusText = response.statusText
    responseHeaders = response.headers || {}
    requestUrl = `${WINGA_BRANCHES_ENDPOINT}?${cacheBust}`
    data = response.data

    if (status !== 200) {
      error = `HTTP ${status}: ${JSON.stringify(data).slice(0, 500)}`
    }
  } catch (err) {
    error = err.message
    if (err.response) {
      status = err.response.status
      statusText = err.response.statusText
      responseHeaders = err.response.headers || {}
    }
  }

  const responseTime = Date.now() - startTime

  return {
    api: 'Winga Branches',
    endpoint: 'get_branches',
    requestUrl,
    requestHeaders: {
      Authorization: AUTHORIZATION_HEADER ? `${AUTHORIZATION_HEADER.slice(0, 20)}...` : '(not configured)',
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
    responseStatus: status,
    responseStatusText: statusText,
    responseTimeMs: responseTime,
    responseHeaders,
    data,
    error,
  }
}

module.exports = {
  syncRates,
  syncBranches,
  getLastSyncStatus,
  getLatestRates,
  fetchWingaRates,
  diagnosticsWingaRates,
  diagnosticsWingaBranches,
  getSyncState,
  getLatestDbUpdate,
}
