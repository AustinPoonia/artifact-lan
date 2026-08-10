/**
 * Finding peers on the segment, and refusing to say anything else while doing it.
 *
 * Two halves. The frame is pure and every case is a refusal: a beacon is read off
 * a multicast group this process does not own, so foreign traffic is the normal
 * input and has to cost nothing and reveal nothing.
 *
 * The rest is real multicast on the real interface — there is no mock worth
 * having here, since every interesting failure (a socket bound dual-stack, a
 * group never joined, a node that stays ephemeral and is therefore invisible)
 * lives below the JavaScript.
 *
 * Every test here runs on its own group and port. Beaconing on the platform's
 * real group from a test suite would announce this machine to the office and
 * pick up whatever answered.
 *
 * ## What is here and what stayed in `artifact-net`
 *
 * This file was `artifact-net/test/lan.test.js`, and it did not move whole —
 * which is worth stating rather than leaving to be noticed, because "the tests
 * came with the code" is the claim a split is normally judged on. Fifteen of its
 * twenty-three cases were about the frame, the beacon and the rendezvous node,
 * and they are below. The other eight were about `artifact-net`'s `Node` and
 * `Operator` *using* this module — a device joining a network with the DHT taken
 * away, an operator serving one over the segment, `lan: false` opening no socket
 * — and they assert things about corestores, manifests and hyperswarm that this
 * repo has no dependency on and should not acquire. Moving them would have meant
 * `artifact-lan` depending on `artifact-net`, which is the cycle the split
 * exists to avoid.
 *
 * So the division is not a compromise, it is the seam: this suite proves the
 * mechanism, and `artifact-net`'s remaining `test/lan.test.js` proves its two
 * consumers reach for it correctly. Neither half is checking the other's job.
 */
const t = require('bare-tap')
const assert = require('bare-assert')
const { createSocket } = require('bare-dgram')

// See `narrow.js` for why `got` is a function and not a cast.
const { got } = require('./narrow')
const { Lan, Beacon, encode, decode, FRAME, GROUP, PORT } = require('..')

/** @type {[string, () => Promise<void>][]} */
const cases = []
const test = (/** @type {string} */ n, /** @type {any} */ f) => cases.push([n, f])

/** @type {(() => Promise<void>)[]} */ const teardown = []

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))
const NONCE = Buffer.alloc(8, 7)

/**
 * Deep equality by serialisation, and a message that is genuinely optional.
 *
 * A `@param` block rather than an inline `{string=}`, because the inline `@type`
 * form does not carry optionality — `tsc` reads it as a required
 * `string | undefined` and still demands three arguments. `[m]` is the spelling
 * that means what this means.
 *
 * @param {any} a
 * @param {any} b
 * @param {string} [m]
 */
const same = (a, b, m) =>
  assert.equal(JSON.stringify(a), JSON.stringify(b), m ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`)

/**
 * Assert `fn` throws, and that the message says which refusal it was.
 *
 * `instanceof` rather than a cast over `err && err.message`: the cast asserted
 * nothing and then handed the result to `RegExp.test`, which wants a string and
 * would have been given `undefined` for anything thrown that is not an object.
 * An `Error` has a `message` and everything else is rethrown rather than quietly
 * matched against the string `"undefined"`.
 *
 * `assert.ok(false, …)` on the last line rather than `assert.fail`, which
 * `bare-assert` exports and does not declare. Note it sits *outside* the `try`,
 * so an `AssertionError` from here cannot be caught by the `catch` above it.
 *
 * @param {() => any} fn @param {RegExp} re
 */
function throws (fn, re, /** @type {string} */ why) {
  try { fn() } catch (err) {
    if (!(err instanceof Error)) throw err
    return assert.ok(re.test(err.message), `${why}: threw ${JSON.stringify(err.message)}, wanted ${re}`)
  }
  assert.ok(false, `${why}: returned instead of throwing`)
}

/**
 * A group and port nobody else is on. The port is derived from the pid so two
 * suites running side by side do not join each other's segment.
 */
let seq = 0
function isolated () {
  seq++
  return { group: '239.255.65.9' + (seq % 10), socketPort: 27000 + ((Bare.pid ?? 0) % 500) * 8 + seq }
}

/** @param {any} lan */
function track (lan) {
  teardown.push(async () => { await lan.close() })
  return lan
}

/** Wait for a condition, or give up. @param {() => boolean} ok */
async function until (ok, tries = 60) {
  for (let i = 0; i < tries && !ok(); i++) await sleep(250)
  return ok()
}

/* ────────────────────────── the frame, and refusals ─────────────────────── */

test('a beacon is 18 bytes and round-trips', () => {
  const frame = encode(49737, NONCE)
  assert.equal(frame.byteLength, FRAME)
  assert.equal(FRAME, 18)
  const read = got(decode(frame), 'a frame this file just encoded did not decode')
  assert.equal(read.port, 49737)
  assert.equal(read.nonce, NONCE.toString('hex'))
})

test('a beacon carries a port and a nonce and nothing else', () => {
  // The isolation argument is that nothing network-derived is on the wire, and
  // a fixed frame is how that stays true: a future field cannot be slipped in
  // without this failing.
  const read = got(decode(encode(1, NONCE)), 'a frame this file just encoded did not decode')
  same(Object.keys(read).sort(), ['nonce', 'port'], 'a beacon grew a field')

  const frame = encode(0x1234, NONCE)
  assert.equal(frame.toString('ascii', 0, 6), 'ARTLAN')
  assert.equal(frame[6], 1, 'version')
  assert.equal(frame[7], 0, 'reserved')
  assert.equal(frame.readUInt16BE(8), 0x1234)
  assert.equal(frame.toString('hex', 10), NONCE.toString('hex'))
})

test('a frame of the wrong length is refused', () => {
  const frame = encode(49737, NONCE)
  // `bare-buffer`'s `index.d.ts` declares `Buffer extends Uint8Array` and does
  // not override `subarray`, so the checker types this as a `Uint8Array` where
  // Node's own Buffer types would say `Buffer`. It is a `Buffer` — verified,
  // `Buffer.isBuffer(Buffer.alloc(18).subarray(0, 17))` is `true` on the
  // installed version — so the cast is to the type the value already has, and it
  // is the narrowest available rather than `any`.
  assert.strictEqual(decode(/** @type {Buffer} */ (frame.subarray(0, 17))), null)
  assert.strictEqual(decode(Buffer.concat([frame, Buffer.alloc(1)])), null)
  assert.strictEqual(decode(Buffer.alloc(0)), null)
  // @ts-expect-error `decode` is declared `(frame: Buffer)` and is handed a
  // non-Buffer on purpose. That is this line's entire content: the guard reads
  // `if (!frame || frame.byteLength !== FRAME)`, and the claim being pinned is
  // that a caller who has nothing gets `null` rather than a throw — a beacon
  // reads packets off a multicast group it does not own, so the refusal has to be
  // total. Widening `lib/lan.js` to `{Buffer | null}` would make the checker
  // agree by making the signature describe a caller that does not exist; the real
  // one is a dgram `message` handler and always has a Buffer.
  assert.strictEqual(decode(null), null)
})

test('a frame with somebody else"s magic is refused', () => {
  const frame = encode(49737, NONCE)
  frame.write('ARTLAM', 0, 'ascii')
  assert.strictEqual(decode(frame), null)
})

test('a frame from a future version is refused rather than guessed at', () => {
  const frame = encode(49737, NONCE)
  frame[6] = 2
  assert.strictEqual(decode(frame), null)
})

test('port zero is refused, in both directions', () => {
  const frame = encode(49737, NONCE)
  frame.writeUInt16BE(0, 8)
  assert.strictEqual(decode(frame), null)

  throws(() => encode(0, NONCE), /udp port/, 'port 0')
  throws(() => encode(65536, NONCE), /udp port/, 'port 65536')
  throws(() => encode(1.5, NONCE), /udp port/, 'a fractional port')
})

test('a nonce that is not 8 bytes is refused', () => {
  throws(() => encode(49737, Buffer.alloc(7)), /8 bytes/, 'a short nonce')
  throws(() => encode(49737, Buffer.alloc(9)), /8 bytes/, 'a long nonce')
})

test('the real group is administratively scoped, and is not mDNS', () => {
  // 239.0.0.0/8 is RFC 2365 admin scope; 224.0.0.251:5353 is somebody else's.
  assert.ok(GROUP.startsWith('239.255.'), `${GROUP} is not in the IPv4 local scope`)
  assert.notEqual(PORT, 5353)
  assert.notEqual(PORT, 49737, 'the beacon port must not be HyperDHT"s default')
})

/* ───────────────────────────── real multicast ───────────────────────────── */

test('two beacons on a segment find each other, and not themselves', async () => {
  const where = isolated()
  const a = await Beacon.open({ ...where, port: 40001 })
  const b = await Beacon.open({ ...where, port: 40002 })
  teardown.push(async () => { await a.close(); await b.close() })

  assert.ok(await until(() => a.peers.size > 0 && b.peers.size > 0), 'no beacon arrived')

  same(a.nodes().map((/** @type {any} */ n) => n.port), [40002], 'A should see only B')
  same(b.nodes().map((/** @type {any} */ n) => n.port), [40001], 'B should see only A')
  assert.equal(a.peers.size, 1, 'a beacon must discard its own multicast echo')
})

test('junk on the group is ignored rather than parsed', async () => {
  const where = isolated()
  const a = await Beacon.open({ ...where, port: 40003 })
  teardown.push(async () => { await a.close() })

  const noise = createSocket({ reuseAddress: true })
  await new Promise((resolve) => noise.bind(0, '0.0.0.0', () => resolve(undefined)))

  const wrongMagic = encode(40004, Buffer.alloc(8, 3))
  wrongMagic.write('NOTUS!', 0, 'ascii')
  for (const bad of [Buffer.from('hello'), Buffer.alloc(18), wrongMagic, Buffer.alloc(64, 0xff)]) {
    await noise.send(bad, 0, bad.byteLength, where.socketPort, where.group)
  }
  await sleep(1200)
  await noise.close()

  assert.equal(a.peers.size, 0, `nothing on that group was ours, got ${JSON.stringify(a.nodes())}`)
})

test('a peer that beacons a good frame is picked up from the same socket', async () => {
  const where = isolated()
  const a = await Beacon.open({ ...where, port: 40005 })
  teardown.push(async () => { await a.close() })

  const other = createSocket({ reuseAddress: true })
  await new Promise((resolve) => other.bind(0, '0.0.0.0', () => resolve(undefined)))
  const frame = encode(40006, Buffer.alloc(8, 9))
  await other.send(frame, 0, frame.byteLength, where.socketPort, where.group)
  await until(() => a.peers.size > 0)
  await other.close()

  same(a.nodes().map((/** @type {any} */ n) => n.port), [40006], 'the well-formed one should be the only one through')
})

/* ─────────────────────── the rendezvous nodes and the DHT ───────────────── */

/** @type {any} */ let lanA
/** @type {any} */ let lanB

test('two devices discover each other"s rendezvous node', async () => {
  const where = isolated()
  lanA = track(await Lan.open(where))
  lanB = track(await Lan.open(where))

  assert.ok(await until(() => lanA.beacon.peers.size > 0 && lanB.beacon.peers.size > 0),
    'the beacons never met')

  const seen = lanA.beacon.nodes()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].port, lanB.port, 'the port on the wire is the rendezvous node"s')
})

test('a rendezvous node that came up alone still becomes persistent', async () => {
  // Not a nicety. `ephemeral: false` turns dht-rpc's adaptive retry off, so a
  // node with an empty bootstrap list would stay ephemeral forever, answer with
  // a null id, and never be added to any routing table — the first device on a
  // segment would be permanently unreachable.
  await lanA.discover(2000)
  await lanB.discover(2000)
  assert.equal(lanA.dht.ephemeral, false, 'A never went persistent')
  assert.equal(lanB.dht.ephemeral, false, 'B never went persistent')
})

test('the node list never mixes loopback with segment addresses', async () => {
  // One inconsistent entry and the NAT sampler agrees on nothing, `dht.host`
  // stays null, and the swarm announces an address no peer can reach.
  for (const lan of [lanA, lanB]) {
    const hosts = new Set(lan.nodes().map((/** @type {any} */ n) => n.host))
    assert.ok(!hosts.has('127.0.0.1'), `${JSON.stringify([...hosts])} contains loopback`)
    assert.equal(hosts.size, 1, `${JSON.stringify([...hosts])} is more than one address`)
  }
})

test('a device offers its own rendezvous node as well as the ones it heard', () => {
  const nodes = lanA.nodes()
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].port, lanA.port, 'ours comes first')
  assert.equal(nodes[1].port, lanB.port)
})

/* ─────────────────────────────── run them ───────────────────────────────── */

async function main () {
  t.plan(cases.length)
  for (const [name, fn] of cases) {
    try { await fn(); t.pass(name) } catch (err) { t.fail(`${name} — ${err instanceof Error ? err.message : err}`) }
  }
  for (const done of teardown.reverse()) { try { await done() } catch { /* best effort */ } }
}

main()
