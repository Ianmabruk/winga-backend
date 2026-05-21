const express = require('express')
const { authRequired } = require('../middleware/auth')
const { allowRoles } = require('../middleware/roles')
const adminService = require('../services/adminService')
const { logAudit } = require('../services/auditService')

const router = express.Router()

router.use(authRequired, allowRoles('admin'))

router.get('/users', async (_req, res) => {
  const users = await adminService.listUsers()
  res.json({ users })
})

router.post('/users', async (req, res) => {
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

router.put('/users/:id', async (req, res) => {
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

router.delete('/users/:id', async (req, res) => {
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

router.patch('/kyc/:id', async (req, res) => {
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

router.post('/branches', async (req, res) => {
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

router.put('/branches/:id', async (req, res) => {
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

router.delete('/branches/:id', async (req, res) => {
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

module.exports = router
