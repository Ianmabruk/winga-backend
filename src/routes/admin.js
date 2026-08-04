const express = require('express')
const { authRequired } = require('../middleware/auth')
const { allowRoles } = require('../middleware/roles')
const adminService = require('../services/adminService')
const { logAudit } = require('../services/auditService')
const { syncRates, syncBranches, getLastSyncStatus, getLatestRates, diagnosticsWingaRates, diagnosticsWingaBranches } = require('../services/syncService')
const db = require('../config/db')

const router = express.Router()

// CSRF protection for state-changing routes
// Validates X-CSRF-Token header against XSRF-TOKEN cookie (set by csurf middleware)
const csrfProtection = (req, res, next) => {
  const headerToken = req.headers['x-csrf-token']
  const cookieToken = req.cookies?.['xsrf-token'] || req.cookies?.['XSRF-TOKEN']

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ message: 'Invalid CSRF token' })
  }
  next()
}

router.use(authRequired, allowRoles('admin'))

router.get('/users', async (_req, res) => {
  const users = await adminService.listUsers()
  res.json({ users })
})

router.post('/users', csrfProtection, async (req, res) => {
  const user = await adminService.createUser(req.body)
  await logAudit({
    actorUserId: req.user.id,
    action: 'admin.user.create',
    entity: 'user',
    entityId: user.id,
    ip: req.auditContext?.ip,
    device: req.auditContext?.device,
    payload: user,
  })
  res.status(201).json({ user })
})

router.put('/users/:id', csrfProtection, async (req, res) => {
  const user = await adminService.updateUser(req.params.id, req.body)
  if (!user) return res.status(404).json({ message: 'User not found' })
  await logAudit({
    actorUserId: req.user.id,
    action: 'admin.user.update',
    entity: 'user',
    entityId: req.params.id,
    ip: req.auditContext?.ip,
    device: req.auditContext?.device,
    payload: req.body,
  })
  res.json({ user })
})

router.delete('/users/:id', csrfProtection, async (req, res) => {
  const ok = await adminService.deleteUser(req.params.id)
  if (!ok) return res.status(404).json({ message: 'User not found' })
  await logAudit({
    actorUserId: req.user.id,
    action: 'admin.user.delete',
    entity: 'user',
    entityId: req.params.id,
    ip: req.auditContext?.ip,
    device: req.auditContext?.device,
  })
  res.status(204).send()
})

router.get('/kyc', async (_req, res) => {
  const queue = await adminService.listKyc()
  res.json({ queue })
})

router.patch('/kyc/:id', csrfProtection, async (req, res) => {
  const row = await adminService.updateKycStatus(req.params.id, req.body.status)
  if (!row) return res.status(404).json({ message: 'User not found' })
  await logAudit({
    actorUserId: req.user.id,
    action: 'admin.kyc.update',
    entity: 'kyc',
    entityId: req.params.id,
    ip: req.auditContext?.ip,
    device: req.auditContext?.device,
    payload: { status: req.body.status },
  })
  res.json({ user: row })
})

router.get('/branches', async (_req, res) => {
  const branches = await adminService.listBranches()
  res.json({ branches })
})

router.post('/sync/branches', csrfProtection, async (_req, res) => {
  const result = await syncBranches()
  res.json(result)
})

router.post('/fetch/rates', csrfProtection, async (req, res) => {
  const branchName = req.body.branch_name || process.env.WINGA_BRANCH || 'HEAD OFFICE'
  const { refreshFromProvider } = require('../services/rateEngine')
  try {
    const rates = await refreshFromProvider(branchName)
    res.json({ success: true, rates })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

router.post('/branches', csrfProtection, async (req, res) => {
  const branch = await adminService.createBranch(req.body)
  await logAudit({
    actorUserId: req.user.id,
    action: 'admin.branch.create',
    entity: 'branch',
    entityId: branch.id,
    ip: req.auditContext?.ip,
    device: req.auditContext?.device,
    payload: branch,
  })
  res.status(201).json({ branch })
})

router.put('/branches/:id', csrfProtection, async (req, res) => {
  const branch = await adminService.updateBranch(req.params.id, req.body)
  if (!branch) return res.status(404).json({ message: 'Branch not found' })
  await logAudit({
    actorUserId: req.user.id,
    action: 'admin.branch.update',
    entity: 'branch',
    entityId: req.params.id,
    ip: req.auditContext?.ip,
    device: req.auditContext?.device,
    payload: req.body,
  })
  res.json({ branch })
})

router.delete('/branches/:id', csrfProtection, async (req, res) => {
  const ok = await adminService.deleteBranch(req.params.id)
  if (!ok) return res.status(404).json({ message: 'Branch not found' })
  await logAudit({
    actorUserId: req.user.id,
    action: 'admin.branch.delete',
    entity: 'branch',
    entityId: req.params.id,
    ip: req.auditContext?.ip,
    device: req.auditContext?.device,
  })
  res.status(204).send()
})

router.get('/audit-logs', async (_req, res) => {
  const logs = await adminService.listAuditLogs()
  res.json({ logs })
})

router.get('/diagnostics', async (_req, res) => {
  const [latestRates, lastSyncLogs] = await Promise.all([
    getLatestRates(),
    getLastSyncStatus(),
  ])

  const dbStatus = db.isReady() ? 'connected' : 'disconnected'

  const lastSuccessfulSync = lastSyncLogs.find((log) => log.type === 'info')
  const lastApiError = lastSyncLogs.find((log) => log.type === 'error')

  const apiStatus = lastApiError
    ? 'error'
    : lastSuccessfulSync
      ? 'ok'
      : 'pending'

  res.json({
    apiStatus,
    lastSuccessfulSync: lastSuccessfulSync || null,
    lastApiError: lastApiError || null,
    currencyCount: latestRates.currencyCount || 0,
    dbStatus,
    lastUpdated: latestRates.lastUpdated,
  })
})

router.post('/sync/rates', csrfProtection, async (_req, res) => {
  const result = await syncRates()
  res.json(result)
})

router.get('/diagnostics/winga-rates', async (req, res) => {
  try {
    const branchName = req.query.branch_name || process.env.WINGA_BRANCH || 'HEAD OFFICE'
    const result = await diagnosticsWingaRates(branchName)
    res.json(result)
  } catch (err) {
    console.error('[admin-diagnostics] Winga rates test failed:', err.message)
    res.status(500).json({ error: err.message, api: 'Winga Exchange Rates' })
  }
})

router.get('/diagnostics/winga-branches', async (_req, res) => {
  try {
    const result = await diagnosticsWingaBranches()
    res.json(result)
  } catch (err) {
    console.error('[admin-diagnostics] Winga branches test failed:', err.message)
    res.status(500).json({ error: err.message, api: 'Winga Branches' })
  }
})

module.exports = router
