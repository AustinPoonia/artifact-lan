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
 * `bare-crypto` is absent because it ships an `index.d.ts` of its own.
 */

declare module 'hyperdht' { const HyperDHT: any; export = HyperDHT }
declare module 'bare-dgram' { export function createSocket (opts?: any, cb?: any): any }
