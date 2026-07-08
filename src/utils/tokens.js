const jwt = require('jsonwebtoken')

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

const signAccessToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    ACCESS_SECRET,
    { expiresIn: '15m' },
  )

const signRefreshToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role },
    REFRESH_SECRET,
    { expiresIn: '7d' },
  )

module.exports = { signAccessToken, signRefreshToken }
