const axios = require('axios')
const db = require('../config/db')

const WINGA_API_KEY = process.env.WINGA_API_KEY
const WINGA_API_SECRET = process.env.WINGA_API_SECRET
const WINGA_BRANCH = process.env.WINGA_BRANCH || 'HEAD OFFICE'
const STALE_THRESHOLD_MS = Number(process.env.STALE_THRESHOLD_MS) || (60 * 60 * 1000)

const WINGA_RATES_ENDPOINT =
  'https://forex.wingaforex.co.tz/api/method/forex_bureau.vsd_forex_bureau.doctype.branch.api.get_exchange_rates'

const persistRates = async (rates, source = 'provider', branchName = 'HEAD OFFICE', sequences = {}, effectiveDates = {}) => {
  if (!db.isReady()) return

  const insertQuery =
    'INSERT INTO exchange_rates (branch_name, currency_code, currency_name, currency_actual_name, currency_sequence, buying_rate, selling_rate, source, effective_date_and_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  const deleteQuery =
    'DELETE FROM exchange_rates WHERE branch_name = ? AND currency_code = ?'

  try {
    for (const [code, quote] of Object.entries(rates)) {
      // Check existing record — do NOT overwrite newer DB data with stale API data
      const [existing] = await db.query(
        'SELECT effective_date_and_time FROM exchange_rates WHERE branch_name = ? AND currency_code = ? ORDER BY effective_date_and_time DESC LIMIT 1',
        [branchName, code],
      )
      const existingEff = existing[0]?.effective_date_and_time
      if (existingEff && effectiveDates[code]) {
        const existingDate = parseEffectiveDate(existingEff)
        const incomingDate = parseEffectiveDate(effectiveDates[code])
        if (existingDate && incomingDate && existingDate >= incomingDate) {
          console.log(`[rateEngine] Skipping ${code} for ${branchName}: DB effective_date (${existingEff}) is newer than API (${effectiveDates[code]})`)
          continue
        }
      }

      // Delete old records for this currency+branch, then insert fresh
      await db.query(deleteQuery, [branchName, code])
      await db.query(insertQuery, [
        branchName,
        code,
        code,
        code,
        sequences[code] || 0,
        quote.buy,
        quote.sell,
        source,
        effectiveDates[code] || new Date().toISOString().replace('T', ' ').replace('Z', ''),
      ])
    }
    console.log(`[rateEngine] Persisted ${Object.keys(rates).length} rates from source: ${source}`)
  } catch (err) {
    console.error(`[rateEngine] Failed to persist rates:`, err.message)
  }
}

let currentRates = {}

const getRates = () => currentRates

const setCurrentRates = (rates) => {
  currentRates = rates
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

const fetchExchangeRates = async (branchName = WINGA_BRANCH) => {
  if (!WINGA_API_KEY || !WINGA_API_SECRET) {
    throw new Error('Winga API credentials not configured')
  }

  const url = `${WINGA_RATES_ENDPOINT}?branch_name=${encodeURIComponent(branchName)}&_=${Date.now()}`
  const auth = `token ${WINGA_API_KEY}:${WINGA_API_SECRET}`

  const response = await axios.get(url, {
    headers: {
      Authorization: auth,
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
    timeout: 15000,
  })

  const message = response.data?.message
  const messageArray = Array.isArray(message)
    ? message
    : message && typeof message === 'object'
      ? Object.values(message)
      : []
  if (!messageArray.length) {
    throw new Error('Winga API returned empty rates — message is not an array or object with numeric keys')
  }

  const mapped = {}
  const sequences = {}
  const effectiveDates = {}
  let seq = 1

  for (const row of message) {
    const code = String(row.currency_code || '').toUpperCase()
    const buy = Number(row.buying_rate)
    const sell = Number(row.selling_rate)
    if (!code || !(buy > 0) || !(sell > 0)) continue

    const isCanonical = String(row.currency_name || '').toUpperCase() === code
    const existing = mapped[code]

    if (!existing) {
      mapped[code] = { buy, sell }
      sequences[code] = Number(row.currency_sequence) || seq++
      effectiveDates[code] = row.effective_date_and_time
    } else if (isCanonical) {
      mapped[code] = { buy, sell }
      sequences[code] = Number(row.currency_sequence) || seq++
      effectiveDates[code] = row.effective_date_and_time
    }
  }

  mapped.TZS = { buy: 1, sell: 1 }
  sequences.TZS = 0
  effectiveDates.TZS = new Date().toISOString().replace('T', ' ').replace('Z', '')

  const now = Date.now()
  let staleCount = 0
  const staleCodes = []
  for (const [code, dateStr] of Object.entries(effectiveDates)) {
    if (code === 'TZS') continue
    const effDate = parseEffectiveDate(dateStr)
    if (effDate && (now - effDate.getTime() > STALE_THRESHOLD_MS)) {
      staleCount++
      staleCodes.push(code)
    }
  }

  console.log(`[rateEngine] Winga returned ${Object.keys(mapped).length} currencies, ${staleCount} stale`)

  if (staleCount > 0) {
    const oldest = Object.entries(effectiveDates)
      .filter(([_, d]) => d && _ !== 'TZS')
      .sort((a, b) => {
        const da = parseEffectiveDate(a[1]) || new Date(0)
        const db = parseEffectiveDate(b[1]) || new Date(0)
        return da.getTime() - db.getTime()
      })[0]

    console.warn(
      `[rateEngine] WARNING: ${staleCount}/${Object.keys(mapped).length} currencies have stale rates. ` +
      `Oldest effective_date_and_time: ${oldest ? oldest[1] : 'unknown'}. ` +
      `Stale codes: ${staleCodes.join(', ')}. ` +
      `Winga API may be serving cached data from Frappe cache layer or the bureau has not updated rates.`,
    )
  }

  return { rates: mapped, sequences, effectiveDates }
}

const refreshFromProvider = async (branchName = 'HEAD OFFICE') => {
  try {
    const { rates, sequences, effectiveDates } = await fetchExchangeRates(branchName)

    const parsedDates = Object.values(effectiveDates).map(parseEffectiveDate).filter((d) => d !== null)
    const now = Date.now()
    const newestDate = parsedDates.sort((a, b) => a.getTime() - b.getTime()).pop()
    const ageMs = newestDate ? now - newestDate.getTime() : null

    if (ageMs != null && ageMs > STALE_THRESHOLD_MS) {
      console.warn(
        `[rateEngine] refreshFromProvider: REJECTED stale data. ` +
          `Newest effective_date: ${newestDate.toISOString().replace('T', ' ').replace('Z', '')}. ` +
          `Age: ${formatDuration(ageMs)}, threshold: ${formatDuration(STALE_THRESHOLD_MS)}. ` +
          `Keeping existing rates.`,
      )
      return currentRates
    }

    currentRates = rates
    await persistRates(currentRates, 'winga', branchName, sequences, effectiveDates)
    console.log(
      `[rateEngine] refreshFromProvider: ACCEPTED fresh data. ` +
        `Newest effective_date: ${newestDate ? newestDate.toISOString().replace('T', ' ').replace('Z', '') : 'unknown'}. ` +
        `Age: ${ageMs != null ? formatDuration(ageMs) : 'unknown'}.`,
    )
    return currentRates
  } catch (err) {
    console.error('[rateEngine] Exchange rate fetch failed:', err.message)
    return currentRates
  }
}

const calculateExchange = ({ amount, fromRate, toRate }) => {
  const gross = (amount * fromRate) / toRate
  const spread = amount * 0.005
  const transferFee = gross * 0.004
  const commission = gross * 0.0015
  const net = gross - spread - transferFee - commission

  return {
    grossConverted: Number(gross.toFixed(6)),
    spread: Number(spread.toFixed(6)),
    transferFee: Number(transferFee.toFixed(6)),
    commission: Number(commission.toFixed(6)),
    net: Number(Math.max(net, 0).toFixed(6)),
  }
}

module.exports = { getRates, setCurrentRates, refreshFromProvider, calculateExchange, persistRates, fetchExchangeRates }
