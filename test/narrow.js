/**
 * One assertion the checker believes, because `bare-assert`'s cannot be.
 *
 * The suite reads the success arm of a `{ port, nonce } | null` on the line after
 * asserting the thing is there. That is correct code — `assert.ok` throws on a
 * falsy value, so the next line does not run otherwise — and `tsc` cannot see
 * it, because `bare-assert`'s shipped `index.d.ts` types `ok` as
 * `(value: any, message?) => void`. A function returning `void` narrows nothing,
 * so the line below it is `TS2531`.
 *
 * The alternative was a cast at each site, and that is the wrong trade: a cast
 * asserts nothing at runtime, so a `decode` that began returning `null` would
 * surface as `Cannot read properties of null` from a line that no longer says
 * what it wanted. This narrows **because** it throws, so a failure names the
 * thing that was not there.
 *
 * `@returns {asserts value}` is the trick on the underlying `ok`, and one detail
 * is worth writing down: TypeScript honours an assertion signature only when the
 * callee has an explicit type annotation. A JSDoc'd `function` declaration
 * counts; an un-annotated `const ok = (v, m) => …` does not, and fails by simply
 * not narrowing rather than by complaining. Hence the declaration form.
 *
 * Only `got` is exported. `artifact-net`'s copy of this file also carries a
 * standalone `ok`, for suites that bind a value and read it twice; nothing here
 * needs one, and an exported function no caller reaches is dead code however
 * good its argument is. Add it back the day a case wants it.
 */
const assert = require('bare-assert')

/**
 * Assert `value` is truthy, and narrow it.
 *
 * @param {unknown} value
 * @param {string} [message]
 * @returns {asserts value}
 */
function ok (value, message) {
  assert.ok(value, message)
}

/**
 * The same assertion, as an expression.
 *
 * For a `decode` result read once, where binding a name and asserting it on a
 * second line would be three lines saying what one says.
 *
 * @template T
 * @param {T} value
 * @param {string} [message]
 * @returns {NonNullable<T>}
 */
function got (value, message) {
  ok(value, message)
  return value
}

module.exports = { got }
