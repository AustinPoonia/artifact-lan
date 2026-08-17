/// <reference path="./vendor-lan.d.ts" />
/**
 * Finding peers on the local segment, without telling the segment who they are.
 *
 * ARCHITECTURE.md §5 says discovery is "DHT via hyperswarm, plus
 * `bare-mdns-discovery` for LAN … both feed one peer set". Two things in that
 * sentence turned out to be wrong once the module was actually read, and this
 * file is what is true instead.
 *
 * ## `bare-mdns-discovery` browses; it cannot be browsed
 *
 * The module is real, it is Holepunch's, and it is on the Bare module list. It
 * is also **query-only**: `buildQuery` is the whole encoder, and `parseRecords`
 * discards any packet without the response bit (`flags & 0x8000`). There is no
 * responder, no SRV/TXT to publish, no way to answer a PTR. Two platform nodes
 * on one segment would both ask and neither would ever reply.
 *
 * Its socket setup does not survive contact either: `_open` binds 5353 with no
 * address, so udx gives it a dual-stack `::` socket, and
 * `addMembership('224.0.0.251')` then fails with `invalid argument`. On macOS it
 * still appears to work, because mDNSResponder holds the group membership and
 * SO_REUSEPORT hands copies to every socket on the port. On a host with no
 * system responder it receives nothing. Binding `0.0.0.0` explicitly fixes it —
 * both facts are worth reporting upstream.
 *
 * So the closest real option is the module underneath it, `bare-dgram`, which is
 * also on the Bare list. What is *not* done here is a multicast DNS
 * implementation: this speaks no DNS at all.
 *
 * ## Not speaking DNS-SD is a feature, not a shortcut
 *
 * Publishing `_artifact._tcp.local` would put this device in the Bonjour cache
 * of every Mac and Windows box on the segment, enumerable by anyone running
 * `dns-sd -B`, with a service name and a TXT record attached. For a platform
 * whose isolation claim is about *linkability*, that is the wrong wire. An
 * 18-byte frame on its own group is seen only by something already looking for
 * it.
 *
 * ## What is on the wire, and what deliberately is not
 *
 * One frame, 18 bytes: a magic, a version, a UDP port, and a random per-process
 * nonce used for nothing but discarding our own multicast echo.
 *
 * Not on the wire: the network key, the topic, the device key, the number of
 * realms this device holds, the hostname, the platform version. A beacon says
 * "an artifact-platform node is at this address" and nothing that could be
 * matched against a network.
 *
 * That is the whole isolation argument, and it is why this is safe where the
 * obvious version is not. `keys.topic(networkKey)` broadcast on the segment
 * would be *worse* than the DHT: on the DHT you have to go and look, and which
 * nodes see you is decided by a hash; on multicast the announcement is pushed
 * into every device on the wire, including devices in no network at all. A
 * device beaconing three topics would be visibly a device in three networks —
 * exactly the fact `lib/node.js`'s header gives every realm its own root store
 * to hide. So the beacon is per *device* and carries no network-derived bytes,
 * and that property is what makes the count invisible.
 *
 * The residue, named rather than hidden: the segment learns this machine runs
 * the platform, and learns one UDP port. Both are already visible to anything
 * watching the wire or scanning the /24, and neither is derived from a network
 * key. What the segment gets is a host, never a membership — which is the whole
 * distance between this and the topic broadcast above.
 *
 * ## On by default, and the opt-out
 *
 * The beacon is on by default when no bootstrap is named, and off by default
 * when one is. A named bootstrap is the caller saying where the DHT is and that
 * it answers, and a DHT that answers does not need the segment asked. Saying
 * nothing gets the public one, which is precisely what a perimeter blocks;
 * naming an empty list says there is no DHT at all. In both of those the segment
 * is the only thing left to ask.
 *
 * Defaulting on is a trade made on purpose, not an oversight. The enterprise
 * case is why the feature exists: a site with the DHT firewalled, where a device
 * that finds a network nobody is serving on the segment is half a feature.
 * Requiring `lan: true` there would leave the platform working only for the
 * administrator who already knew to ask, on the one network that needed it most.
 * So the residue above is paid unconditionally, by every node that comes up
 * without a bootstrap, and it is the segment that cannot afford it which has to
 * say so.
 *
 * Saying so is `lan: false`, taken by `Node` and by `Operator` alike, and a
 * hostile segment — a café rather than an office — is what it is for. Announcing
 * a host to colleagues and announcing it to a room of strangers are the same
 * frame and not the same disclosure, and nothing on the wire can tell the two
 * apart.
 *
 * ## Why a port, and not a peer
 *
 * The tempting design is to broadcast something hyperswarm can dedupe on and
 * hand it to `swarm.joinPeer`. That needs the peer's noise public key, which is
 * per-realm and therefore per-network — the leak above, wearing a hat. It also
 * bypasses topic membership entirely: every device on the segment would connect
 * to every other regardless of which networks they share.
 *
 * What is broadcast instead is the port of a **rendezvous DHT node**: an
 * ordinary, persistent, non-firewalled `HyperDHT` node with no bootstrap, which
 * holds no topics and announces nothing. Devices add each other's rendezvous
 * nodes and a DHT forms over the segment with no bootstrap server — which is the
 * point, because "run a private bootstrap" is the current answer and a bootstrap
 * node is a server.
 *
 * **Both halves then feed one peer set by construction**, and that is the real
 * reason to do it this way. LAN discovery does not produce peers at all; it
 * produces *routing*. A realm still finds its peers exactly one way — the
 * `swarm.join(topic)` it already did — over a DHT that now has nodes on it.
 * There is no second peer source to reconcile, and hyperswarm's dedupe by remote
 * public key is untouched: a peer reachable both ways is found once, because it
 * was only ever looked up once.
 *
 * Two further residues, since a DHT is not free of them. A LAN DHT is small, so
 * every node on it stores announce records for every topic — a device on the
 * segment can see that *some* peer announced *some* topic hash, cannot invert
 * the hash to a network key, and cannot join without it, but can count distinct
 * topics against one IP. That is the realm count arriving by another road, and
 * it is a property of any small DHT including the private bootstrap this
 * replaces. And where the public DHT is *also* reachable, RFC1918 addresses of
 * LAN nodes can propagate into public routing tables; they are unroutable from
 * outside, and the fact disclosed is that an internal host runs a node.
 */
const HyperDHT = require('hyperdht')
// `hypercore-crypto` rather than `bare-crypto`, and the reason is packaging
// rather than cryptography — both are `randombytes_buf` underneath and this uses
// eight bytes of it for a beacon nonce.
//
// `bare-crypto` was the only addon-bearing package in the whole platform graph
// that sat *nested* — under `artifact-net/node_modules/artifact-lan/` — rather
// than hoisted, and it ships no prebuild. A compiled release names an addon to
// the host by plain package specifier (`artifact-platform/lib/packer.js`
// `#hostAddons` has the measurements), and a nested name does not resolve from
// the host's root: measured, `require.addon('bare-crypto')` throws
// `ADDON_NOT_FOUND` where `require.addon('bare-realm')` loads. It was the last
// thing standing between a signed release and booting at all.
//
// `hypercore-crypto` is already in this package's closure through `hyperdht`,
// and `sodium-native` beneath it is hoisted and prebuilt like every other addon
// here. So this removes a dependency rather than adding one.
const { randomBytes } = require('hypercore-crypto')
const { createSocket } = require('bare-dgram')

/**
 * RFC 2365 IPv4 Local Scope. Combined with the default `IP_MULTICAST_TTL` of 1,
 * a beacon does not leave the segment even if a router would otherwise forward
 * an administratively scoped group. The octets and the port are arbitrary — all
 * they have to do is agree across the platform, and not collide with mDNS
 * (5353) or HyperDHT's own default (49737).
 */
const GROUP = '239.255.65.82'
const PORT = 26082

const MAGIC = 'ARTLAN'
const VERSION = 1
const FRAME = 18

/** How long a peer stays in the set after its last beacon. */
const FORGET = 5 * 60 * 1000

/** How long `discover` waits for the segment to answer before giving up on it. */
const DISCOVER = 5000

/**
 * A beacon frame. Fixed length on purpose: a stray packet on a port we do not
 * own is refused by its size before anything reads a field out of it.
 *
 * @param {number} port    the UDP port to advertise
 * @param {Buffer} nonce   8 bytes, per process
 * @returns {Buffer}
 */
function encode (port, nonce) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`a beacon advertises a udp port, not ${port}`)
  }
  if (nonce.byteLength !== 8) throw new Error('a beacon nonce is 8 bytes')

  const frame = Buffer.alloc(FRAME)
  frame.write(MAGIC, 0, 'ascii')
  frame[6] = VERSION
  frame[7] = 0
  frame.writeUInt16BE(port, 8)
  nonce.copy(frame, 10)
  return frame
}

/**
 * `null` for anything that is not ours, rather than a throw: this reads packets
 * off a multicast group we do not own, so a foreign sender is the normal case
 * and must cost nothing.
 *
 * @param {Buffer} frame
 * @returns {{ port: number, nonce: string } | null}
 */
function decode (frame) {
  if (!frame || frame.byteLength !== FRAME) return null
  if (frame.toString('ascii', 0, 6) !== MAGIC) return null
  if (frame[6] !== VERSION) return null

  const port = frame.readUInt16BE(8)
  if (port < 1) return null

  return { port, nonce: frame.toString('hex', 10, 18) }
}

/**
 * The multicast half: shout one port, collect the ports other people shout.
 *
 * Deliberately knows nothing about the DHT, or about networks. It is a set of
 * `host:port` pairs and the socket that fills it.
 */
class Beacon {
  /**
   * @param {object} parts
   * @param {any} parts.socket
   * @param {number} parts.port      the port this device advertises
   * @param {Buffer} parts.nonce
   * @param {string} parts.group
   * @param {number} parts.socketPort
   * @param {(peer: { host: string, port: number }) => void} [parts.onpeer]
   */
  constructor ({ socket, port, nonce, group, socketPort, onpeer }) {
    this.socket = socket
    this.port = port
    this.nonce = nonce
    this.group = group
    this.socketPort = socketPort
    this.onpeer = onpeer ?? null
    this.closed = false

    /** @type {Map<string, { host: string, port: number, at: number }>} */
    this.peers = new Map()

    // A device that has just been switched on wants to be found now; a device
    // that has been up for an hour is only covering for packet loss. Ramping
    // the interval gets both without a second timer.
    this._delay = 1000
    this._timer = null
    this._frame = encode(port, nonce)

    socket.on('message', (/** @type {Buffer} */ msg, /** @type {any} */ rinfo) => {
      this._onmessage(msg, rinfo)
    })
    // A malformed datagram from something else on the group must not take the
    // process down, and there is nothing useful to do about it.
    socket.on('error', () => {})
  }

  /**
   * @param {object} [opts]
   * @param {number} opts.port          the UDP port to advertise
   * @param {string} [opts.group]
   * @param {number} [opts.socketPort]
   * @param {(peer: { host: string, port: number }) => void} [opts.onpeer]
   */
  static async open (opts) {
    const port = opts?.port
    if (typeof port !== 'number' || !Number.isInteger(port)) {
      throw new Error('a beacon needs the udp port it is advertising')
    }

    const group = opts?.group ?? GROUP
    const socketPort = opts?.socketPort ?? PORT
    const socket = createSocket({ reuseAddress: true })

    // Bind IPv4 explicitly. Left to itself udx binds dual-stack `::`, and
    // joining an IPv4 group on an IPv6 socket fails — which is the bug
    // `bare-mdns-discovery` ships with.
    await new Promise((resolve, reject) => {
      const failed = (/** @type {Error} */ err) => reject(err)
      socket.once('error', failed)
      socket.bind(socketPort, '0.0.0.0', () => {
        socket.off('error', failed)
        resolve(undefined)
      })
    })

    // bare-dgram does not surface membership; udx-native underneath does. Join
    // on the default interface and on every non-internal IPv4 interface, since
    // a multi-homed host that guesses wrong receives nothing at all and says so
    // in no way we could detect later.
    const udx = socket._socket ?? socket
    let joined = 0
    for (const iface of ['', ...localInterfaces(udx)]) {
      try {
        udx.addMembership(group, iface)
        joined++
      } catch { /* already joined, or an interface with no multicast */ }
    }
    if (joined === 0) {
      await socket.close()
      throw new Error(`could not join ${group}: this host has no multicast`)
    }

    const beacon = new Beacon({
      socket,
      port,
      nonce: randomBytes(8),
      group,
      socketPort,
      onpeer: opts?.onpeer
    })
    beacon._announce()
    return beacon
  }

  /** @returns {{ host: string, port: number }[]} */
  nodes () {
    const out = []
    for (const { host, port } of this.peers.values()) out.push({ host, port })
    return out
  }

  /** @param {Buffer} msg @param {any} rinfo */
  _onmessage (msg, rinfo) {
    const beacon = decode(msg)
    if (beacon === null) return
    // Our own multicast echo. The nonce is here for exactly this and is
    // deliberately not an identity: it is random per process, so it says
    // nothing about the device that a fresh restart does not change.
    if (beacon.nonce === this.nonce.toString('hex')) return

    const host = rinfo.address
    if (typeof host !== 'string' || rinfo.family !== 'IPv4') return

    const id = host + ':' + beacon.port
    const known = this.peers.get(id)
    const at = Date.now()
    this.peers.set(id, { host, port: beacon.port, at })

    if (!known && this.onpeer) this.onpeer({ host, port: beacon.port })
  }

  _announce () {
    if (this.closed) return

    for (const [id, peer] of this.peers) {
      if (Date.now() - peer.at > FORGET) this.peers.delete(id)
    }

    // `send` rejects if the socket went away underneath us mid-teardown, which
    // is not a failure anybody can act on.
    const sent = this.socket.send(this._frame, 0, FRAME, this.socketPort, this.group)
    if (sent && typeof sent.catch === 'function') sent.catch(() => {})

    this._delay = Math.min(this._delay * 2, 30000)
    this._timer = setTimeout(() => this._announce(), this._delay)
  }

  async close () {
    if (this.closed) return
    this.closed = true
    if (this._timer !== null) clearTimeout(this._timer)
    this._timer = null
    await this.socket.close()
  }
}

/**
 * The beacon and the rendezvous node it advertises.
 *
 * The rendezvous node is a `HyperDHT` with **no bootstrap**: it never reaches
 * the public DHT and never tries. It is `ephemeral: false, firewalled: false`
 * because on a segment those are simply true — a LAN host is directly reachable
 * by its neighbours — and a node that has not established that stays ephemeral,
 * answers with a null id, and is therefore never added to anybody's routing
 * table. That is the difference between a DHT forming over the segment and
 * nothing happening at all.
 *
 * It holds no topics and no keys anybody asked about. Its whole job is to be an
 * address other devices can route through.
 */
class Lan {
  /**
   * @param {object} parts
   * @param {any} parts.dht
   * @param {Beacon} parts.beacon
   */
  constructor ({ dht, beacon }) {
    this.dht = dht
    this.beacon = beacon
    this.port = dht.address().port
    this._promoting = null
    /** @type {(() => void)[]} */
    this._waiting = []
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.group]
   * @param {number} [opts.socketPort]
   */
  static async open (opts = {}) {
    const dht = new HyperDHT({
      bootstrap: [],
      ephemeral: false,
      firewalled: false,
      host: '0.0.0.0'
    })

    try {
      await dht.fullyBootstrapped()

      /** @type {Lan} */ let lan
      const beacon = await Beacon.open({
        port: dht.address().port,
        group: opts.group,
        socketPort: opts.socketPort,
        onpeer: (peer) => lan._onpeer(peer)
      })

      lan = new Lan({ dht, beacon })
      return lan
    } catch (err) {
      await dht.destroy()
      throw err
    }
  }

  /** @param {{ host: string, port: number }} peer */
  _onpeer (peer) {
    // Both, and the pair matters. `addNode` puts it in the routing table;
    // pushing it onto `bootstrapNodes` is what lets a node whose table has gone
    // empty find its way back on, since the bootstrap list is the only thing
    // consulted when there is nothing to query.
    this.dht.bootstrapNodes.push(peer)
    this.dht.addNode(peer)
    if (this.dht.ephemeral) this._promote(peer)

    const waiting = this._waiting
    this._waiting = []
    for (const resolve of waiting) resolve()
  }

  /**
   * Wait for the segment to answer, once.
   *
   * A swarm's bootstrap list is fixed when the swarm is built, so a realm opened
   * before the first beacon arrives gets an empty one and stays empty: hyperswarm
   * does not go back and re-bootstrap. Where the LAN is the *only* route out
   * there is nothing to be gained by starting early, so `Node` waits here first.
   * Resolves on the timeout as well as on a peer — a segment with nobody on it
   * is an answer, and a device with no peers is still a working device.
   *
   * @param {number} [timeout]
   * @returns {Promise<{ host: string, port: number }[]>}
   */
  async discover (timeout = DISCOVER) {
    if (this.beacon.peers.size === 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          const at = this._waiting.indexOf(done)
          if (at !== -1) this._waiting.splice(at, 1)
          resolve(undefined)
        }, timeout)
        const done = () => { clearTimeout(timer); resolve(undefined) }
        this._waiting.push(done)
      })
    }
    // `nodes()` withholds our own rendezvous until it knows the address its
    // neighbours see, and that is exactly what `_promote` establishes.
    if (this._promoting !== null) await this._promoting
    return this.nodes()
  }

  /**
   * Finish what `ephemeral: false` started.
   *
   * `ephemeral: false` sets `_forcePersistent`, and dht-rpc then only tries to
   * become persistent inside `_bootstrap()` — because that same option turns
   * `adaptive` off, so the retry on `_ontick` never fires. A node that came up
   * with an empty bootstrap list has no address sample at that moment and stays
   * ephemeral **forever**, which is not a slow start: an ephemeral node answers
   * with a null id, and `_addNodeFromNetwork` drops a null id, so no other
   * device ever puts it in a routing table. The first device on a segment would
   * be permanently invisible to the second.
   *
   * So: once somebody is there to answer, ping them — a response carries the
   * address it saw us at, which is the sample the NAT sampler was missing — and
   * then make the state update `_bootstrap` would have made. `ping` is public;
   * `_updateNetworkState` is not, and it is the only path to a documented
   * option's stated effect. If a future dht-rpc removes it, the node stays
   * ephemeral and LAN discovery degrades to needing one already-persistent node
   * on the segment rather than breaking.
   *
   * @param {{ host: string, port: number }} peer
   */
  _promote (peer) {
    if (this._promoting !== null) return
    this._promoting = (async () => {
      try {
        await this.dht.ping(peer)
        await this.dht._updateNetworkState(false)
      } catch { /* it stays ephemeral; see above */ } finally {
        this._promoting = null
      }
    })()
  }

  /**
   * DHT nodes to hand a realm's swarm, this device's own rendezvous first.
   *
   * Ours is included so that every realm on this device attaches to the LAN DHT
   * through one node, and so a device that came up first has something to
   * bootstrap against while it waits for company.
   *
   * It is included **at the address our neighbours see us at, never
   * `127.0.0.1`**, and omitted entirely until we know what that is. This cost an
   * afternoon and is not cosmetic: a DHT node works out its own address from the
   * addresses its bootstrap nodes report back, and a list mixing loopback with
   * LAN addresses makes it look like a host whose address changes per peer. The
   * NAT sampler then agrees on nothing, `dht.host` stays null, the server
   * announces no reachable address, and lookups find a peer nobody can reach.
   * One inconsistent entry is enough.
   *
   * @returns {{ host: string, port: number }[]}
   */
  nodes () {
    const own = this.dht.host
    const nodes = this.beacon.nodes()
    return own === null ? nodes : [{ host: own, port: this.port }, ...nodes]
  }

  async close () {
    await this.beacon.close()
    if (this._promoting !== null) await this._promoting
    for (const resolve of this._waiting.splice(0)) resolve()
    await this.dht.destroy()
  }
}

/**
 * @typedef {boolean | { group?: string, socketPort?: number }} LanOption
 */

/**
 * Whether to beacon at all, given what the caller said and what DHT it named.
 *
 * A caller who said nothing about `lan` beacons when no bootstrap was named and
 * stays quiet when one was, because naming a bootstrap says the DHT is already
 * reachable and a reachable DHT does not need the segment asked. So the default
 * is on for the ordinary case, and `lan: false` is the opt-out — the header says
 * what leaving it on discloses and why that is the trade worth making.
 *
 * Shared by `Node` and `Operator` because they had drifted: the segment case
 * exists so a site with the DHT firewalled still works, and a device that finds
 * a network nobody is serving on the segment is half a feature. Two copies of
 * this rule would be two chances to answer the enterprise case differently on
 * the two ends of one connection.
 *
 * @param {LanOption | undefined} lan
 * @param {any[] | undefined} bootstrap
 * @returns {LanOption}
 */
function lanDefault (lan, bootstrap) {
  return lan ?? (bootstrap === undefined || bootstrap.length === 0)
}

/**
 * Bring up the beacon, or record why it did not come up.
 *
 * A segment with no multicast — a locked-down container, a bridged interface
 * that drops it — is a degraded network and not a broken process, so the failure
 * is returned rather than thrown and the caller carries on over whatever DHT
 * there is.
 *
 * @param {LanOption} lanOpts
 * @param {any[] | undefined} bootstrap
 * @returns {Promise<{ lan: Lan | null, lanError: Error | null }>}
 */
async function openLan (lanOpts, bootstrap) {
  if (lanOpts === false) return { lan: null, lanError: null }
  try {
    const lan = await Lan.open(lanOpts === true ? {} : lanOpts)
    // Only when the segment is the whole world. A swarm's bootstrap list is
    // fixed at construction, so building one before the first beacon lands
    // would leave it empty with no way back; where there is a DHT as well there
    // is no reason to make anyone wait.
    if (bootstrap !== undefined && bootstrap.length === 0) await lan.discover()
    return { lan, lanError: null }
  } catch (err) {
    return { lan: null, lanError: /** @type {Error} */ (err) }
  }
}

/**
 * How the LAN half and the DHT half feed **one** peer set.
 *
 * They do not both produce peers. LAN discovery produces *routing*: a swarm
 * still finds peers exactly one way, `join(topic)`, over a DHT that now has
 * nodes reachable without leaving the segment. So there is no second peer source
 * to reconcile, and hyperswarm's dedupe by remote public key is untouched — a
 * peer reachable over both is one connection because it was only ever looked up
 * once.
 *
 * Where the nodes go depends on whether there is another DHT at all, and the
 * difference is not cosmetic. `bootstrap` nodes are asked what address they see
 * us at; `nodes` are added to the routing table and **not sampled at insertion**.
 * A device that can reach both the public DHT and the segment gets *different*
 * answers from each — its public address and its RFC1918 one — and enough
 * disagreement makes the sampler give up and report no address at all. So LAN
 * nodes join the bootstrap list only when it would otherwise be empty, and are
 * otherwise routing. Auto-detecting a blocked DHT instead was considered and
 * dropped: a probe cannot tell blocked from slow, and guessing wrong degrades the
 * path that works today.
 *
 * **This paragraph used to say `nodes` are "never sampled" and "pure routing",
 * and that is stronger than the runtime.** A node inserted through the `nodes`
 * option carries `to: null`, so it contributes nothing *then* — but the first time
 * it answers, `dht-rpc`'s `_onresponse` reaches `_addNodeFromNetwork`, which sets
 * its `to` and calls `_natAdd(to.host, to.port)` (`dht-rpc/index.js`, checked at
 * 6.27.0). `nat-sampler`'s `add` demands unanimity below four samples, so a
 * segment node that replies can still end a disagreement in a draw and leave this
 * device with no address at all. The mitigation this function performs is
 * therefore about *when* and *how many*, not about immunity — which matters
 * because the mixed configuration is the one nobody has run.
 * `DESIGN-REAL-NETWORK.md` §11 is the trial for it.
 *
 * @param {Lan | null} lan
 * @param {any[] | undefined} bootstrap
 */
function swarmOpts (lan, bootstrap) {
  const lanNodes = lan === null ? [] : lan.nodes()
  const alone = bootstrap !== undefined && bootstrap.length === 0

  return alone
    ? { bootstrap: lanNodes }
    : { bootstrap, nodes: lanNodes }
}

/** @param {any} udx @returns {string[]} */
function localInterfaces (udx) {
  const out = []
  try {
    for (const n of udx.udx.networkInterfaces()) {
      if (n.family !== 4 || n.internal) continue
      out.push(n.host)
    }
  } catch { /* older udx, or a host with no interfaces to enumerate */ }
  return out
}

module.exports = { Lan, Beacon, encode, decode, lanDefault, openLan, swarmOpts, GROUP, PORT, FRAME }
