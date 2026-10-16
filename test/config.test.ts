import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'

describe('Config', () => {
  it('defaults an empty config to a working sandbox', () => {
    const config = Config({})
    expect(config.mountMode).toBe('workspace')
    expect(config.image.get()).toBe('node:24')
  })

  it('bootstraps playwright with chromium by default', () => {
    const config = Config({})
    expect(config.bootstrapPlaywright).toBe(true)
    expect(config.playwrightBrowsers).toEqual(['chromium'])
    expect(config.playwrightVersion).toBe('1.64.1')
    expect(config.playwrightInstallTimeoutMs).toBe(600000)
    expect(() => Config({ playwrightInstallTimeoutMs: 0 })).toThrow()
  })

  it('accepts the three playwright browsers and rejects a typo at load', () => {
    expect(Config({ playwrightBrowsers: ['firefox', 'webkit'] }).playwrightBrowsers).toEqual(['firefox', 'webkit'])
    expect(() => Config({ playwrightBrowsers: ['cromium'] } as never)).toThrow()
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

  it('defaults the API gate to the harness browser session', () => {
    expect(Config({}).apiToken.get()).toBe('')
  })

  it('carries a bearer token through a reload', () => {
    expect(Config({ apiToken: 's3cret' }).apiToken.get()).toBe('s3cret')
  })
})
