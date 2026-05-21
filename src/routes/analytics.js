const express = require('express')
const { authRequired } = require('../middleware/auth')
const { allowRoles } = require('../middleware/roles')

const router = express.Router()

router.get('/admin', authRequired, allowRoles('admin'), (_req, res) => {
  return res.json({
    revenue: 2400000,
    activeUsers: 29832,
    kycPending: 34,
    fraudAlerts: 2,
    transactionsPerMinute: 72,
    branchLoadHeatmap: [
      { branch: 'Nairobi CBD', demand: 0.9 },
      { branch: 'Mombasa', demand: 0.74 },
      { branch: 'Kisumu', demand: 0.58 },
      { branch: 'Arusha', demand: 0.51 },
    ],
  })
})

router.get('/user', authRequired, (_req, res) => {
  return res.json({
    walletBalance: 482119.29,
    monthlyExchanges: 1293,
    favoriteCurrencies: ['USD', 'EUR', 'GBP'],
    alerts: 7,
  })
})

module.exports = router
