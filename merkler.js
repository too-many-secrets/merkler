'use strict'

/**
 * merkler.js — Ideablock per-org Merkle tree service
 *
 * Architecture:
 *   - Each organisation has its own daily hopper in Firestore.
 *   - At 11:30 PM EST (node-cron in app.js), all hoppers are flushed:
 *       buildAndPinAll() builds a Merkle tree per org and pins each root
 *       to Bitcoin via timeglue (one Bitcoin tx per org per day).
 *   - Bolt Ideas bypass the hopper and are pinned immediately at 1.5× fastestFee.
 *
 * Firestore schema:
 *   hoppers/{orgId}_{date} (e.g. "acme_2026-05-18")
 *     orgId        string
 *     date         string  (YYYY-MM-DD UTC)
 *     hashes       string[]
 *     ideaIds      string[]  (parallel array to hashes)
 *     root         string    (set after merk run)
 *     layers       object    (full tree for provability)
 *     btcTx        string
 *     btcStatus    string    ("pending"|"submitted"|"baking"|"confirmed")
 *     merkedAt     timestamp | null
 *
 *   bolts/{boltId}  (auto-id)
 *     orgId        string
 *     ideaId       string
 *     hash         string
 *     btcTx        string
 *     btcStatus    string
 *     feeMultiplier float   (always 1.5)
 *     pinnedAt     timestamp
 */

const dotenv = require('dotenv')
dotenv.config()

const { Firestore } = require('@google-cloud/firestore')
const { MerkleTree } = require('merkletreejs')
const SHA256 = require('crypto-js/sha256')
const fetch = require('node-fetch')
const path = require('path')

// ── Config ────────────────────────────────────────────────────────────────────

const TIMEGLUE_URL = process.env.TIMEGLUE_URL || 'http://localhost:2312'
const BOLT_FEE_MULTIPLIER = 1.5

// ── Firestore client ──────────────────────────────────────────────────────────

let db
if (process.env.GCP_FIRESTORE_KEYFILE) {
  db = new Firestore({
    projectId: process.env.GCP_PROJECT_ID,
    keyFilename: path.join(__dirname, process.env.GCP_FIRESTORE_KEYFILE)
  })
} else if (process.env.GCP_PROJECT_ID) {
  // Application Default Credentials (Cloud Run, GKE, etc.)
  db = new Firestore({ projectId: process.env.GCP_PROJECT_ID })
} else {
  console.warn('merkler: ⚠️  No GCP credentials — Firestore calls will fail. Set GCP_PROJECT_ID and optionally GCP_FIRESTORE_KEYFILE.')
  db = null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns today's date as YYYY-MM-DD (UTC).
 */
function todayUTC () {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Hopper document key for an org on a given date.
 */
function hopperKey (orgId, date) {
  return `${orgId}_${date}`
}

/**
 * Hash a string value using SHA-256 (via crypto-js).
 * merkletreejs expects Buffer or hex-string leaves — we convert to hex.
 */
function sha256hex (value) {
  return SHA256(value).toString()
}

// ── timeglue client ───────────────────────────────────────────────────────────

/**
 * Calls timeglue POST /glue to pin a hash on Bitcoin.
 *
 * @param {string} orgId
 * @param {string} hash  64-char hex SHA-256
 * @param {number} [feeMultiplier]  0 = use timeglue's default
 * @returns {Promise<string>}  Bitcoin txid
 */
async function glue (orgId, hash, feeMultiplier) {
  const body = { userID: orgId, hash }
  if (feeMultiplier) body.feeMultiplier = feeMultiplier

  const res = await fetch(`${TIMEGLUE_URL}/glue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`timeglue /glue returned ${res.status}: ${text}`)
  }
  const json = await res.json()
  return json.btcTx
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Add a single idea hash to an org's daily hopper.
 *
 * @param {string} orgId
 * @param {string} hash     64-char hex SHA-256 of the idea
 * @param {string} ideaId   Ideablock idea ID (for provability linkage)
 * @returns {Promise<{ status: string, hopperKey: string, totalHashes: number }>}
 */
async function addToHopper (orgId, hash, ideaId) {
  if (!db) throw new Error('Firestore not configured')

  const date = todayUTC()
  const key = hopperKey(orgId, date)
  const ref = db.collection('hoppers').doc(key)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) {
      tx.set(ref, {
        orgId,
        date,
        hashes: [hash],
        ideaIds: [ideaId || ''],
        root: '',
        layers: {},
        btcTx: '',
        btcStatus: 'pending',
        merkedAt: null
      })
    } else {
      const data = snap.data()
      // Deduplicate: don't add the same hash twice
      if (!data.hashes.includes(hash)) {
        tx.update(ref, {
          hashes: [...data.hashes, hash],
          ideaIds: [...(data.ideaIds || []), ideaId || '']
        })
      }
    }
  })

  const updated = await ref.get()
  const totalHashes = updated.data().hashes.length

  console.log(`merkler: added hash to hopper ${key} (total: ${totalHashes})`)
  return { status: 'added', hopperKey: key, totalHashes }
}

/**
 * Build a Merkle tree for an org's daily hopper and pin the root to Bitcoin.
 * Called by buildAndPinAll() during the nightly cron.
 *
 * @param {string} orgId
 * @param {string} date   YYYY-MM-DD
 * @returns {Promise<{ orgId, root, btcTx, leafCount }>}
 */
async function buildAndPin (orgId, date) {
  if (!db) throw new Error('Firestore not configured')

  const key = hopperKey(orgId, date)
  const ref = db.collection('hoppers').doc(key)
  const snap = await ref.get()

  if (!snap.exists) {
    throw new Error(`No hopper found for org ${orgId} on ${date}`)
  }

  const data = snap.data()

  if (!data.hashes || data.hashes.length === 0) {
    throw new Error(`Hopper for org ${orgId} on ${date} is empty`)
  }

  if (data.btcTx) {
    console.log(`merkler: org ${orgId} on ${date} already pinned — skipping`)
    return { orgId, date, root: data.root, btcTx: data.btcTx, leafCount: data.hashes.length, skipped: true }
  }

  // Build the Merkle tree
  // Leaves are already SHA-256 hashes — we double-hash them in the tree
  // so that leaf preimage resistance holds.
  const leaves = data.hashes.map(h => sha256hex(h))
  const tree = new MerkleTree(leaves, sha256hex, { sortPairs: true })
  const root = tree.getRoot().toString('hex')
  const layers = tree.getLayersAsObject()

  console.log(`merkler: built tree for org ${orgId} on ${date}: ${data.hashes.length} leaves, root=${root.slice(0, 12)}...`)

  // Pin the root to Bitcoin
  const btcTx = await glue(orgId, root, 0)
  console.log(`merkler: pinned root for org ${orgId} on ${date}: btcTx=${btcTx}`)

  // Persist tree + tx to Firestore
  await ref.update({
    root,
    layers,
    btcTx,
    btcStatus: 'submitted',
    merkedAt: new Date()
  })

  return { orgId, date, root, btcTx, leafCount: data.hashes.length }
}

/**
 * Nightly cron: find all hoppers for today, build and pin each one.
 *
 * @returns {Promise<Array>}  Results per org
 */
async function buildAndPinAll () {
  if (!db) throw new Error('Firestore not configured')

  const date = todayUTC()
  console.log(`merkler: nightly merk run for ${date}`)

  // Find all hoppers for today that haven't been pinned yet
  const snap = await db.collection('hoppers')
    .where('date', '==', date)
    .where('btcTx', '==', '')
    .where('btcStatus', '==', 'pending')
    .get()

  if (snap.empty) {
    console.log(`merkler: no pending hoppers for ${date}`)
    return []
  }

  const results = []
  for (const doc of snap.docs) {
    const { orgId } = doc.data()
    try {
      const result = await buildAndPin(orgId, date)
      results.push({ ...result, error: null })
    } catch (err) {
      console.error(`merkler: error processing org ${orgId}: ${err.message}`)
      results.push({ orgId, date, error: err.message })
    }
  }

  console.log(`merkler: nightly run complete — processed ${results.length} orgs`)
  return results
}

/**
 * Bolt Idea — bypass hopper, pin immediately at 1.5× fastestFee.
 *
 * @param {string} orgId
 * @param {string} hash
 * @param {string} ideaId
 * @returns {Promise<{ boltId, orgId, hash, btcTx, btcStatus, pinnedAt }>}
 */
async function boltPin (orgId, hash, ideaId) {
  if (!db) throw new Error('Firestore not configured')

  console.log(`merkler: bolt pin for org ${orgId}, idea ${ideaId}`)

  const btcTx = await glue(orgId, hash, BOLT_FEE_MULTIPLIER)
  const pinnedAt = new Date()

  const boltRef = await db.collection('bolts').add({
    orgId,
    ideaId: ideaId || '',
    hash,
    btcTx,
    btcStatus: 'submitted',
    feeMultiplier: BOLT_FEE_MULTIPLIER,
    pinnedAt
  })

  console.log(`merkler: bolt pinned — boltId=${boltRef.id}, btcTx=${btcTx}`)

  return {
    boltId: boltRef.id,
    orgId,
    hash,
    btcTx,
    btcStatus: 'submitted',
    feeMultiplier: BOLT_FEE_MULTIPLIER,
    pinnedAt: pinnedAt.toISOString()
  }
}

/**
 * Get an org's current daily hopper (for admin view).
 *
 * @param {string} orgId
 * @param {string} [date]  Defaults to today
 * @returns {Promise<object>}
 */
async function getHopper (orgId, date) {
  if (!db) throw new Error('Firestore not configured')

  const d = date || todayUTC()
  const key = hopperKey(orgId, d)
  const snap = await db.collection('hoppers').doc(key).get()

  if (!snap.exists) {
    return { orgId, date: d, hashes: [], ideaIds: [], btcStatus: 'empty', merkedAt: null }
  }

  return snap.data()
}

/**
 * Get stored Merkle tree for an org on a date.
 *
 * @param {string} orgId
 * @param {string} date   YYYY-MM-DD
 * @returns {Promise<object>}
 */
async function getTree (orgId, date) {
  if (!db) throw new Error('Firestore not configured')

  const key = hopperKey(orgId, date)
  const snap = await db.collection('hoppers').doc(key).get()

  if (!snap.exists) throw new Error(`No tree found for org ${orgId} on ${date}`)
  if (!snap.data().root) throw new Error(`Tree not yet built for org ${orgId} on ${date}`)

  return snap.data()
}

/**
 * Get all bolts for an org (sorted newest first).
 *
 * @param {string} orgId
 * @returns {Promise<Array>}
 */
async function getBolts (orgId) {
  if (!db) throw new Error('Firestore not configured')

  const snap = await db.collection('bolts')
    .where('orgId', '==', orgId)
    .orderBy('pinnedAt', 'desc')
    .limit(100)
    .get()

  return snap.docs.map(d => ({ boltId: d.id, ...d.data() }))
}

/**
 * Promote a pending hopper hash to a Bolt (immediate pin, removed from hopper).
 *
 * @param {string} orgId
 * @param {string} hash
 * @param {string} ideaId
 * @returns {Promise<object>}  Bolt result
 */
async function promoteHashToBolt (orgId, hash, ideaId) {
  if (!db) throw new Error('Firestore not configured')

  const date = todayUTC()
  const key = hopperKey(orgId, date)
  const ref = db.collection('hoppers').doc(key)

  // Remove from hopper
  const snap = await ref.get()
  if (snap.exists) {
    const data = snap.data()
    const idx = data.hashes.indexOf(hash)
    if (idx > -1) {
      const hashes = [...data.hashes]
      const ideaIds = [...(data.ideaIds || [])]
      hashes.splice(idx, 1)
      ideaIds.splice(idx, 1)
      await ref.update({ hashes, ideaIds })
    }
  }

  // Immediately pin as Bolt
  return boltPin(orgId, hash, ideaId)
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  addToHopper,
  buildAndPin,
  buildAndPinAll,
  boltPin,
  getHopper,
  getTree,
  getBolts,
  promoteHashToBolt,
  todayUTC
}
