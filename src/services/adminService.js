const { v4: uuid } = require('uuid')
const bcrypt = require('bcryptjs')
const db = require('../config/db')

const mem = {
  users: [
    { id: 'usr_admin_001', full_name: 'Winga Admin', email: 'admin@wingaforex.com', phone: '+254700000001', role: 'admin', kyc_status: 'approved' },
    { id: 'usr_client_001', full_name: 'Amina Njeri', email: 'amina@example.com', phone: '+254700000002', role: 'client', kyc_status: 'pending' },
  ],
  branches: [
    { id: 'br_001', name: 'Nairobi CBD', city: 'Nairobi', country: 'Kenya', status: 'active' },
    { id: 'br_002', name: 'Mombasa Exchange', city: 'Mombasa', country: 'Kenya', status: 'active' },
  ],
}

const listUsers = async () => {
  if (!db.isReady()) return mem.users
  const result = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.kyc_status, r.code as role
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     ORDER BY u.created_at DESC`,
  )
  return result.rows
}

const createUser = async ({ fullName, email, phone, role = 'client', password = 'ChangeMe@123' }) => {
  if (!db.isReady()) {
    const row = { id: uuid(), full_name: fullName, email, phone, kyc_status: 'pending', role }
    mem.users.unshift(row)
    return row
  }

  const roleRow = await db.query('SELECT id FROM roles WHERE code = $1 LIMIT 1', [role])
  const roleId = roleRow.rows[0]?.id || null
  const passwordHash = await bcrypt.hash(password, 10)

  const result = await db.query(
    `INSERT INTO users (role_id, full_name, email, phone, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, full_name, email, phone, kyc_status`,
    [roleId, fullName, email, phone, passwordHash],
  )

  return { ...result.rows[0], role }
}

const updateUser = async (id, updates) => {
  if (!db.isReady()) {
    const found = mem.users.find((user) => user.id === id)
    if (!found) return null
    Object.assign(found, updates)
    return found
  }

  const result = await db.query(
    `UPDATE users
     SET full_name = COALESCE($2, full_name),
         phone = COALESCE($3, phone),
         kyc_status = COALESCE($4, kyc_status)
     WHERE id = $1
     RETURNING id, full_name, email, phone, kyc_status`,
    [id, updates.full_name, updates.phone, updates.kyc_status],
  )

  if (!result.rows[0]) return null

  if (updates.role) {
    const roleRow = await db.query('SELECT id FROM roles WHERE code = $1 LIMIT 1', [updates.role])
    if (roleRow.rows[0]) {
      await db.query('UPDATE users SET role_id = $2 WHERE id = $1', [id, roleRow.rows[0].id])
    }
  }

  return { ...result.rows[0], role: updates.role }
}

const deleteUser = async (id) => {
  if (!db.isReady()) {
    const before = mem.users.length
    mem.users = mem.users.filter((user) => user.id !== id)
    return before !== mem.users.length
  }

  const result = await db.query('DELETE FROM users WHERE id = $1', [id])
  return result.rowCount > 0
}

const listKyc = async () => {
  const users = await listUsers()
  return users.filter((item) => item.kyc_status !== 'approved')
}

const updateKycStatus = async (id, status) => updateUser(id, { kyc_status: status })

const listBranches = async () => {
  if (!db.isReady()) return mem.branches
  const result = await db.query('SELECT * FROM branches ORDER BY created_at DESC')
  return result.rows
}

const createBranch = async ({ name, city, country, status = 'active' }) => {
  if (!db.isReady()) {
    const row = { id: uuid(), name, city, country, status }
    mem.branches.unshift(row)
    return row
  }

  const result = await db.query(
    `INSERT INTO branches (name, city, country, status)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, city, country, status],
  )
  return result.rows[0]
}

const updateBranch = async (id, updates) => {
  if (!db.isReady()) {
    const found = mem.branches.find((branch) => branch.id === id)
    if (!found) return null
    Object.assign(found, updates)
    return found
  }

  const result = await db.query(
    `UPDATE branches
     SET name = COALESCE($2, name), city = COALESCE($3, city), country = COALESCE($4, country), status = COALESCE($5, status)
     WHERE id = $1
     RETURNING *`,
    [id, updates.name, updates.city, updates.country, updates.status],
  )
  return result.rows[0] || null
}

const deleteBranch = async (id) => {
  if (!db.isReady()) {
    const before = mem.branches.length
    mem.branches = mem.branches.filter((branch) => branch.id !== id)
    return before !== mem.branches.length
  }

  const result = await db.query('DELETE FROM branches WHERE id = $1', [id])
  return result.rowCount > 0
}

const listAuditLogs = async () => {
  if (!db.isReady()) {
    return [{ id: 'audit_demo_01', action: 'seed.startup', entity: 'system', entity_id: 'bootstrap', ip_address: '127.0.0.1', created_at: new Date().toISOString() }]
  }

  const result = await db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200')
  return result.rows
}

module.exports = {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  listKyc,
  updateKycStatus,
  listBranches,
  createBranch,
  updateBranch,
  deleteBranch,
  listAuditLogs,
}
