import { describe, expect, it } from 'vitest'
import { createSessionTitleReader } from '../src/container/session-title.ts'
import type { SandboxContext } from '../src/context.ts'

interface FakeCtxOptions {
  title?: string
  titleThrows?: boolean
  events?: unknown[]
  live?: boolean
}

function userMessage(text: string, kind = 'user'): unknown {
  return { type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } }
}

function fakeCtx(options: FakeCtxOptions = {}): SandboxContext {
  const session = {
    id: 'session-3',
    header: { cwd: 'F:\\Projects\\repo' },
    ...(options.events === undefined ? {} : { snapshotEvents: () => options.events }),
  }
  return {
    sessions: { get: (id: string) => (options.live === false ? undefined : { ...session, id }) },
    get: (name: string) => {
      if (name !== 'sessionTitle') return undefined
      if (options.titleThrows === true) throw new Error('session-title service disposed')
      if (options.title === undefined) return undefined
      return { get: () => ({ title: options.title }) }
    },
  } as unknown as SandboxContext
}

describe('createSessionTitleReader', () => {
  it('prefers the title the app itself shows for the chat', () => {
    const reader = createSessionTitleReader(fakeCtx({
      title: 'Fix the login crash',
      events: [userMessage('my app crashes when I log in, please fix')],
    }))
    expect(reader('session-3')).toBe('Fix the login crash')
  })

  it('falls back to the first human message while the app has no title yet', () => {
    const reader = createSessionTitleReader(fakeCtx({
      events: [userMessage('Rename the branch to something readable')],
    }))
    expect(reader('session-3')).toBe('Rename the branch to something readable')
  })

  it('skips messages that are not eligible human input', () => {
    const reader = createSessionTitleReader(fakeCtx({
      events: [
        { type: 'session/title', data: { title: 'x' } },
        userMessage('', 'user'),
        userMessage('injected by a tool', 'agent'),
        userMessage('the real request'),
      ],
    }))
    expect(reader('session-3')).toBe('the real request')
  })

  it('answers undefined when the app has nothing readable', () => {
    expect(createSessionTitleReader(fakeCtx())('session-3')).toBeUndefined()
    expect(createSessionTitleReader(fakeCtx({ live: false }))('session-3')).toBeUndefined()
    expect(createSessionTitleReader(fakeCtx({ events: [] }))('session-3')).toBeUndefined()
  })

  it('still reads the log when the title service is unavailable', () => {
    const reader = createSessionTitleReader(fakeCtx({
      titleThrows: true,
      events: [userMessage('Explain the failing test')],
    }))
    expect(reader('session-3')).toBe('Explain the failing test')
  })

  it('never throws, whatever the app hands back', () => {
    const broken = {
      sessions: { get: () => { throw new Error('store is shutting down') } },
      get: () => undefined,
    } as unknown as SandboxContext
    expect(createSessionTitleReader(broken)('session-3')).toBeUndefined()
  })
})
