const axios = require('axios')
const db = require('../config/db')

const WINGA_API_KEY = process.env.WINGA_API_KEY
const WINGA_API_SECRET = process.env.WINGA_API_SECRET
const WINGA_BRANCH = process.env.WINGA_BRANCH || 'HEAD OFFICE'

const WINGA_RATES_ENDPOINT =
  'https://forex.wingaforex.co.tz/api/method/forex_bureau.vsd_forex_bureau.doctype.branch.api.get_exchange_rates'

const persistRates = async (rates, source = 'provider', branchName = 'HEAD OFFICE', sequences = {}) => {
  if (!db.isReady()) return

  const insertQuery =
    'INSERT INTO exchange_rates (branch_name, currency_code, currency_name, currency_actual_name, currency_sequence, buying_rate, selling_rate, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

  try {
    for (const [code, quote] of Object.entries(rates)) {
      await db.query(insertQuery, [branchName, code, code, code, sequences[code] || 0, quote.buy, quote.sell, source])
    }
    console.log(`[rateEngine] Persisted ${Object.keys(rates).length} rates from source: ${source}`)
  } catch (err) {
    console.error(`[rateEngine] Failed to persist rates:`, err.message)
  }
}

let currentRates = {}

const getRates = () => currentRates

const fetchExchangeRates = async (branchName = WINGA_BRANCH) => {
  if (!WINGA_API_KEY || !WINGA_API_SECRET) {
    throw new Error('Winga API credentials not configured')
  }

  const url = `${WINGA_RATES_ENDPOINT}?branch_name=${encodeURIComponent(branchName)}`
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

  const message = Array.isArray(response.data?.message) ? response.data.message : []
  if (!message.length) {
    throw new Error('Winga API returned empty rates array')
  }

  // Use Winga's real buy/sell rates directly. No synthetic derivation.
  const mapped = {}
  const sequences = {}
  let seq = 1
  for (const row of message) {
    const code = String(row.currency_code || '').toUpperCase()
    const buy = Number(row.buying_rate)
    const sell = Number(row.selling_rate)
    if (!code || !(buy > 0) || !(sell > 0)) continue
    mapped[code] = { buy: buy, sell: sell }
    sequences[code] = Number(row.currency_sequence) || seq++
  }

  mapped.TZS = { buy: 1, sell: 1 }
  sequences.TZS = 0

  console.log(`[rateEngine] Winga returned ${Object.keys(mapped).length} currencies`)
  return { rates: mapped, sequences }
}

const refreshFromProvider = async (branchName = 'HEAD OFFICE') => {
  try {
    const { rates, sequences } = await fetchExchangeRates(branchName)
    currentRates = rates
    await persistRates(currentRates, 'winga', branchName, sequences)
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

module.exports = { getRates, refreshFromProvider, calculateExchange, persistRates, fetchExchangeRates }