const axios = require('axios')
const { fetchExchangeRates } = require('./rateEngine')
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

const fetchWingaRates = async (branchName = WINGA_BRANCH) => {
  if (!AUTHORIZATION_HEADER) {
    throw new Error('WINGA_API_KEY and WINGA_API_SECRET are not configured')
  }

  const response = await axios.get(WINGA_RATES_ENDPOINT, {
    params: { branch_name: branchName },
    headers: {
      Authorization: AUTHORIZATION_HEADER,
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
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

  console.log(`[syncService] Winga API returned ${rates.length} rates for branch: ${branchName}`)

  // Stale-data detection: check effective_date_and_time
  const now = Date.now()
  const staleEntries = rates.filter((r) => {
    if (!r.effective_date_and_time) return false
    const safe = String(r.effective_date_and_time).trim()
    const iso = safe.includes('T') ? safe : safe.replace(' ', 'T')
    const d = new Date(iso)
    if (isNaN(d.getTime())) return false
    return (now - d.getTime() > STALE_THRESHOLD_MS)
  })

  if (staleEntries.length > 0) {
    const oldest = staleEntries
      .sort((a, b) => {
        const da = new Date(String(a.effective_date_and_time).trim().replace(' ', 'T'))
        const db = new Date(String(b.effective_date_and_time).trim().replace(' ', 'T'))
        return da.getTime() - db.getTime()
      })[0]
    console.warn(
      `[syncService] WARNING: Winga API returned STALE data. ` +
      `${staleEntries.length}/${rates.length} rates have effective_date_and_time older than 1 hour. ` +
      `Oldest: ${oldest?.effective_date_and_time}. ` +
      `This indicates a Frappe cache or unsynced Winga database. ` +
      `Currency codes affected: ${[...new Set(staleEntries.map((r) => r.currency_code))].join(', ')}`,
    )
  }

  return rates
}

let cachedRates = {}
let cachedRatesAt = 0
let cachedEffectiveDates = {}
const CACHE_TTL_MS = 15_000

const syncRates = async () => {
  const startTime = Date.now()

  try {
    console.log(`[syncService] Fetching live rates from Winga API`)
    const { rates, sequences, effectiveDates } = await fetchExchangeRates()
    cachedRates = rates
    cachedRatesAt = Date.now()
    cachedEffectiveDates = effectiveDates || {}

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

    return { success: true, ratesCount: formattedRates.length, duration: Date.now() - startTime, source: 'winga' }
  } catch (err) {
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
      headers: {
        Authorization: AUTHORIZATION_HEADER,
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
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

    const response = await axios.get(WINGA_RATES_ENDPOINT, {
      params: { branch_name: branchName },
      headers: {
        Authorization: AUTHORIZATION_HEADER,
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
      timeout: 15000,
      validateStatus: () => true,
    })

    status = response.status
    statusText = response.statusText
    responseHeaders = response.headers || {}
    requestUrl = `${WINGA_RATES_ENDPOINT}?branch_name=${encodeURIComponent(branchName)}`
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

    const response = await axios.get(WINGA_BRANCHES_ENDPOINT, {
      headers: {
        Authorization: AUTHORIZATION_HEADER,
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
      timeout: 15000,
      validateStatus: () => true,
    })

    status = response.status
    statusText = response.statusText
    responseHeaders = response.headers || {}
    requestUrl = WINGA_BRANCHES_ENDPOINT
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
}
