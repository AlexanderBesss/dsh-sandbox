import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'

describe('Config', () => {
  it('defaults an empty config to a working sandbox', () => {
    const config = Config({})
    expect(config.mountMode).toBe('workspace')
    expect(config.image.get()).toBe('alpine:3.20')
  })

  it('accepts the two mount modes and rejects a typo at load', () => {
    expect(Config({ mountMode: 'drives' }).mountMode).toBe('drives')
    expect(() => Config({ mountMode: 'driver' } as never)).toThrow()
  })

  it('accepts the three ripgrep sources and rejects a typo at load', () => {
    // A free string would let "pacakge" silently take the package branch.
    expect(Config({ ripgrepSource: 'url' }).ripgrepSource).toBe('url')
    expect(Config({ ripgrepSource: 'none' }).ripgrepSource).toBe('none')
    expect(() => Config({ ripgrepSource: 'pacakge' } as never)).toThrow()
  })

  it('bounds the numbers whose absence misbehaves at runtime', () => {
    // gcIntervalMs 0 turns the GC sweep into a busy loop of docker calls;
    // provisionTimeoutMs 0 kills the very first engine call.
    expect(() => Config({ gcIntervalMs: 0 })).toThrow()
    expect(() => Config({ provisionTimeoutMs: 0 })).toThrow()
    expect(() => Config({ graceMs: -1 })).toThrow()
    expect(Config({ gcIntervalMs: 1000 }).gcIntervalMs).toBe(1000)
  })
})
