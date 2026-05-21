const jwt = require('jsonwebtoken')

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev_access_secret_change_in_production'
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_in_production'

const signAccessToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    ACCESS_SECRET,
    { expiresIn: '15m' },
  )

const signRefreshToken = (user) =>
  jwt.sign({ id: user.id, role: user.role }, REFRESH_SECRET, {
    expiresIn: '7d',
  })

module.exports = { signAccessToken, signRefreshToken }
