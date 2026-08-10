/**
 * Types for the things this repo's own program needs and which ship none.
 *
 * Deliberately *not* referenced from any shipping file. `lib/lan.js` references
 * `lib/vendor-lan.d.ts` instead, and the split is load-bearing rather than
 * tidy: a consumer that type-checks our sources through a `file:` link picks up
 * whatever the shipping file references, and everything below is either a
 * global the consumer already declares or a test-only module it has no business
 * seeing. Declaring `Buffer` in a file that travels would be a
 * duplicate-identifier error in `artifact-net`'s program, in a file
 * `artifact-net` cannot edit. See `lib/vendor-lan.d.ts` for the other half.
 *
 * `bare-assert` ships its own `index.d.ts` and is deliberately absent —
 * declaring it here would shadow real types with worse ones.
 */

/// <reference types="bare-buffer/global" />

/** Bare globals from bare-timers; the ES2022 lib does not declare them. */
declare function setTimeout (cb: (...args: any[]) => void, ms?: number): unknown
declare function clearTimeout (timer: unknown): void

/**
 * `bare-tap`, at the three methods the suite uses.
 *
 * `plan`, `pass`, `fail` — the suite collects its cases, plans the length and
 * reports each one. The assertions themselves are `bare-assert`'s, and the deep
 * comparison is the suite's own `same`. So `t.equal`, `t.ok` and `subtest` are
 * genuinely unreached rather than omitted for brevity, and the day one is
 * wanted the error is a prompt to add the line deliberately.
 */
declare module 'bare-tap' {
  const tap: {
    plan (n: number): void
    pass (message?: string): void
    fail (message?: string): void
  }
  export = tap
}

/**
 * The Bare runtime global, declared at the one member the suite touches.
 *
 * `Bare.pid` and nothing else: the suite derives its multicast port from the
 * process id so two runs on one machine cannot join each other's segment. That
 * is the entire reach — `lib/lan.js` gets what it needs through modules and
 * never touches the runtime, which is the property that lets this be required
 * by a kernel rather than run as one, and a wider declaration here would make
 * the next accidental `Bare.exit()` in a test compile.
 */
declare const Bare: { pid: number }
