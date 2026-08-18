#!/usr/bin/env node
// Inspection-only script: captures raw Winga API response without modifying app logic.
// Usage: node backend/scripts/inspect-winga-response.js

require('dotenv').config({ path: '.env' })
const fs = require('fs')
const path = require('path')
const axios = require('axios')

const LOGS_DIR = path.join(__dirname, '..', 'logs')
const RAW_RESPONSE_FILE = path.join(LOGS_DIR, 'winga-raw-response.json')

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })

const WINGA_API_KEY = process.env.WINGA_API_KEY
const WINGA_API_SECRET = process.env.WINGA_API_SECRET
const WINGA_BRANCH = process.env.WINGA_BRANCH || 'HEAD OFFICE'
const API_URL = process.env.VITE_API_URL || process.env.API_URL || 'http://localhost:4000'

const WINGA_RATES_ENDPOINT =
  'https://forex.wingaforex.co.tz/api/method/forex_bureau.vsd_forex_bureau.doctype.branch.api.get_exchange_rates'

const AUTH_HEADER = WINGA_API_KEY && WINGA_API_SECRET
  ? `token ${WINGA_API_KEY}:${WINGA_API_SECRET}`
  : ''

async function inspect() {
  console.log('=== Winga API Raw Response Inspection ===\n')

  if (!AUTH_HEADER) {
    console.error('ERROR: WINGA_API_KEY and WINGA_API_SECRET are not configured in .env')
    process.exit(1)
  }

  // 1. Capture raw response from Winga API
  console.log('[1] Fetching raw response from Winga API...')
  console.log(`    Endpoint: ${WINGA_RATES_ENDPOINT}`)
  console.log(`    Branch: ${WINGA_BRANCH}`)
  console.log(`    Time: ${new Date().toISOString()}\n`)

  let rawStatus = null
  let rawHeaders = null
  let rawBody = null
  let rawError = null

  try {
    const response = await axios.get(WINGA_RATES_ENDPOINT, {
      params: {
        branch_name: WINGA_BRANCH,
        _: Date.now(),
        t: Date.now(),
      },
      headers: {
        Authorization: AUTH_HEADER,
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Cache-Bypass': 'true',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 15000,
      validateStatus: () => true,
    })

    rawStatus = response.status
    rawHeaders = response.headers
    rawBody = response.data

    console.log(`    HTTP Status: ${rawStatus}`)
    console.log(`    Response Headers:`)
    for (const [key, value] of Object.entries(rawHeaders)) {
      console.log(`      ${key}: ${value}`)
    }
    console.log(`\n    Raw Response Body:`)
    console.log(JSON.stringify(rawBody, null, 2))
    console.log('')

    // Save to file
    const output = {
      inspectedAt: new Date().toISOString(),
      endpoint: WINGA_RATES_ENDPOINT,
      branch: WINGA_BRANCH,
      requestParams: {
        branch_name: WINGA_BRANCH,
        _: Date.now(),
        t: Date.now(),
      },
      requestHeaders: {
        Authorization: AUTH_HEADER.slice(0, 20) + '...',
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Cache-Bypass': 'true',
        'X-Requested-With': 'XMLHttpRequest',
      },
      response: {
        status: rawStatus,
        headers: rawHeaders,
        body: rawBody,
      },
      analysis: analyzeResponse(rawBody),
    }

    fs.writeFileSync(RAW_RESPONSE_FILE, JSON.stringify(output, null, 2))
    console.log(`    [OK] Raw response saved to: ${RAW_RESPONSE_FILE}`)
  } catch (err) {
    rawError = err.message
    console.error(`    [FAIL] Request failed: ${err.message}`)
    if (err.response) {
      console.error(`    Status: ${err.response.status}`)
      console.error(`    Body: ${JSON.stringify(err.response.data, null, 2)}`)
    }
  }

  // 2. Call /api/rates/live and compare
  console.log('\n[2] Calling /api/rates/live for comparison...')
  try {
    const liveResponse = await axios.get(`${API_URL}/api/rates/live`, {
      params: { branch_name: WINGA_BRANCH },
      timeout: 15000,
    })

    const liveData = liveResponse.data
    console.log(`    HTTP Status: ${liveResponse.status}`)
    console.log(`    Response Body:`)
    console.log(JSON.stringify(liveData, null, 2))
    console.log('')

    // Compare
    if (rawBody && liveData) {
      console.log('[3] Comparison: Raw API vs /api/rates/live')
      console.log('    Raw API message length:', Array.isArray(rawBody.message) ? rawBody.message.length : 'N/A')
      console.log('    /api/rates/live message length:', Array.isArray(liveData.message) ? liveData.message.length : 'N/A')
      console.log('    /api/rates/live stale:', liveData.stale)
      console.log('    /api/rates/live provider:', liveData.provider)
      console.log('    /api/rates/live providerTimestamp:', liveData.providerTimestamp)
      console.log('    /api/rates/live staleReason:', liveData.staleReason)
      console.log('    /api/rates/live source:', liveData.source)

      if (Array.isArray(rawBody.message) && Array.isArray(liveData.message)) {
        const rawCodes = rawBody.message.map(r => r.currency_code).sort()
        const liveCodes = liveData.message.map(r => r.currency_code).sort()
        console.log('    Raw API currency codes:', rawCodes.join(', '))
        console.log('    Live endpoint currency codes:', liveCodes.join(', '))
        console.log('    Codes match:', JSON.stringify(rawCodes) === JSON.stringify(liveCodes))

        // Check if stale data was filtered
        const staleInRaw = rawBody.message.filter(r => {
          if (!r.effective_date_and_time) return false
          const d = new Date(r.effective_date_and_time.replace(' ', 'T'))
          return isNaN(d.getTime()) ? false : (Date.now() - d.getTime() > 60 * 60 * 1000)
        })
        console.log('    Stale entries in raw API:', staleInRaw.length, '/', rawBody.message.length)

        if (liveData.stale && rawBody.message.length > 0 && liveData.message.length === 0) {
          console.log('    [DIFF] Live endpoint rejected ALL raw rates due to staleness')
        }
      }
    }
  } catch (err) {
    console.error(`    [FAIL] /api/rates/live request failed: ${err.message}`)
  }

  // 4. Try DB comparison if available
  console.log('\n[4] Attempting database comparison...')
  try {
    const mysql = require('mysql2/promise')
    const dbConfig = {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    }

    if (!dbConfig.host || !dbConfig.user || !dbConfig.database) {
      console.log('    [SKIP] Database not configured in .env')
      return
    }

    const connection = await mysql.createConnection(dbConfig)
    const [rows] = await connection.query(
      `SELECT currency_code, buying_rate, selling_rate, effective_date_and_time, updated_at, source FROM exchange_rates WHERE branch_name = ? ORDER BY currency_code ASC`,
      [WINGA_BRANCH]
    )
    await connection.end()

    console.log(`    [OK] Database query returned ${rows.length} rows`)
    if (rows.length > 0) {
      console.log('    Database sample:')
      for (const row of rows.slice(0, 5)) {
        console.log(`      ${row.currency_code}: buy=${row.buying_rate}, sell=${row.selling_rate}, eff=${row.effective_date_and_time}, updated=${row.updated_at}, source=${row.source}`)
      }

      if (rawBody && Array.isArray(rawBody.message)) {
        console.log('\n    [COMPARISON] Raw API vs Database:')
        const rawMap = {}
        for (const r of rawBody.message) {
          rawMap[r.currency_code] = {
            buy: r.buying_rate,
            sell: r.selling_rate,
            effective_date_and_time: r.effective_date_and_time,
          }
        }

        let differences = 0
        for (const row of rows) {
          const raw = rawMap[row.currency_code]
          if (!raw) {
            console.log(`      [DIFF] ${row.currency_code}: IN DB BUT NOT IN RAW API`)
            differences++
            continue
          }
          const buyDiff = Number(raw.buy) !== Number(row.buying_rate)
          const sellDiff = Number(raw.sell) !== Number(row.selling_rate)
          const effDiff = raw.effective_date_and_time !== row.effective_date_and_time
          if (buyDiff || sellDiff || effDiff) {
            console.log(`      [DIFF] ${row.currency_code}:`)
            if (buyDiff) console.log(`        buy:  raw=${raw.buy} db=${row.buying_rate}`)
            if (sellDiff) console.log(`        sell: raw=${raw.sell} db=${row.selling_rate}`)
            if (effDiff) console.log(`        effective_date_and_time: raw=${raw.effective_date_and_time} db=${row.effective_date_and_time}`)
            differences++
          }
        }

        const rawOnly = Object.keys(rawMap).filter(code => !rows.find(r => r.currency_code === code))
        for (const code of rawOnly) {
          console.log(`      [DIFF] ${code}: IN RAW API BUT NOT IN DB`)
          differences++
        }

        if (differences === 0) {
          console.log('      [OK] No differences found between raw API and database')
        } else {
          console.log(`      [SUMMARY] ${differences} difference(s) found`)
        }
      }
    } else {
      console.log('    [INFO] Database table is empty')
    }
  } catch (err) {
    console.error(`    [FAIL] Database comparison failed: ${err.message}`)
  }

  console.log('\n=== Inspection Complete ===')
}

function analyzeResponse(body) {
  if (!body || !body.message || !Array.isArray(body.message)) {
    return { error: 'Invalid response structure' }
  }

  const rates = body.message
  const timestampFields = new Set()
  const ratesSummary = []

  for (const r of rates) {
    for (const key of Object.keys(r)) {
      if (key.toLowerCase().includes('date') || key.toLowerCase().includes('time') || key.toLowerCase().includes('timestamp')) {
        timestampFields.add(key)
      }
    }
    ratesSummary.push({
      currency_code: r.currency_code,
      buying_rate: r.buying_rate,
      selling_rate: r.selling_rate,
      effective_date_and_time: r.effective_date_and_time,
    })
  }

  return {
    totalRates: rates.length,
    timestampFields: Array.from(timestampFields),
    ratesSummary,
  }
}

inspect().catch(err => {
  console.error('Inspection script failed:', err)
  process.exit(1)
})
