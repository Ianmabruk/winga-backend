const { Pool } = require('pg')

const hasDbUrl = Boolean(process.env.DATABASE_URL)

const pool = hasDbUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    })
  : null

module.exports = {
  pool,
  isReady: () => Boolean(pool),
  query: (text, params) => {
    if (!pool) {
      throw new Error('DATABASE_URL is not configured')
    }
    return pool.query(text, params)
  },
}
