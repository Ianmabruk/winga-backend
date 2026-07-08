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
  if (!db.isReady()) {
    return mem.users
  }
  const result = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.kyc_status, r.code as role
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     ORDER BY u.created_at DESC`,
  )
  return result[0]
}

const createUser = async ({ fullName, email, phone, role = 'client', password }) => {
  if (!db.isReady()) {
    const row = { id: uuid(), full_name: fullName, email, phone, kyc_status: 'pending', role }
    mem.users.unshift(row)
    return row
  }

  const roleRow = await db.query('SELECT id FROM roles WHERE code = ? LIMIT 1', [role])
  const roleId = roleRow[0][0]?.id || null
  const passwordHash = await bcrypt.hash(password, 10)

  const result = await db.query(
    `INSERT INTO users (role_id, full_name, email, phone, password_hash)
     VALUES (?, ?, ?, ?, ?)`,
    [roleId, fullName, email, phone, passwordHash],
  )

  const inserted = await db.query(
    'SELECT id, full_name, email, phone, kyc_status FROM users WHERE id = ?',
    [result[0].insertId],
  )

  return { ...inserted[0][0], role }
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
     SET full_name = COALESCE(?, full_name),
         phone = COALESCE(?, phone),
         kyc_status = COALESCE(?, kyc_status)
     WHERE id = ?`,
    [updates.full_name, updates.phone, updates.kyc_status, id]
  )

  if (result[0].affectedRows === 0) return null

  if (updates.role) {
    const roleRow = await db.query('SELECT id FROM roles WHERE code = ? LIMIT 1', [updates.role])
    if (roleRow[0][0]) {
      await db.query('UPDATE users SET role_id = ? WHERE id = ?', [roleRow[0][0].id, id])
    }
  }

  const updated = await db.query(
    'SELECT id, full_name, email, phone, kyc_status FROM users WHERE id = ?',
    [id]
  )

  return { ...updated[0][0], role: updates.role }
}

const deleteUser = async (id) => {
  if (!db.isReady()) {
    const before = mem.users.length
    mem.users = mem.users.filter((user) => user.id !== id)
    return before !== mem.users.length
  }

  const result = await db.query('DELETE FROM users WHERE id = ?', [id])
  return result[0].affectedRows > 0
}

const listKyc = async () => {
  const users = await listUsers()
  return users.filter((item) => item.kyc_status !== 'approved')
}

const updateKycStatus = async (id, status) => updateUser(id, { kyc_status: status })

const listBranches = async () => {
  if (!db.isReady()) {
    return mem.branches
  }
  const result = await db.query('SELECT * FROM branches ORDER BY created_at DESC')
  return result[0]
}

const createBranch = async ({ name, city, country, status = 'active' }) => {
  if (!db.isReady()) {
    const row = { id: uuid(), name, city, country, status }
    mem.branches.unshift(row)
    return row
  }

  const result = await db.query(
    `INSERT INTO branches (name, city, country, status)
     VALUES (?, ?, ?, ?)`,
    [name, city, country, status],
  )

  const inserted = await db.query(
    'SELECT * FROM branches WHERE id = ?',
    [result[0].insertId],
  )

  return inserted[0][0]
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
     SET name = COALESCE(?, name), city = COALESCE(?, city), country = COALESCE(?, country), status = COALESCE(?, status)
     WHERE id = ?`,
    [id, updates.name, updates.city, updates.country, updates.status],
  )

  if (result[0].affectedRows === 0) return null

  const updated = await db.query('SELECT * FROM branches WHERE id = ?', [id])
  return updated[0][0] || null
}

const deleteBranch = async (id) => {
  if (!db.isReady()) {
    const before = mem.branches.length
    mem.branches = mem.branches.filter((branch) => branch.id !== id)
    return before !== mem.branches.length
  }

  const result = await db.query('DELETE FROM branches WHERE id = ?', [id])
  return result[0].affectedRows > 0
}

const listAuditLogs = async () => {
  if (!db.isReady()) {
    return [{ id: 'audit_demo_01', action: 'seed.startup', entity: 'system', entity_id: 'bootstrap', ip_address: '127.0.0.1', created_at: new Date().toISOString() }]
  }

  const result = await db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', [200])
  return result[0]
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
