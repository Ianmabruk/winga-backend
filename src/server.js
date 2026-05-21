require('dotenv').config()

const http = require('http')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const csrf = require('csurf')
const rateLimit = require('express-rate-limit')
const { Server } = require('socket.io')

const authRoutes = require('./routes/auth')
const rateRoutes = require('./routes/rates')
const analyticsRoutes = require('./routes/analytics')
const adminRoutes = require('./routes/admin')
const { attachAuditContext } = require('./middleware/audit')
const { refreshFromProvider } = require('./services/rateEngine')

const app = express()
const server = http.createServer(app)

const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const isAllowedOrigin = (origin) => {
  if (!origin) return true
  if (allowedOrigins.includes('*')) return true
  if (allowedOrigins.includes(origin)) return true
  return /^http:\/\/localhost:\d+$/.test(origin)
}

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) return callback(null, true)
      return callback(new Error('CORS not allowed'))
    },
  },
})

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 140,
  standardHeaders: true,
  legacyHeaders: false,
})

app.use(helmet())
app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) return callback(null, true)
      return callback(new Error('CORS not allowed'))
    },
  }),
)
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(attachAuditContext)
app.use('/api', limiter)

const csrfProtection = csrf({ cookie: true })
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() })
})

app.use('/api/auth', authRoutes)
app.use('/api/rates', rateRoutes)
app.use('/api/analytics', analyticsRoutes)
app.use('/api/admin', adminRoutes)

app.get('/health', (_req, res) => {
  res.json({
    service: 'Winga Forex Bureau API',
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

io.on('connection', async (socket) => {
  const rates = await refreshFromProvider()
  socket.emit('rates:update', { rates, source: 'init' })
})

setInterval(async () => {
  const rates = await refreshFromProvider()
  io.emit('rates:update', { rates, source: 'interval' })
}, 10000)

const port = Number(process.env.PORT || 4000)
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Winga backend running on port ${port}`)
})
