'use strict'

/**
 * merkler — Ideablock per-org Merkle tree service
 *
 * Nightly cron at 11:30 PM EST builds a Merkle tree from each org's daily
 * idea-hash hopper and pins the root to Bitcoin via timeglue (one tx per org).
 *
 * Bolt Ideas bypass the hopper and are pinned immediately at 1.5× fastestFee.
 *
 * Auth:
 *   All endpoints require the MERKLER_SERVICE_KEY header to match the
 *   MERKLER_SERVICE_KEY env var. This is an internal service — only the
 *   Ideablock backend should call it.
 */

const dotenv = require('dotenv')
dotenv.config()

const express = require('express')
const bodyParser = require('body-parser')
const cron = require('node-cron')
const merkler = require('./merkler.js')

const app = express()
const PORT = process.env.PORT || 4000
const SERVICE_KEY = process.env.MERKLER_SERVICE_KEY || ''

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireServiceKey (req, res, next) {
  if (!SERVICE_KEY) {
    // In dev with no key set, warn but allow
    console.warn('merkler: ⚠️  MERKLER_SERVICE_KEY not set — allowing unauthenticated request')
    return next()
  }
  const provided = req.headers['x-merkler-key'] || req.headers['authorization']?.replace('Bearer ', '')
  if (provided !== SERVICE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/hopper
 * Add a hash to an org's daily hopper.
 *
 * Body: { orgId: string, hash: string, ideaId: string }
 */
app.post('/api/hopper', requireServiceKey, async (req, res) => {
  const { orgId, hash, ideaId } = req.body
  if (!orgId || !hash) {
    return res.status(400).json({ error: 'orgId and hash are required' })
  }
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    return res.status(400).json({ error: 'hash must be a 64-char hex SHA-256' })
  }
  try {
    const result = await merkler.addToHopper(orgId, hash, ideaId || '')
    return res.status(200).json(result)
  } catch (err) {
    console.error('POST /api/hopper error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/hopper/:orgId
 * Admin view: get today's pending hopper for an org.
 * Optional query param: ?date=YYYY-MM-DD (defaults to today)
 */
app.get('/api/hopper/:orgId', requireServiceKey, async (req, res) => {
  const { orgId } = req.params
  const { date } = req.query
  try {
    const hopper = await merkler.getHopper(orgId, date)
    return res.status(200).json(hopper)
  } catch (err) {
    console.error('GET /api/hopper error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/bolt
 * Bolt Idea — bypass hopper and pin immediately at 1.5× fastestFee.
 * CC on file must be verified by the backend before calling this endpoint.
 *
 * Body: { orgId: string, hash: string, ideaId: string }
 */
app.post('/api/bolt', requireServiceKey, async (req, res) => {
  const { orgId, hash, ideaId } = req.body
  if (!orgId || !hash) {
    return res.status(400).json({ error: 'orgId and hash are required' })
  }
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    return res.status(400).json({ error: 'hash must be a 64-char hex SHA-256' })
  }
  try {
    const result = await merkler.boltPin(orgId, hash, ideaId || '')
    return res.status(200).json(result)
  } catch (err) {
    console.error('POST /api/bolt error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/bolt/promote
 * Admin: promote a pending hopper hash to a Bolt (removes from hopper, pins immediately).
 *
 * Body: { orgId: string, hash: string, ideaId: string }
 */
app.post('/api/bolt/promote', requireServiceKey, async (req, res) => {
  const { orgId, hash, ideaId } = req.body
  if (!orgId || !hash) {
    return res.status(400).json({ error: 'orgId and hash are required' })
  }
  try {
    const result = await merkler.promoteHashToBolt(orgId, hash, ideaId || '')
    return res.status(200).json(result)
  } catch (err) {
    console.error('POST /api/bolt/promote error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/bolts/:orgId
 * Get all bolt-pinned ideas for an org (newest first).
 */
app.get('/api/bolts/:orgId', requireServiceKey, async (req, res) => {
  const { orgId } = req.params
  try {
    const bolts = await merkler.getBolts(orgId)
    return res.status(200).json({ orgId, bolts })
  } catch (err) {
    console.error('GET /api/bolts error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/merk
 * Nightly cron trigger — build and pin all pending org hoppers for today.
 * Also called automatically by node-cron at 11:30 PM EST.
 */
app.post('/api/merk', requireServiceKey, async (req, res) => {
  try {
    const results = await merkler.buildAndPinAll()
    return res.status(200).json({ date: merkler.todayUTC(), orgsProcessed: results.length, results })
  } catch (err) {
    console.error('POST /api/merk error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/tree/:orgId/:date
 * Get the stored Merkle tree for an org on a given date (YYYY-MM-DD).
 */
app.get('/api/tree/:orgId/:date', requireServiceKey, async (req, res) => {
  const { orgId, date } = req.params
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
  }
  try {
    const tree = await merkler.getTree(orgId, date)
    return res.status(200).json(tree)
  } catch (err) {
    console.error('GET /api/tree error:', err.message)
    return res.status(404).json({ error: err.message })
  }
})

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'merkler', date: merkler.todayUTC() })
})

// ── Nightly cron ──────────────────────────────────────────────────────────────

// 11:30 PM EST = 04:30 AM UTC (UTC-5 in winter / UTC-4 in summer)
// We use 04:30 UTC which is safe for both EST and EDT.
// If you need exact local-time scheduling, use a TZ-aware approach or Cloud Scheduler.
const CRON_SCHEDULE = process.env.MERKLER_CRON || '30 4 * * *'

cron.schedule(CRON_SCHEDULE, async () => {
  console.log(`merkler: cron fired (${CRON_SCHEDULE} UTC) — running nightly merk`)
  try {
    const results = await merkler.buildAndPinAll()
    console.log(`merkler: cron complete — ${results.length} orgs processed`)
  } catch (err) {
    console.error('merkler: cron error:', err.message)
  }
}, {
  timezone: 'UTC'
})

console.log(`merkler: nightly cron scheduled at "${CRON_SCHEDULE}" UTC (≈ 11:30 PM EST)`)

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`merkler: listening on port ${PORT}`)
  console.log(`merkler: timeglue URL: ${process.env.TIMEGLUE_URL || 'http://localhost:2312'}`)
})
