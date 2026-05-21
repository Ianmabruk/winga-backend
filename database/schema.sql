CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID REFERENCES roles(id),
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(32),
  password_hash TEXT NOT NULL,
  kyc_status VARCHAR(32) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  refresh_token_hash TEXT NOT NULL,
  ip_address VARCHAR(60),
  device_fingerprint TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_code VARCHAR(8) NOT NULL,
  buy NUMERIC(18, 6) NOT NULL,
  sell NUMERIC(18, 6) NOT NULL,
  source VARCHAR(60) DEFAULT 'internal',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  from_currency VARCHAR(8) NOT NULL,
  to_currency VARCHAR(8) NOT NULL,
  amount NUMERIC(18, 6) NOT NULL,
  gross_converted NUMERIC(18, 6) NOT NULL,
  spread NUMERIC(18, 6) NOT NULL,
  transfer_fee NUMERIC(18, 6) NOT NULL,
  commission NUMERIC(18, 6) NOT NULL,
  net_amount NUMERIC(18, 6) NOT NULL,
  status VARCHAR(20) DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forex_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  card_type VARCHAR(40) NOT NULL,
  masked_pan VARCHAR(32) NOT NULL,
  frozen BOOLEAN DEFAULT false,
  spending_limit NUMERIC(18, 2) DEFAULT 0,
  balance NUMERIC(18, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  action VARCHAR(120) NOT NULL,
  entity VARCHAR(80),
  entity_id VARCHAR(120),
  ip_address VARCHAR(60),
  device_info TEXT,
  payload JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS branch_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_name VARCHAR(120) NOT NULL,
  currency_code VARCHAR(8) NOT NULL,
  demand_score NUMERIC(6, 3) NOT NULL,
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  city VARCHAR(80) NOT NULL,
  country VARCHAR(80) NOT NULL,
  status VARCHAR(24) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO roles (code, description)
VALUES
  ('admin', 'Platform administrators'),
  ('client', 'Retail forex customers')
ON CONFLICT (code) DO NOTHING;

INSERT INTO branches (name, city, country, status)
VALUES
  ('Nairobi CBD', 'Nairobi', 'Kenya', 'active'),
  ('Mombasa Exchange', 'Mombasa', 'Kenya', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO users (role_id, full_name, email, phone, password_hash, kyc_status)
SELECT r.id, 'Winga Admin', 'admin@wingaforex.com', '+254700000001', '$2b$10$jWIxxrehikSZYs8pkxWvQuqeE6MAEVdj45tDMKPsgE04nvdDsf2Pm', 'approved'
FROM roles r
WHERE r.code = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM users WHERE email = 'admin@wingaforex.com'
  );
