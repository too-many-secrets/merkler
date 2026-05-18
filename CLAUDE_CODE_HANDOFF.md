# Claude Code Handoff — merkler Integration

You are integrating **merkler** into the Ideablock webapp. merkler is a Node.js microservice that batches idea hashes into per-org Merkle trees and pins roots to Bitcoin once per day. This doc covers the backend wiring and frontend views you need to build.

---

## Repos & Paths

- merkler service: https://github.com/ideablock/merkler (this repo)
- Ideablock backend: `/Users/elisheets/Projects/ideablock/backend-source`
- Ideablock frontend: `/Users/elisheets/Projects/ideablock/frontend-source`
- timeglue: https://github.com/too-many-secrets/timeglue

---

## How merkler works (do not change this)

1. When a user saves an idea on Ideablock, the backend calls `POST /api/hopper` on merkler with the idea hash and org ID.
2. At 11:30 PM EST nightly, merkler builds a binary Merkle tree from each org's collected hashes, then calls timeglue `POST /glue` with the root hash → gets back a `btcTx`.
3. The full tree (root + layers) is stored in Firestore for provability.
4. **Bolt Ideas** bypass the nightly hopper and pin immediately at 1.5× `fastestFee` — for this, the backend calls `POST /api/bolt` on merkler.

### merkler API summary

All endpoints require `X-Merkler-Key: <MERKLER_SERVICE_KEY>` (internal service auth).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/hopper` | Add hash to org's daily hopper |
| `GET` | `/api/hopper/:orgId` | Admin: list today's pending hashes |
| `POST` | `/api/bolt` | Bolt — immediate pin at 1.5× fee |
| `POST` | `/api/bolt/promote` | Promote hopper hash to Bolt |
| `GET` | `/api/bolts/:orgId` | List all bolts for an org |
| `POST` | `/api/merk` | Manual cron trigger (also runs nightly) |
| `GET` | `/api/tree/:orgId/:date` | Get stored Merkle tree |
| `GET` | `/health` | Health check |

### merkler environment variables (needed in backend)

```
MERKLER_URL=http://localhost:4000          # merkler base URL
MERKLER_SERVICE_KEY=<shared-secret>        # same key set in merkler's .env
```

---

## Task 1 — Backend: wire merkler into the idea save flow

### 1a. Add a `MerkleRecord` model

```go
type MerkleRecord struct {
    ID        string    `json:"id"`
    OrgID     string    `json:"orgID"`
    IdeaID    string    `json:"ideaID"`
    Hash      string    `json:"hash"`      // SHA-256 of the idea file
    HopperKey string    `json:"hopperKey"` // "{orgId}_{date}" — links to Merkle tree
    IsBolt    bool      `json:"isBolt"`
    BoltID    string    `json:"boltID,omitempty"`
    BtcTx     string    `json:"btcTx,omitempty"`
    BtcStatus string    `json:"btcStatus"` // "pending"|"submitted"|"baking"|"confirmed"
    CreatedAt time.Time `json:"createdAt"`
}
```

### 1b. On idea save — send hash to merkler hopper

After the idea is saved to your DB (in the existing idea-creation handler), call merkler:

```go
func syncToMerkler(orgID, ideaID, hash string) error {
    body := map[string]string{
        "orgId":  orgID,
        "hash":   hash,
        "ideaId": ideaID,
    }
    b, _ := json.Marshal(body)
    req, _ := http.NewRequest("POST", os.Getenv("MERKLER_URL")+"/api/hopper", bytes.NewReader(b))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("X-Merkler-Key", os.Getenv("MERKLER_SERVICE_KEY"))
    resp, err := http.DefaultClient.Do(req)
    if err != nil || resp.StatusCode != 200 {
        // best-effort — log and continue, do not block idea save
        log.Printf("merkler sync failed for idea %s: %v", ideaID, err)
    }
    return nil
}
```

Do this as a best-effort goroutine — never block the idea save on merkler availability.

### 1c. Bolt Idea endpoint

Add `POST /api/ideas/:id/bolt` to the backend. This endpoint:

1. Checks that the requesting user's org has a **payment method on file** (credit card). If not, return `402 Payment Required` with a message to add a card.
2. Looks up the idea's hash.
3. Calls merkler `POST /api/bolt` with `{orgId, hash, ideaId}`.
4. Stores the returned `{boltId, btcTx}` on the idea record.
5. Returns the bolt result to the client.

```go
// POST /api/ideas/:id/bolt
// Requires: authenticated user with payment method on file
func BoltIdea(c *gin.Context) {
    ideaID := c.Param("id")
    userID := auth.GetUserIDFromRequest(c.Request)
    // 1. verify payment method...
    // 2. fetch idea, get hash...
    // 3. call merkler /api/bolt...
    // 4. store btcTx on idea...
}
```

**Pricing note:** Bolt Ideas cost extra (1.5× standard fee). You will need to add a billing record or charge the card at this step. The exact billing flow is out of scope for this handoff — placeholder a `TODO: charge org` comment.

### 1d. Admin hopper endpoint

Add `GET /api/admin/merkle/hopper/:orgId` on the backend that proxies to merkler's `GET /api/hopper/:orgId`. Restrict to admin role using the existing admin middleware.

---

## Task 2 — Frontend: Merkle / Bitcoin section

Use the existing ideas list/detail component patterns and add a **Merkle** or **Bitcoin** section.

### 2a. Per-idea status badge

On each idea card and detail view, show whether the idea has been Merkle-stamped:

| State | Badge |
|---|---|
| `pending` | "In hopper" (gray) — will be included in tonight's tree |
| `submitted` | "Stamped" (blue) — tx broadcast, awaiting confirmation |
| `baking` | "Confirming…" (yellow) — N/6 confirmations |
| `confirmed` | "On-chain ✓" (green) — permanently on Bitcoin |

Poll `GET /api/commit-ideas/:id/status` every 60 seconds while status is `submitted` or `baking`.

### 2b. Bolt Idea button

On each idea detail view, show a **"Bolt to Bitcoin"** button if the idea is still `pending` (in the hopper, not yet pinned).

- If the org has no card on file: clicking shows a modal prompting them to add payment.
- If card is on file: show a confirmation modal:
  > "Bolt this idea to Bitcoin immediately? This pins your idea to the next block at priority fee (approx. $X). Standard stamping is free and happens nightly."
  - On confirm: call `POST /api/ideas/:id/bolt`, update the badge to `submitted`.

The exact fee amount can be fetched from timeglue `GET /fee` (display `fastestFee × 1.5 × 137 sat/vB` converted to USD using a current BTC price).

### 2c. Org Merkle tree view

Add a **"Merkle Tree"** tab or section in the org dashboard.

**List view:** one row per day the org has had ideas stamped:

| Date | # Ideas | Root Hash | Bitcoin Tx | Status |
|---|---|---|---|---|
| 2026-05-18 | 12 | `d8ef0c6a...` | `a9369cd8...` → mempool.space | confirmed |
| 2026-05-17 | 7 | `fa0cac...` | `b1234...` | confirmed |

**Tree detail view:** when user clicks a day row, show:
- The full Merkle tree (visual or expandable JSON of `layers`)
- Each leaf linked back to the corresponding idea
- Bitcoin transaction link: `https://mempool.space/tx/{btcTx}`
- Proof section: for any selected leaf, show the Merkle proof path

The `layers` field from `GET /api/tree/:orgId/:date` is a nested object from merkletreejs's `getLayersAsObject()` — you can render it as an indented tree using the same pattern as the existing file-tree components if any, or a simple recursive component.

### 2d. Admin Hopper view (org owner / admin only)

A page showing today's pending hopper for the org:

- List of ideas currently in the hopper, with hash and idea title
- For each: a **"Bolt this"** action button (same bolt flow as 2b)
- Countdown timer to 11:30 PM EST showing when the nightly tree will run

Route: `/admin/merkle/hopper` (admin-only).

---

## Task 3 — Backend: track Merkle tree status per org

### 3a. GET /api/org/merkle

Return a list of Merkle records for the requesting user's org:

```json
[
  {
    "date": "2026-05-18",
    "leafCount": 12,
    "root": "d8ef0c6a...",
    "btcTx": "a9369cd8...",
    "btcStatus": "confirmed",
    "merkedAt": "2026-05-18T04:30:12Z"
  }
]
```

This is a proxy to merkler `GET /api/tree/:orgId/:date` — you may want to store a summary in your own DB so this endpoint is fast without calling merkler each time.

### 3b. GET /api/org/merkle/:date

Return the full tree for a specific date. Proxies to merkler `GET /api/tree/:orgId/:date`.

---

## Testing order

1. Start merkler: `npm install && node app.js` (from `/Users/elisheets/Desktop/Code/merkler`)
2. Start timeglue in mock mode: `MOCK_MODE=true ./timeglue` (from `/Users/elisheets/Desktop/Code/timeglue`)
3. Call `POST /api/hopper` a few times with different hashes for the same `orgId`
4. Call `GET /api/hopper/:orgId` — verify hashes appear
5. Call `POST /api/merk` — verify tree is built and `btcTx` is returned
6. Call `GET /api/tree/:orgId/:date` — verify `root`, `layers`, `btcTx` are populated
7. Call `POST /api/bolt` — verify immediate pinning with 1.5× fee marker
8. Wire backend `POST /api/ideas/:id/bolt` and verify full flow from frontend

---

## Key invariants

- **Per-org isolation**: never mix hashes from different orgs in the same tree.
- **Idempotent merk**: if `buildAndPin` is called twice for the same org/date, the second call is a no-op (returns the existing tx).
- **Bolt is independent**: bolt-pinned ideas do NOT go into the nightly hopper — they have their own `btcTx` directly.
- **Best-effort hopper sync**: the backend should never fail an idea save because merkler is down. Always fire-and-forget.
