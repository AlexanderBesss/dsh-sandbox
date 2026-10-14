import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { sameOrigin } from '../src/status.ts'

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage
}

const HOST = '127.0.0.1:19387'

describe('sameOrigin', () => {
  it('accepts the app renderer bridged from the dsh-app scheme', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'dsh-app://app' }))).toBe(true)
  })

  it('accepts a bridged request whose Origin was stripped', () => {
    expect(sameOrigin(request({ host: HOST }))).toBe(true)
  })

  it('accepts a direct same-origin browser request', () => {
    expect(sameOrigin(request({ host: HOST, origin: `http://${HOST}` }))).toBe(true)
  })

  it('refuses a cross-site web origin', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'https://evil.example' }))).toBe(false)
  })

  it('refuses the same host on another port', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'http://127.0.0.1:9999' }))).toBe(false)
  })

  it('refuses what the client itself reports as cross-site', () => {
    expect(
      sameOrigin(request({ host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'cross-site' })),
    ).toBe(false)
  })

  it('refuses a malformed Origin', () => {
    expect(sameOrigin(request({ host: HOST, origin: 'not a url' }))).toBe(false)
  })
})
