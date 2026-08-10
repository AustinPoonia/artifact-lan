/**
 * artifact-lan — finding peers on the local segment, without telling the segment
 * who they are.
 *
 * One 18-byte multicast beacon per device carrying a magic, a version, a UDP
 * port and a random per-process nonce, and behind that port an ordinary
 * bootstrap-less `HyperDHT` node that holds no topics. Devices add each other's
 * and a DHT forms over the segment with no bootstrap server. `lib/lan.js`'s
 * header is the argument for every one of those choices, including what the
 * segment does learn and why that is the trade worth making.
 *
 * ## Why this is its own repository
 *
 * It requires `hyperdht`, `bare-crypto` and `bare-dgram` and nothing else. It
 * lived in `artifact-net` and imported nothing from it, nothing from
 * `artifact-protocol`, and knows nothing about artifacts, networks, manifests or
 * keys — the beacon carrying no network-derived bytes is not incidental, it is
 * the isolation argument, and a module that cannot name a network is a module
 * with no reason to sit in the repo that defines one.
 *
 * What settles it is the module it replaces. `bare-mdns-discovery` is
 * Holepunch's and is on the Bare module list; it is query-only, so two nodes on
 * a segment would both ask and neither would ever answer. A module written
 * because an ecosystem module could not do the job belongs in the ecosystem
 * beside it, not inside one consumer.
 *
 * ## The surface, and the one thing it is not
 *
 * `Lan` and `Beacon` are the two objects; `encode`/`decode` are the frame;
 * `lanDefault`, `openLan` and `swarmOpts` are the three functions that decide
 * *whether* to beacon and where the nodes go, and they are here rather than in a
 * caller because two callers had already drifted on them — `artifact-net`'s
 * `Node` and `Operator` are the two ends of one connection and have to answer
 * the enterprise case the same way.
 *
 * It is **not** an artifact. There is no `manifest.json`, no `build`, no ports:
 * it opens a UDP socket and a DHT node, which is ambient authority an artifact
 * is definitionally not given. It is an ordinary Bare module that the platform's
 * kernel-side code requires directly.
 *
 * @typedef {import('./lib/lan').LanOption} LanOption
 */
module.exports = require('./lib/lan')
