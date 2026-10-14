import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { handleMergeRequest, handleReview, sameOrigin, type StatusDeps } from '../src/status.ts'
import type { SandboxContext } from '../src/context.ts'

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

const SESSION = 'session-3'
const WORKSPACE = 'F:\\Projects\\dsh-sandbox'

interface Reply {
  status: number
  body: unknown
}

function capture(): { replies: Reply[]; respond: (status: number, body: unknown) => void } {
  const replies: Reply[] = []
  return { replies, respond: (status, body) => void replies.push({ status, body }) }
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? ''
}

describe('handleMergeRequest', () => {
  it('refuses a GET with 405', async () => {
    const { replies, respond } = capture()
    await handleMergeRequest(respond, {} as StatusDeps, SESSION, WORKSPACE, false)
    expect(replies[0]!.status).toBe(405)
  })

  it('refuses with 409 when worktree mode is off', async () => {
    const { replies, respond } = capture()
    await handleMergeRequest(respond, {} as StatusDeps, SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('worktree-off')
  })

  it('answers with the merge result', async () => {
    const worktrees = {
      mergeRequest: async () => ({ branch: 'dsh-sbx/x', worktreePath: 'wt', committed: true, pushed: true }),
    }
    const { replies, respond } = capture()
    await handleMergeRequest(respond, { worktrees } as unknown as StatusDeps, SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(200)
    expect((replies[0]!.body as { data: { branch: string } }).data.branch).toBe('dsh-sbx/x')
  })
})

describe('handleReview', () => {
  const entry = {
    sessionId: SESSION,
    mainWorkspace: WORKSPACE,
    repoRoot: WORKSPACE,
    worktreePath: 'wt',
    branch: 'dsh-sbx/x',
    createdAt: 0,
    hostGitDir: '',
    gitConfig: {},
  }
  const changes = { log: 'abc123 fix', status: '', diff: '+x', truncated: false }

  function depsFor(bundle: unknown, subagents?: () => unknown): StatusDeps {
    return {
      worktrees: { reviewFor: async () => bundle },
      ...(subagents === undefined ? {} : { subagents }),
    } as unknown as StatusDeps
  }

  it('refuses a GET with 405', async () => {
    const { replies, respond } = capture()
    await handleReview(respond, {} as SandboxContext, depsFor({ entry, changes }), SESSION, WORKSPACE, false)
    expect(replies[0]!.status).toBe(405)
  })

  it('refuses with 409 when the session has no worktree', async () => {
    const { replies, respond } = capture()
    await handleReview(respond, {} as SandboxContext, depsFor(undefined), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('no-worktree')
  })

  it('refuses with 409 when the session changed nothing', async () => {
    const empty = { log: '', status: '', diff: '   ', truncated: false }
    const { replies, respond } = capture()
    await handleReview(respond, {} as SandboxContext, depsFor({ entry, changes: empty }), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('no-changes')
  })

  it('refuses with 503 when no subagent provider is registered', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    const { replies, respond } = capture()
    await handleReview(respond, ctx, depsFor({ entry, changes }, () => ({ list: () => [] })), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(503)
    expect(errorCode(replies[0]!.body)).toBe('no-subagents')
  })

  it('refuses with 409 when the session has no live agent', async () => {
    const ctx = { agents: { get: () => undefined } } as unknown as SandboxContext
    const { replies, respond } = capture()
    const subagents = () => ({ list: () => ['inline'] })
    await handleReview(respond, ctx, depsFor({ entry, changes }, subagents), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('no-agent')
  })

  it('starts the review and answers with the child session', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    const started: Array<{ provider: string; label?: string }> = []
    const subagents = () => ({
      list: () => ['inline'],
      start: async (provider: string, request: { label?: string }) => {
        started.push({ provider, label: request.label })
        return {
          localAgent: { session: { id: 'child-1' } },
          result: Promise.resolve({ stopReason: 'completed', output: [] }),
        }
      },
    })
    const { replies, respond } = capture()
    await handleReview(respond, ctx, depsFor({ entry, changes }, subagents), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(200)
    expect((replies[0]!.body as { data: unknown }).data).toEqual({ provider: 'inline', childSessionId: 'child-1' })
    expect(started).toEqual([{ provider: 'inline', label: 'code review' }])
  })
})
