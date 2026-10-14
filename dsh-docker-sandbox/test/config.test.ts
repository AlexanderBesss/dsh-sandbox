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
    expect(Config({ ripgrepSource: 'url' }).ripgrepSource).toBe('url')
    expect(Config({ ripgrepSource: 'none' }).ripgrepSource).toBe('none')
    expect(() => Config({ ripgrepSource: 'pacakge' } as never)).toThrow()
  })

  it('bounds the numbers whose absence misbehaves at runtime', () => {
    expect(() => Config({ gcIntervalMs: 0 })).toThrow()
    expect(() => Config({ provisionTimeoutMs: 0 })).toThrow()
    expect(() => Config({ graceMs: -1 })).toThrow()
    expect(Config({ gcIntervalMs: 1000 }).gcIntervalMs).toBe(1000)
  })

  it('defaults worktree mode off, with a readable branch prefix and host CLIs', () => {
    const config = Config({})
    expect(config.worktree.get()).toBe(false)
    expect(config.worktreeRoot.get()).toBe('')
    expect(config.worktreeBranchPrefix).toBe('dsh-sbx/')
    expect(config.gitArgv).toEqual(['git'])
    expect(config.ghArgv).toEqual(['gh'])
  })

  it('lets worktree mode be toggled live', () => {
    expect(Config({ worktree: true }).worktree.get()).toBe(true)
  })
})
