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
 * Eight of the seventeen cases need this host to hand a multicast datagram back
 * to itself, and one host in CI does not. They are gated on a probe that asks
 * exactly that and says `# NOT MEASURED [multicast]:` per case when the answer is
 * no — see `probeMulticast` below for why that is a capability probe and not
 * `if (CI)` wearing one's clothes.
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

/* ────────────────── can this host carry a multicast datagram? ───────────── */

/**
 * Whether a frame sent to a group on this host reaches a socket on this host.
 *
 * Everything below the frame section needs one thing this repository does not
 * control: the kernel has to hand a datagram sent to a `239.x` group back to the
 * sockets on this same machine that joined it. A developer Mac does, and
 * `ubuntu-latest` does. A `macos-latest` GitHub runner does not — nine
 * assertions across this suite and `artifact-net`'s fail there, and they are one
 * fact reported nine ways. That leg exists to build a FAT volume, which it does;
 * a job that can never go green is a job people learn to skip past, and the
 * measurement goes with it.
 *
 * ## Why this asks the host and never asks `CI`
 *
 * Keying on `CI`, `GITHUB_ACTIONS` or `os.platform() === 'darwin'` would be a
 * skip wearing a capability probe's clothes, and the bill is specific rather
 * than theoretical: these cases pass on a developer Mac *today* and catch real
 * regressions there, so a platform test would delete the measurement from the
 * only machine currently making it — while reading, in the diff, exactly like
 * this does. What is asked here is the thing itself. A runner that gains
 * multicast starts measuring again with no edit here, and a developer Mac that
 * loses it says so on the same run.
 *
 * ## Why it is raw sockets and shares nothing with `lib/lan.js`
 *
 * "Two beacons find each other" **is** the first gated case, so a probe built on
 * `Beacon` would make that case unfailable: a regression in joining, encoding or
 * decoding would turn the case green by turning the probe red, which is the
 * instrument-reports-success shape this project keeps paying for. So this speaks
 * to `bare-dgram` directly, duplicates the join loop rather than importing it,
 * and puts a payload on the wire that is not a beacon frame. A broken `Beacon` is
 * a red.
 *
 * ## The three traps, each of which has already been walked into here
 *
 * **`bare-dgram` has no Node-style `socket.addMembership`.** It lives on
 * `socket._socket`, the udx socket underneath, and calling the Node spelling
 * throws `addMembership is not a function` — which a `try`/`catch` reports as
 * "this host has no multicast", a wrong answer indistinguishable from the right
 * one. So the method is checked for existence *before* any join, and its absence
 * is `capable: true`: a defect in this file, red, never a skip.
 *
 * **`EADDRINUSE` on a second join is health.** Measured on the machine this was
 * written on: `addMembership(group, '')` succeeds, and the explicit join of this
 * host's own `10.0.0.46` then throws `EADDRINUSE`, because the kernel already
 * resolved the default join through `224.0.0.0/4` to that interface. One accepted
 * join is the *normal* result on a single-homed host — counting a refused
 * duplicate as a failure would report every such host as having no multicast.
 *
 * **A dead listener hears nothing, and so does a host with no multicast.** A
 * false "multicast is broken" finding survived two commits in this project this
 * week because nothing separated those two. So the sender puts a unicast frame on
 * `127.0.0.1` to a third socket in the same window: if *that* does not arrive
 * either, nothing here measured multicast and the answer is `capable: true` —
 * red — rather than a skip. The listener's own `_closed`/`_closing` are read
 * first, for the same reason.
 *
 * Two limits in the same breath. This measures **self-delivery on one host** and
 * says nothing about whether a neighbour hears this machine — the fact
 * `lib/lan.js`'s header spends two hosts and `tcpdump` establishing. That is the
 * right scope and not a shortcut: every case gated on it has both ends on this
 * machine. And it cannot tell "the kernel discards multicast" from "something on
 * this host filters it"; both are `capable: false`, and the text reports only
 * what was observed.
 *
 * The three-way answer is `custody.test.js`'s `fatVolume()`, which is where this
 * shape comes from: `carries` runs the cases, `capable: false` is a fact about
 * the machine and prints the marker, and `capable: true` with no `carries` is a
 * machine that could have measured and did not — a defect, and a red.
 */
const PROBE_TRIES = 10
const PROBE_WAIT = 200

/** @param {unknown} err */
const said = (err) => err instanceof Error ? err.message : String(err)

/** @type {Promise<{ carries: boolean, capable: boolean, why: string }> | null} */
let probe = null

/** One probe per process; every gated case is asking the same question. */
function multicast () {
  if (probe === null) probe = probeMulticast()
  return probe
}

/** @returns {Promise<{ carries: boolean, capable: boolean, why: string }>} */
async function probeMulticast () {
  // Through `isolated()` so the probe cannot land on a group or port a case is
  // using, by the same reasoning and the same arithmetic. It runs first, so it
  // takes `seq` 1 and the cases start at 2.
  const where = isolated()

  /** @type {any[]} */ const sockets = []
  /** @param {number} port */
  const bound = async (port) => {
    const socket = createSocket({ reuseAddress: true })
    sockets.push(socket)
    await new Promise((resolve, reject) => {
      const failed = (/** @type {Error} */ err) => reject(err)
      socket.once('error', failed)
      socket.bind(port, '0.0.0.0', () => { socket.off('error', failed); resolve(undefined) })
    })
    // A malformed datagram from something else on the group must not take the
    // process down mid-probe, and there is nothing to do about one.
    socket.on('error', () => {})
    return socket
  }
  /** @param {boolean} carries @param {boolean} capable @param {string} why */
  const done = async (carries, capable, why) => {
    for (const s of sockets) { try { await s.close() } catch { /* best effort */ } }
    return { carries, capable, why }
  }

  /** @type {any} */ let listener
  /** @type {any} */ let sender
  /** @type {any} */ let control
  try {
    listener = await bound(where.socketPort)
  } catch (err) {
    return done(false, true, `this probe could not bind ${where.socketPort}: ${said(err)}. That is this file failing to set itself up and is not a statement about multicast`)
  }
  try {
    // Deliberately the *same* port, with `reuseAddress`, because that is what
    // every gated case does — two beacons on one group port, each expecting the
    // other's frames. A host that will not share the port cannot run them, which
    // is a fact about the host and so `capable: false` rather than a red.
    sender = await bound(where.socketPort)
  } catch (err) {
    return done(false, false, `two sockets cannot share port ${where.socketPort} on this host (${said(err)}), and every case below opens at least two on one port`)
  }
  try {
    control = await bound(0)
  } catch (err) {
    return done(false, true, `this probe could not bind an ephemeral port for the control socket that proves its listener is alive: ${said(err)}`)
  }

  const ul = listener._socket ?? listener
  const us = sender._socket ?? sender
  if (typeof ul.addMembership !== 'function') {
    return done(false, true, '`socket._socket` exposes no `addMembership`, so bare-dgram or udx-native changed shape underneath `lib/lan.js`, which joins through exactly this path. A missing method is a defect in this tree and must never read as a host without multicast')
  }

  /** @type {string[]} */ const ifaces = []
  try {
    for (const n of ul.udx.networkInterfaces()) if (n.family === 4 && !n.internal) ifaces.push(n.host)
  } catch { /* older udx, or a host with no interfaces to enumerate */ }

  /** @type {string[]} */ const refused = []
  let accepted = 0
  for (const [name, udx] of [['listener', ul], ['sender', us]]) {
    let joins = 0
    for (const iface of ['', ...ifaces]) {
      try { udx.addMembership(where.group, iface); joins++ } catch (err) { refused.push(`${name} ${JSON.stringify(iface)}: ${said(err)}`) }
    }
    // One is the healthy number on a single-homed host: the default join takes
    // the interface `224.0.0.0/4` resolves to and every explicit join of that
    // same interface is then a duplicate. Zero is the host refusing outright.
    if (joins === 0) return done(false, false, `the kernel accepted no join of ${where.group} for the ${name} — ${refused.join('; ')}`)
    accepted += joins
  }

  // Not a beacon frame, on purpose: nothing this probe puts on the wire should
  // be decodable by the module it is deciding whether to exercise. The tag is
  // per-process and random so a stray datagram from another suite on the same
  // group cannot be counted as ours.
  const tag = `artifact-lan probe ${Bare.pid ?? 0}.${Math.random().toString(36).slice(2)}`
  const frame = Buffer.from(tag)
  let heard = 0
  let unicast = 0
  listener.on('message', (/** @type {Buffer} */ m) => { if (m.toString() === tag) heard++ })
  control.on('message', (/** @type {Buffer} */ m) => { if (m.toString() === tag) unicast++ })

  const back = control.address().port
  /** @type {string[]} */ const sendErrors = []
  for (let i = 0; i < PROBE_TRIES && heard === 0; i++) {
    // A send that rejects is itself the answer on a host with no multicast route
    // — `ENETUNREACH` for `239.0.0.0/8` is the shape — so it is collected and
    // reported rather than thrown, and the loop keeps going in case it is
    // transient.
    try { await sender.send(frame, 0, frame.byteLength, where.socketPort, where.group) } catch (err) { sendErrors.push(said(err)) }
    try {
      await sender.send(frame, 0, frame.byteLength, back, '127.0.0.1')
    } catch (err) {
      return done(false, true, `this probe could not send a plain unicast datagram to 127.0.0.1:${back} (${said(err)}), so it can measure nothing about multicast either`)
    }
    await sleep(PROBE_WAIT)
  }

  if (heard > 0) return done(true, true, '')

  if (ul._closed || ul._closing) {
    return done(false, true, 'this probe\'s own listener was closed before a frame could reach it, so nothing here measured multicast. A dead listener and a host with no multicast produce the same silence, and this project has already shipped that confusion as a finding')
  }
  if (unicast === 0) {
    return done(false, true, `neither the multicast frame nor a unicast to 127.0.0.1:${back} arrived inside ${PROBE_TRIES * PROBE_WAIT}ms, so this probe measured nothing at all — its own send or receive path is broken, which is a defect here and not a fact about the group${sendErrors.length > 0 ? `. The multicast sends said: ${sendErrors[0]}` : ''}`)
  }

  return done(false, false, `${PROBE_TRIES} frames to ${where.group}:${where.socketPort} from a socket on this host reached no socket on this host, with ${accepted} join(s) accepted${refused.length > 0 ? ` and refused: ${refused.join('; ')}` : ''}${sendErrors.length > 0 ? `; the send said: ${sendErrors[0]}` : ''}. A unicast to 127.0.0.1 in the same window arrived ${unicast} time(s), so the socket, the event loop and the send path are all live and it is multicast this host does not carry`)
}

/**
 * Gate one case on the probe, and say out loud which case did not run.
 *
 * Tagged `[multicast]`, and the tag is not decoration: `all-repos.sh:3130`
 * counts the **bare** `^# NOT MEASURED:` marker, and the only finding that
 * belongs in that count is `ROADMAP.md` §4's FAT volume. `bare-acl/test.js` set
 * the precedent — an untagged marker here would report LAN skips as unmeasured
 * FAT cases. One line per skipped case, so the count in the log is the count of
 * cases.
 *
 * @param {string} name  the case, as it reads in the TAP output
 * @returns {Promise<boolean>} whether to run it
 */
async function carries (name) {
  const m = await multicast()
  if (m.carries) return true
  // A host that *can* carry a datagram and still failed the probe is a defect,
  // never a skip — the same split `fatVolume()` draws, and for the same reason:
  // the alternative is a green suite that measured nothing.
  assert.ok(!m.capable, `this host can be measured for multicast and the probe did not manage it, so "${name}" proved nothing: ${m.why}`)
  console.log(`# NOT MEASURED [multicast]: ${name} — ${m.why}`)
  return false
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
  if (!await carries('two beacons on a segment find each other, and not themselves')) return

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
  // Gated even though it asserts an *absence* and would pass on a host that
  // delivers nothing — which is precisely why. A refusal case on a host with
  // nothing to refuse is the shape `custody.test.js`'s header names: green,
  // and measuring no part of the thing it is named for.
  if (!await carries('junk on the group is ignored rather than parsed')) return

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

test('an accepted join is a real membership, and a join on an interface this host does not have is refused', async () => {
  // The measurement behind `memberships` being named for acceptance rather than
  // for health, and it is the half of the two-host finding that a single machine
  // can hold. `addMembership` returning `ok` is *not* vacuous — it refuses an
  // address no interface holds, and it refuses a second join of a group it already
  // has — so what an `ok` fails to prove is delivery, not existence. If udx ever
  // stops throwing on either of these, `lib/lan.js`'s header is overstating what
  // an `ok` means and this case is where that surfaces.
  const where = isolated()
  const socket = createSocket({ reuseAddress: true })
  await new Promise((resolve) => socket.bind(where.socketPort, '0.0.0.0', () => resolve(undefined)))
  const udx = socket._socket ?? socket

  udx.addMembership(where.group, '')
  // 203.0.113.0/24 is RFC 5737 TEST-NET-3 and is on no host by construction.
  throws(() => udx.addMembership(where.group, '203.0.113.7'), /not available/i,
    'a join on an interface address this host does not hold')
  throws(() => udx.addMembership(where.group, ''), /already in use/i,
    'a second join of a group already joined on the same interface')

  await socket.close()
})

test('a beacon reports which interface it announces on, separately from what it joined', async () => {
  // The one fact a lone host can measure, and the reason it is not a health
  // check: it comes off multicast loopback, so it says nothing about the wire.
  // Driven from a second socket carrying this beacon's own nonce rather than by
  // waiting on the kernel's echo — same delivery path the two cases either side
  // of this one already depend on, and no dependence on this beacon's own send
  // having gone anywhere.
  if (!await carries('a beacon reports which interface it announces on')) return

  const where = isolated()
  const a = await Beacon.open({ ...where, port: 40007 })
  teardown.push(async () => { await a.close() })

  assert.ok(a.memberships.length > 0, 'a beacon that opened joined nothing')
  const local = new Set((a.socket._socket ?? a.socket).udx.networkInterfaces()
    .filter((/** @type {any} */ n) => n.family === 4 && !n.internal)
    .map((/** @type {any} */ n) => n.host))

  for (const iface of a.memberships) {
    assert.ok(iface === '' || local.has(iface),
      `memberships holds ${JSON.stringify(iface)}, which is not an address of this host`)
  }

  const echo = createSocket({ reuseAddress: true })
  await new Promise((resolve) => echo.bind(0, '0.0.0.0', () => resolve(undefined)))
  const frame = encode(40007, a.nonce)
  await echo.send(frame, 0, frame.byteLength, where.socketPort, where.group)
  const heard = await until(() => a.announcing !== null)
  await echo.close()

  assert.ok(heard, 'a beacon never learned the interface it announces on')
  assert.strictEqual(a.peers.size, 0, 'our own frame must never become a peer')
  assert.ok(local.has(/** @type {string} */ (a.announcing)),
    `announcing ${JSON.stringify(a.announcing)}, which is not a non-internal IPv4 address of this host`)
})

test('a peer that beacons a good frame is picked up from the same socket', async () => {
  if (!await carries('a peer that beacons a good frame is picked up from the same socket')) return

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
  if (!await carries('two devices discover each other"s rendezvous node')) return

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
  //
  // Gated on delivery because the two `Lan`s it reads are the ones the case above
  // opened, and there are none of them on a host that never ran it. Opening a
  // pair here instead would make this the only case in the file whose subject is
  // a device that has met nobody, which is a different claim.
  if (!await carries('a rendezvous node that came up alone still becomes persistent')) return

  await lanA.discover(2000)
  await lanB.discover(2000)
  assert.equal(lanA.dht.ephemeral, false, 'A never went persistent')
  assert.equal(lanB.dht.ephemeral, false, 'B never went persistent')
})

test('the node list never mixes loopback with segment addresses', async () => {
  // One inconsistent entry and the NAT sampler agrees on nothing, `dht.host`
  // stays null, and the swarm announces an address no peer can reach.
  if (!await carries('the node list never mixes loopback with segment addresses')) return

  for (const lan of [lanA, lanB]) {
    const hosts = new Set(lan.nodes().map((/** @type {any} */ n) => n.host))
    assert.ok(!hosts.has('127.0.0.1'), `${JSON.stringify([...hosts])} contains loopback`)
    assert.equal(hosts.size, 1, `${JSON.stringify([...hosts])} is more than one address`)
  }
})

// `async` for the gate alone; the body it guards is synchronous.
test('a device offers its own rendezvous node as well as the ones it heard', async () => {
  if (!await carries('a device offers its own rendezvous node as well as the ones it heard')) return

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
