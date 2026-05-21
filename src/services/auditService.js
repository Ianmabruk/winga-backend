const db = require('../config/db')

const logAudit = async ({ actorUserId = null, action, entity, entityId = null, ip, device, payload = {} }) => {
  if (!action || !entity) return

  const query = `
    INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, ip_address, device_info, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `

  if (!db.isReady()) return

  await db.query(query, [
    actorUserId,
    action,
    entity,
    entityId,
    ip || null,
    device || null,
    JSON.stringify(payload),
  ])
}

module.exports = { logAudit }
