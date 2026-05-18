'use strict'
/**
 * merkler unit tests — no Firestore, no timeglue required.
 *
 * Tests the Merkle tree logic directly:
 *   - Building trees of various sizes
 *   - Root determinism (same leaves → same root)
 *   - Leaf provability (getProof / verify)
 */

const { MerkleTree } = require('merkletreejs')
const SHA256 = require('crypto-js/sha256')

let passed = 0
let failed = 0

function sha256hex (value) {
  return SHA256(value).toString()
}

function assert (condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${label}`)
    failed++
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

// Simulated idea hashes (normally SHA-256 of idea file content)
const IDEA_HASHES = [
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
  'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
  'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6'
]

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nmerkler: tree construction tests')

// 1. Single leaf
;(function testSingleLeaf () {
  const leaves = [IDEA_HASHES[0]].map(h => sha256hex(h))
  const tree = new MerkleTree(leaves, sha256hex, { sortPairs: true })
  const root = tree.getRoot().toString('hex')
  assert(root.length === 64, 'single leaf: root is 64-char hex')
  assert(root !== '', 'single leaf: root is non-empty')
})()

// 2. Multiple leaves
;(function testMultiLeaf () {
  const leaves = IDEA_HASHES.map(h => sha256hex(h))
  const tree = new MerkleTree(leaves, sha256hex, { sortPairs: true })
  const root = tree.getRoot().toString('hex')
  assert(root.length === 64, 'multi leaf (5): root is 64-char hex')
  assert(root !== '', 'multi leaf (5): root is non-empty')
})()

// 3. Root determinism — same leaves same order → same root
;(function testDeterminism () {
  const leaves1 = IDEA_HASHES.map(h => sha256hex(h))
  const tree1 = new MerkleTree(leaves1, sha256hex, { sortPairs: true })

  const leaves2 = IDEA_HASHES.map(h => sha256hex(h))
  const tree2 = new MerkleTree(leaves2, sha256hex, { sortPairs: true })

  assert(
    tree1.getRoot().toString('hex') === tree2.getRoot().toString('hex'),
    'determinism: same leaves → same root'
  )
})()

// 4. Different leaves → different root
;(function testUniqueness () {
  const leaves1 = IDEA_HASHES.slice(0, 3).map(h => sha256hex(h))
  const leaves2 = IDEA_HASHES.slice(1, 4).map(h => sha256hex(h))
  const tree1 = new MerkleTree(leaves1, sha256hex, { sortPairs: true })
  const tree2 = new MerkleTree(leaves2, sha256hex, { sortPairs: true })
  assert(
    tree1.getRoot().toString('hex') !== tree2.getRoot().toString('hex'),
    'uniqueness: different leaves → different root'
  )
})()

// 5. Proof verification
;(function testProof () {
  const leaves = IDEA_HASHES.map(h => sha256hex(h))
  const tree = new MerkleTree(leaves, sha256hex, { sortPairs: true })
  const root = tree.getRoot()
  const leaf = leaves[2]
  const proof = tree.getProof(leaf)
  const valid = tree.verify(proof, leaf, root)
  assert(valid, 'proof: leaf[2] verifies against root')

  // Wrong leaf should not verify
  const fakeLeaf = sha256hex('not-in-tree')
  const fakeProof = tree.getProof(fakeLeaf)
  const invalid = tree.verify(fakeProof, fakeLeaf, root)
  assert(!invalid, 'proof: non-member leaf does not verify')
})()

// 6. getLayersAsObject returns non-empty object
;(function testLayers () {
  const leaves = IDEA_HASHES.map(h => sha256hex(h))
  const tree = new MerkleTree(leaves, sha256hex, { sortPairs: true })
  const layers = tree.getLayersAsObject()
  assert(typeof layers === 'object' && layers !== null, 'layers: getLayersAsObject returns object')
  const keys = Object.keys(layers)
  assert(keys.length > 0, 'layers: object has keys')
})()

// 7. Two-leaf tree
;(function testTwoLeaves () {
  const leaves = IDEA_HASHES.slice(0, 2).map(h => sha256hex(h))
  const tree = new MerkleTree(leaves, sha256hex, { sortPairs: true })
  const root = tree.getRoot().toString('hex')
  assert(root.length === 64, 'two-leaf tree: root is 64-char hex')
})()

// 8. Large tree (50 leaves)
;(function testLargeTree () {
  const hashes = []
  for (let i = 0; i < 50; i++) {
    hashes.push(sha256hex(`idea-${i}-${Date.now()}`))
  }
  const leaves = hashes.map(h => sha256hex(h))
  const tree = new MerkleTree(leaves, sha256hex, { sortPairs: true })
  const root = tree.getRoot().toString('hex')
  assert(root.length === 64, 'large tree (50 leaves): root is 64-char hex')

  // Verify a random leaf
  const proof = tree.getProof(leaves[25])
  const valid = tree.verify(proof, leaves[25], tree.getRoot())
  assert(valid, 'large tree (50 leaves): leaf[25] proves membership')
})()

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nmerkler tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
