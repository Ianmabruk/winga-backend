const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { signAccessToken, signRefreshToken } = require('../utils/tokens')
const db = require('../config/db')

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev_access_secret_change_in_production'
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_in_production'

const router = express.Router()

const mockUser = {
  id: 'usr_admin_001',
  email: 'admin@wingaforex.com',
  role: 'admin',
  passwordHash: bcrypt.hashSync('Admin@12345', 10),
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' })
  }

  let user = mockUser
  let passwordHash = mockUser.passwordHash

  if (db.isReady()) {
    const result = await db.query(
      `SELECT u.id, u.email, u.password_hash, r.code as role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE lower(u.email) = lower($1)
       LIMIT 1`,
      [email],
    )

    const found = result.rows[0]
    if (!found) return res.status(401).json({ message: 'Invalid credentials' })
    user = { id: found.id, email: found.email, role: found.role || 'client' }
    passwordHash = found.password_hash
  } else if (email !== mockUser.email) {
    return res.status(401).json({ message: 'Invalid credentials' })
  }

  const match = await bcrypt.compare(password, passwordHash)
  if (!match) return res.status(401).json({ message: 'Invalid credentials' })

  if (db.isReady()) {
    const refreshHash = await bcrypt.hash(`r:${user.id}:${Date.now()}`, 8)
    await db.query(
      `INSERT INTO sessions (user_id, refresh_token_hash, ip_address, device_fingerprint, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + interval '7 days')`,
      [
        user.id,
        refreshHash,
        req.auditContext?.ip || null,
        req.auditContext?.device || null,
      ],
    )
  }

  const accessToken = signAccessToken(user)
  const refreshToken = signRefreshToken(user)

  return res.json({
    user: { id: user.id, email: user.email, role: user.role },
    accessToken,
    refreshToken,
  })
})

router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body
  if (!refreshToken) return res.status(400).json({ message: 'Missing refresh token' })

  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET)
    const accessToken = jwt.sign(
      { id: payload.id, role: payload.role },
      ACCESS_SECRET,
      { expiresIn: '15m' },
    )
    return res.json({ accessToken })
  } catch {
    return res.status(401).json({ message: 'Invalid refresh token' })
  }
})

module.exports = router
