const axios = require('axios')
const db = require('../config/db')

const baseRates = {
  USD: { buy: 129.85, sell: 131.2 },
  KES: { buy: 1, sell: 1 },
  TZS: { buy: 20.03, sell: 20.44 },
  UGX: { buy: 0.035, sell: 0.038 },
  EUR: { buy: 141.35, sell: 143.78 },
  GBP: { buy: 165.27, sell: 168.64 },
  AED: { buy: 35.12, sell: 35.79 },
  CHF: { buy: 146.82, sell: 149.21 },
  CAD: { buy: 94.76, sell: 96.33 },
  ZAR: { buy: 7.04, sell: 7.31 },
  SAR: { buy: 34.6, sell: 35.24 },
  CNY: { buy: 17.8, sell: 18.21 },
  JPY: { buy: 0.88, sell: 0.93 },
}

const randomize = (value) => {
  const delta = (Math.random() - 0.5) * 0.08
  return Number((value + delta).toFixed(4))
}

const nextRates = (input) =>
  Object.fromEntries(
    Object.entries(input).map(([code, quote]) => [
      code,
      {
        buy: randomize(quote.buy),
        sell: randomize(Math.max(quote.sell, quote.buy + 0.02)),
      },
    ]),
  )

let currentRates = { ...baseRates }

const currencies = Object.keys(baseRates)

const toKshQuote = (providerRates, code) => {
  const kesPerUsd = providerRates.KES
  const codePerUsd = providerRates[code]
  if (!kesPerUsd || !codePerUsd) return null
  return kesPerUsd / codePerUsd
}

const fetchProviderRates = async () => {
  const response = await axios.get('https://open.er-api.com/v6/latest/USD', {
    timeout: 8000,
  })

  if (!response.data?.rates) throw new Error('Invalid provider response')

  const providerRates = response.data.rates
  const mapped = {}

  for (const code of currencies) {
    if (code === 'KES') {
      mapped[code] = { buy: 1, sell: 1 }
      continue
    }

    const mid = toKshQuote(providerRates, code)
    if (!mid) continue
    const buy = Number((mid * 0.9965).toFixed(4))
    const sell = Number((mid * 1.0035).toFixed(4))
    mapped[code] = { buy, sell }
  }

  mapped.KES = { buy: 1, sell: 1 }
  return mapped
}

const persistRates = async (rates, source = 'provider') => {
  if (!db.isReady()) return

  const insertQuery =
    'INSERT INTO exchange_rates (currency_code, buy, sell, source) VALUES ($1, $2, $3, $4)'

  for (const [code, quote] of Object.entries(rates)) {
    // Persisting historical snapshots enables admin trend analytics and auditability.
    await db.query(insertQuery, [code, quote.buy, quote.sell, source])
  }
}

const getRates = () => currentRates

const refreshRates = () => {
  currentRates = nextRates(currentRates)
  return currentRates
}

const refreshFromProvider = async () => {
  try {
    const rates = await fetchProviderRates()
    currentRates = { ...currentRates, ...rates }
    await persistRates(currentRates, 'open.er-api')
    return currentRates
  } catch {
    currentRates = nextRates(currentRates)
    await persistRates(currentRates, 'fallback-simulated')
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

module.exports = { getRates, refreshRates, refreshFromProvider, calculateExchange, persistRates }
