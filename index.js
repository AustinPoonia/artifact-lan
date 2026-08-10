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
 * ## Types come through `artifact-lan/lan`, and this file re-declares none
 *
 * There is no `@typedef` here, and that absence is deliberate rather than an
 * omission to be filled in. This file is `module.exports = <expression>`, which
 * TypeScript reads as `export =`; a JSDoc `@typedef` in such a file does not
 * become a named type export of it, and when the whole tree is compiled as one
 * program the declaration collides with the one it was aliasing —
 * `TS2300: Duplicate identifier 'LanOption'`, reported against this line and
 * against any other re-export that did the same thing.
 *
 * It is invisible in this repo's own `npm run typecheck` and in `artifact-net`'s,
 * and only appears when a consumer compiles both packages together, which is
 * exactly the failure mode `AGENTS.md` means by "verify against the whole set,
 * not one repo". So `LanOption` is declared in **one** place, `lib/lan.js`, and
 * consumers annotate against `import('artifact-lan/lan').LanOption` — a subpath
 * this package declares in `exports`, so `--check-doors` polices the reference
 * rather than leaving it to be discovered.
 */
module.exports = require('./lib/lan')
