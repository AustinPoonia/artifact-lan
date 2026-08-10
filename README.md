# artifact-lan

Multicast peer discovery for [hyperdht](https://github.com/holepunchto/hyperdht).
One 18-byte beacon per device, and behind the port it advertises, a
bootstrap-less DHT node other devices can route through.

Part of the **artifact platform** — a signed peer-to-peer artifact ecosystem — but
nothing in here knows that. It requires `hyperdht`, `bare-crypto` and `bare-dgram`
and nothing else, and it names no artifact, network, manifest or key.

- **Runtime:** [Bare](https://github.com/holepunchto/bare), not Node
- **Design:** see `ARCHITECTURE.md` §5 in [artifact-platform](https://github.com/AustinPoonia/ArtifactPlatform)

## The problem

Enterprise networks routinely firewall the open DHT, and a site that blocks it
gets a platform where no device finds any other. The current answer is "run a
private bootstrap", and a bootstrap node is a server — something to install,
address, and keep switched on.

## What is on the wire

One frame, 18 bytes: a magic, a version, a UDP port, and a random per-process
nonce used for nothing but discarding this device's own multicast echo. It goes to
`239.255.65.82:26082` — RFC 2365 IPv4 Local Scope, which with the default
`IP_MULTICAST_TTL` of 1 does not leave the segment.

Not on the wire: any network key, any topic, the device key, how many networks
this device is in, the hostname, the platform version. A beacon says "a node is at
this address" and nothing that could be matched against a network. That is the
whole isolation argument and it is why one beacon *per device* rather than per
network matters — a device beaconing three topics would be visibly a device in
three networks.

The residue, named rather than hidden: the segment learns this machine runs the
platform, and learns one UDP port. Both are already visible to anything watching
the wire or scanning the /24, and neither is derived from a network key.

## Why a port and not a peer

The tempting design broadcasts something hyperswarm can dedupe on and hands it to
`swarm.joinPeer`. That needs the peer's noise public key, which is per-network —
the leak above wearing a hat — and it bypasses topic membership entirely: every
device on the segment would connect to every other regardless of what they share.

What is broadcast instead is the port of a **rendezvous node**: an ordinary
persistent `HyperDHT` with no bootstrap, holding no topics and announcing nothing.
Devices add each other's and a DHT forms over the segment with no bootstrap
server.

**So both halves feed one peer set by construction.** LAN discovery produces no
peers; it produces *routing*. A caller still finds peers exactly one way, the
`swarm.join(topic)` it already did, over a DHT that now has nodes on it. There is
nothing to dedupe, and hyperswarm's dedupe by remote public key is untouched: a
peer reachable both ways is found once because it was only ever looked up once.

## Not DNS-SD, and not `bare-mdns-discovery`

`bare-mdns-discovery` was the plan. It is real, it is Holepunch's, and it is on
the Bare module list — and it is **query-only**: `buildQuery` is the whole encoder
and `parseRecords` discards any packet without the response bit, so there is no
responder, no SRV/TXT to publish and no way to answer a PTR. Two nodes on one
segment would both ask and neither would ever reply. Its socket setup does not
survive contact either: it binds 5353 with no address, so udx gives it a
dual-stack `::` socket and `addMembership('224.0.0.251')` then fails with
`invalid argument`. On macOS it appears to work anyway, because mDNSResponder
holds the group membership and `SO_REUSEPORT` hands copies to every socket on the
port; on a host with no system responder it receives nothing.

So this uses the module underneath it, `bare-dgram`, and binds `0.0.0.0`
explicitly.

Speaking no DNS-SD is separately deliberate. Publishing `_artifact._tcp.local`
would put the device in the Bonjour cache of every Mac and Windows box on the
segment, enumerable by anyone running `dns-sd -B`, with a service name and a TXT
record attached. For a platform whose claim is about *linkability*, that is the
wrong wire.

## Usage

```js
const { Lan, openLan, lanDefault, swarmOpts } = require('artifact-lan')

// The whole thing: a beacon plus the rendezvous node it advertises.
const lan = await Lan.open()
await lan.discover()          // wait once for the segment to answer, or time out
lan.nodes()                   // [{ host, port }], this device's rendezvous first

// Or the three functions that decide whether to beacon at all, which exist so
// that two ends of one connection cannot answer the question differently.
const opts = lanDefault(userAsked, bootstrap)
const { lan, lanError } = await openLan(opts, bootstrap)
new Hyperswarm(swarmOpts(lan, bootstrap))
```

`lanDefault` returns `true` when no bootstrap was named and `false` when one was:
naming a bootstrap says the DHT is already reachable, and a reachable DHT does not
need the segment asked. Saying nothing gets the public DHT, which is precisely
what a perimeter blocks; naming an empty list says there is no DHT at all. In both
of those the segment is the only thing left to ask — so **on is the default**, and
`false` is the opt-out for a hostile segment. Announcing a host to colleagues and
announcing it to a room of strangers are the same frame and not the same
disclosure, and nothing on the wire can tell the two apart.

`openLan` **returns** its failure rather than throwing it: a segment with no
multicast — a locked-down container, a bridged interface that drops it — is a
degraded network and not a broken process.

`swarmOpts` puts LAN nodes in `bootstrap` only when it would otherwise be empty,
and in `nodes` otherwise. That is not cosmetic: bootstrap nodes are asked what
address they see us at, and a device reachable over both the public DHT and the
segment gets *different* answers from each — enough disagreement and the NAT
sampler reports no address at all.

## What is not here

- **A swarm built before the segment answered.** A swarm's bootstrap list is fixed
  when the swarm is built and hyperswarm does not go back and re-bootstrap. A
  caller with `bootstrap: []` should `await lan.discover()` first; one that joins
  and *later* meets the segment recovers only on the DHT's own refresh cycle, in
  minutes rather than seconds. It bites the first device on a wire hardest, because
  `Lan.nodes()` withholds this device's own rendezvous until a neighbour has
  answered and told it what address it is seen at — so whoever builds a swarm
  second is the one that can see the other. The fix for both is the same, a swarm
  whose DHT can be added to after construction, and it is not built.

- **Confidentiality of the topic set.** A LAN DHT is small, so every node on it
  stores announce records for every topic. A device on the segment can see that
  *some* peer announced *some* topic hash, cannot invert the hash and cannot join
  without it — but can count distinct topics against one IP. That is a property of
  any small DHT, including the private bootstrap this replaces.

- **`_updateNetworkState` is reached through the back door.** `ephemeral: false`
  sets `_forcePersistent`, and dht-rpc then only tries to become persistent inside
  `_bootstrap()` — because that same option turns `adaptive` off, so the retry on
  `_ontick` never fires. A node that came up with an empty bootstrap list has no
  address sample at that moment and would stay ephemeral forever, answer with a
  null id, and never be added to anybody's routing table. So once somebody is there
  to answer, `Lan` pings them and then makes the state update `_bootstrap` would
  have made. `ping` is public; `_updateNetworkState` is not, and it is the only
  path to a documented option's stated effect. If a future dht-rpc removes it, the
  node stays ephemeral and discovery degrades to needing one already-persistent
  node on the segment rather than breaking.

## Development

```
npm test         # 15 cases under the Bare runtime, on real multicast
npm run typecheck
```

Every case runs on its own multicast group and port, derived from the process id.
Beaconing on the real group from a test suite would announce the machine to the
office wire and pick up whatever answered.

There is no mock. Every interesting failure here — a socket bound dual-stack, a
group never joined, a node that stays ephemeral and is therefore invisible — lives
below the JavaScript, so a mocked socket would pass while the module did not work.

### The eight cases that stayed behind

This module and its suite came out of `artifact-net`, where the file held
twenty-three cases. Fifteen are here. The other eight assert that `artifact-net`'s
`Node` and `Operator` *use* this module correctly — a device joining a network with
the DHT taken away entirely, an operator serving one over the segment, `lan: false`
opening no socket — and they need corestores, signed manifests and hyperswarm.
Moving them would have meant `artifact-lan` depending on `artifact-net`, which is
the cycle the split exists to avoid, so they stay in
`artifact-net/test/lan.test.js`. This suite proves the mechanism; that one proves
its consumers reach for it correctly.

## License

Apache-2.0
