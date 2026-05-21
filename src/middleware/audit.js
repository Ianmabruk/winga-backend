const { v4: uuid } = require('uuid')

const attachAuditContext = (req, _res, next) => {
  req.auditContext = {
    requestId: uuid(),
    ip: req.ip,
    device: req.headers['user-agent'] || 'unknown',
    at: new Date().toISOString(),
  }
  next()
}

module.exports = { attachAuditContext }
