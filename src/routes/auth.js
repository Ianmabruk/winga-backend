const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { signAccessToken, signRefreshToken } = require('../utils/tokens')
const db = require('../config/db')

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET

if (process.env.NODE_ENV === 'production') {
  if (!ACCESS_SECRET) {
    throw new Error('JWT_ACCESS_SECRET is required in production')
  }
  if (!REFRESH_SECRET) {
    throw new Error('JWT_REFRESH_SECRET is required in production')
  }
}

const router = express.Router()

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' })
  }

  let user = null
  let passwordHash = null

  if (db.isReady()) {
    const result = await db.query(
      `SELECT u.id, u.email, u.password_hash, r.code as role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE lower(u.email) = lower(?)
       LIMIT 1`,
      [email],
    )

    const found = result[0][0]
    if (!found) return res.status(401).json({ message: 'Invalid credentials' })
    user = { id: found.id, email: found.email, role: found.role || 'client' }
    passwordHash = found.password_hash
  } else {
    // In production, database must be configured
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).json({ message: 'Service temporarily unavailable' })
    }
    // Development fallback mock users
    const mockUsers = [
      {
        id: 'usr_admin_001',
        email: 'admin@wingaforex.co.tz',
        role: 'admin',
        passwordHash: bcrypt.hashSync('Admin@12345', 10),
      },
      {
        id: 'usr_client_001',
        email: 'client@wingaforex.co.tz',
        role: 'client',
        passwordHash: bcrypt.hashSync('Client@12345', 10),
      },
    ]
    const found = mockUsers.find((item) => item.email.toLowerCase() === email.toLowerCase())
    if (!found) return res.status(401).json({ message: 'Invalid credentials' })
    user = { id: found.id, email: found.email, role: found.role }
    passwordHash = found.passwordHash
  }

  const match = await bcrypt.compare(password, passwordHash)
  if (!match) return res.status(401).json({ message: 'Invalid credentials' })

  if (db.isReady()) {
    const refreshHash = await bcrypt.hash(`r:${user.id}:${Date.now()}`, 8)
      await db.query(
        `INSERT INTO sessions (user_id, refresh_token_hash, ip_address, device_fingerprint, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
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
