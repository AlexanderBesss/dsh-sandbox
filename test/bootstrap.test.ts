import { describe, expect, it } from 'vitest'
import { playwrightInstallCommand, ripgrepInstallCommand } from '../src/container/bootstrap.ts'

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

describe('ripgrepInstallCommand url branch', () => {
  const urlCommand = ripgrepInstallCommand('url')

  it('downloads to a temp file and verifies the pinned sha256 before extracting', () => {
    expect(urlCommand).toBe(
      "wget -qO /tmp/dsh-rg.tgz https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz "
      + "&& echo '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e  /tmp/dsh-rg.tgz' | sha256sum -c - >/dev/null "
      + "&& tar xzf /tmp/dsh-rg.tgz -C /usr/local/bin --strip-components=1 && rm -f /tmp/dsh-rg.tgz",
    )
  })

  it('verifies the digest before extracting so a mismatched tarball is never unpacked', () => {
    expect(urlCommand.indexOf('sha256sum -c')).toBeGreaterThan(-1)
    expect(urlCommand.indexOf('sha256sum -c')).toBeLessThan(urlCommand.indexOf('tar xzf'))
  })
})
