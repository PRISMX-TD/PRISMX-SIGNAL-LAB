import { describe, expect, it } from 'vitest'
import { isChunkLoadError, isOldEngineError } from './clientErrorReport'

function syntaxError(message: string): Error {
  return new SyntaxError(message)
}

describe('error classification', () => {
  it('treats a failed dynamic import as a chunk error', () => {
    const err = new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js')
    expect(isChunkLoadError(err)).toBe(true)
    expect(isOldEngineError(err)).toBe(false)
  })

  // 中间层把 chunk 答成 HTML：是网络，不是引擎太老。
  // A middlebox answered the chunk with HTML: network, not an old engine.
  it.each([
    "Unexpected token '<'",
    'Unexpected token <',
    "expected expression, got '<'",
  ])('treats HTML parsed as script (%s) as a chunk error', (message) => {
    const err = syntaxError(message)
    expect(isChunkLoadError(err)).toBe(true)
    expect(isOldEngineError(err)).toBe(false)
  })

  it('leaves JSON.parse on HTML out of the chunk bucket', () => {
    for (const message of [
      'Unexpected token < in JSON at position 0',
      `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    ]) {
      expect(isChunkLoadError(syntaxError(message))).toBe(false)
    }
  })

  it('still reports genuine old-engine syntax errors', () => {
    const err = syntaxError("Unexpected token '.'")
    expect(isChunkLoadError(err)).toBe(false)
    expect(isOldEngineError(err)).toBe(true)
  })

  it('classifies an ordinary runtime error as neither', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'x')")
    expect(isChunkLoadError(err)).toBe(false)
    expect(isOldEngineError(err)).toBe(false)
  })
})
