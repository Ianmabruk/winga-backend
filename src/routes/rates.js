const express = require('express')
const { getRates, calculateExchange } = require('../services/rateEngine')
const { authRequired } = require('../middleware/auth')
const { allowRoles } = require('../middleware/roles')
const db = require('../config/db')

const router = express.Router()

router.get('/', (_req, res) => {
  return res.json({ rates: getRates(), updatedAt: new Date().toISOString() })
})

router.post('/calculate', (req, res) => {
  const { amount, from, to, side = 'sell' } = req.body
  const rates = getRates()

  if (!amount || !from || !to || !rates[from] || !rates[to]) {
    return res.status(400).json({ message: 'Invalid calculator payload' })
  }

  const fromRate = rates[from][side] || rates[from].sell
  const toRate = rates[to].buy
  const result = calculateExchange({ amount: Number(amount), fromRate, toRate })

  if (db.isReady()) {
    db.query(
      `INSERT INTO transactions
      (user_id, from_currency, to_currency, amount, gross_converted, spread, transfer_fee, commission, net_amount)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        req.user?.id || null,
        from,
        to,
        Number(amount),
        result.grossConverted,
        result.spread,
        result.transferFee,
        result.commission,
        result.net,
      ],
    ).catch(() => null)
  }

  return res.json({ from, to, amount: Number(amount), side, result })
})

router.get('/history', authRequired, allowRoles('admin'), async (_req, res) => {
  if (!db.isReady()) return res.json({ history: [] })
  const result = await db.query(
    `SELECT currency_code, buy, sell, source, created_at
     FROM exchange_rates
     ORDER BY created_at DESC
     LIMIT 200`,
  )
  return res.json({ history: result.rows })
})

router.put('/', authRequired, allowRoles('admin'), (req, res) => {
  const { rates } = req.body
  if (!rates || typeof rates !== 'object') {
    return res.status(400).json({ message: 'Rates payload is required' })
  }

  return res.json({ message: 'Rate update accepted', rates, updatedAt: new Date().toISOString() })
})

module.exports = router
