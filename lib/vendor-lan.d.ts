/**
 * The two modules `lib/lan.js` needs and which ship no types, declared here
 * rather than in `vendor.d.ts` and pulled in by a reference from the file that
 * needs them.
 *
 * `vendor.d.ts` is on this package's include path and nobody else's, so a
 * consumer that type-checks our sources through a `file:` link — `artifact-net`
 * does — would otherwise have to declare our dependencies in its own vendor
 * file. A referenced declaration travels with the code instead. That mechanism
 * is the reason this file survived the move out of `artifact-net` unchanged:
 * it was written for exactly one consumer type-checking one file across a
 * package boundary, and the boundary moved rather than went away.
 *
 * Kept separate from `vendor.d.ts` and narrow on purpose: it must only *add*
 * modules, never redeclare one a consumer has already described better than we
 * would. `Buffer`, `setTimeout` and `clearTimeout` are the concrete cases —
 * `lib/lan.js` uses all three, and all three are declared in `vendor.d.ts`
 * where only this repo's own program sees them. Declaring them here would
 * collide with the consumer's own copy, which is a duplicate-identifier error
 * in a file the consumer cannot edit.
 *
 * `bare-crypto` used to be absent from this list because it ships an
 * `index.d.ts` of its own. It is gone from the package entirely, replaced by
 * `hypercore-crypto` for a packaging reason `lib/lan.js` argues at the require.
 *
 * **`hypercore-crypto` is deliberately not declared here, and the reason is the
 * paragraph above.** `artifact-net` already declares it — `vendor.d.ts:8`, as
 * `export = any` — and this file adding `export function randomBytes` made
 * `artifact-net`'s typecheck of *our* source fail with `TS2305: Module
 * '"hypercore-crypto"' has no exported member 'randomBytes'`. Which is exactly the
 * collision the rule above describes, arrived at by ignoring it. It belongs in our
 * own `vendor.d.ts`, which nobody else's program reads.
 */

declare module 'hyperdht' { const HyperDHT: any; export = HyperDHT }
declare module 'bare-dgram' { export function createSocket (opts?: any, cb?: any): any }
