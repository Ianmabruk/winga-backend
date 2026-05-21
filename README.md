# WINGA FOREX BUREAU Backend

Node.js + Express API for forex rates, secure authentication, analytics, and real-time updates.

## Run

```bash
cp .env.example .env
npm install
npm run dev
```

## Security

- Helmet headers
- Rate limiting
- JWT access + refresh token flow
- Role-based authorization
- Audit context middleware
- CSRF token endpoint

## Routes

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/rates`
- `POST /api/rates/calculate`
- `GET /api/analytics/user` (auth required)
- `GET /api/analytics/admin` (admin only)
- `GET /api/csrf-token`

## Database

Schema is in `database/schema.sql`.
