import { describe, expect, it } from 'vitest'
import { playwrightInstallCommand } from '../src/container/bootstrap.ts'

describe('playwrightInstallCommand', () => {
  it('pins the version and lists the configured browsers', () => {
    expect(playwrightInstallCommand(['chromium', 'firefox'], '1.64.1'))
      .toBe('npm install -g playwright@1.64.1 && playwright install --with-deps chromium firefox')
  })

  it('falls back to chromium for an empty list and to latest for an unpinned version', () => {
    expect(playwrightInstallCommand([], '')).toBe('npm install -g playwright && playwright install --with-deps chromium')
  })

  it('refuses to interpolate an unsafe version string', () => {
    expect(playwrightInstallCommand(['chromium'], '1.64.1; rm -rf /'))
      .toBe('npm install -g playwright && playwright install --with-deps chromium')
  })
})
