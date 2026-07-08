CREATE DATABASE IF NOT EXISTS winga_forex
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE winga_forex;

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role_id INT NULL,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(32),
  password_hash TEXT NOT NULL,
  kyc_status VARCHAR(32) DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  ip_address VARCHAR(60),
  device_fingerprint TEXT,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_name VARCHAR(120) NOT NULL,
  currency_code VARCHAR(8) NOT NULL,
  currency_name VARCHAR(120) NOT NULL,
  currency_actual_name VARCHAR(120),
  currency_sequence INT DEFAULT 0,
  buying_rate DECIMAL(18, 6) NOT NULL,
  selling_rate DECIMAL(18, 6) NOT NULL,
  effective_date_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  source VARCHAR(60) DEFAULT 'internal',
  INDEX idx_exchange_rates_branch (branch_name),
  INDEX idx_exchange_rates_currency (currency_code),
  INDEX idx_exchange_rates_updated (updated_at)
);

CREATE TABLE IF NOT EXISTS system_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(32) NOT NULL,
  message TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_system_logs_type (type),
  INDEX idx_system_logs_created (created_at)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  from_currency VARCHAR(8) NOT NULL,
  to_currency VARCHAR(8) NOT NULL,
  amount DECIMAL(18, 6) NOT NULL,
  gross_converted DECIMAL(18, 6) NOT NULL,
  spread DECIMAL(18, 6) NOT NULL,
  transfer_fee DECIMAL(18, 6) NOT NULL,
  commission DECIMAL(18, 6) NOT NULL,
  net_amount DECIMAL(18, 6) NOT NULL,
  status VARCHAR(20) DEFAULT 'completed',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_transaction_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS forex_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  card_type VARCHAR(40) NOT NULL,
  masked_pan VARCHAR(32) NOT NULL,
  frozen BOOLEAN DEFAULT FALSE,
  spending_limit DECIMAL(18, 2) DEFAULT 0,
  balance DECIMAL(18, 2) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_card_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  actor_user_id INT NULL,
  action VARCHAR(120) NOT NULL,
  entity VARCHAR(80),
  entity_id VARCHAR(120),
  ip_address VARCHAR(60),
  device_info TEXT,
  payload JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS branch_analytics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_name VARCHAR(120) NOT NULL,
  currency_code VARCHAR(8) NOT NULL,
  demand_score DECIMAL(6, 3) NOT NULL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  city VARCHAR(80) NOT NULL,
  country VARCHAR(80) NOT NULL,
  status VARCHAR(24) DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO roles (code, description) VALUES
  ('admin', 'Platform administrators'),
  ('client', 'Retail forex customers');

INSERT IGNORE INTO branches (name, city, country, status) VALUES
  ('HEAD OFFICE', 'Dar es Salaam', 'Tanzania', 'active');
