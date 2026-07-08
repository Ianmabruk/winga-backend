const mysql = require('mysql2/promise')

const hasDbConfig =
  process.env.DB_HOST &&
  process.env.DB_NAME &&
  process.env.DB_USER

const pool = hasDbConfig
  ? mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    })
  : null

module.exports = {
  pool,
  isReady: () => Boolean(pool),
  query: (sql, params) => {
    if (!pool) {
      throw new Error('Database is not configured')
    }
    return pool.query(sql, params)
  },
}
