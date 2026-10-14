import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleMergeRequest, handleResolveConflicts, handleReview, createResolverGuard, registerStatusRoute, sameOrigin, type StatusDeps } from '../src/status.ts'
import type { SandboxContext, WebRoute } from '../src/context.ts'

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

const wtEntry = {
  sessionId: SESSION,
  mainWorkspace: WORKSPACE,
  repoRoot: WORKSPACE,
  worktreePath: 'wt',
  branch: 'dsh-sbx/x',
  createdAt: 0,
  hostGitDir: '',
  gitConfig: {},
}
const midMerge = {
  merging: true,
  conflicts: ['src/a.ts', 'src/b.ts'],
  mergingRef: 'abc123456789',
  mergingSubject: 'refuse the turn when the engine is down',
  status: 'UU src/a.ts',
  diff: 'diff --git a/src/a.ts b/src/a.ts\n',
  truncated: false,
  diffPathsTruncated: false,
}

function resolveDepsFor(bundle: unknown, subagents?: () => unknown, resolvers = createResolverGuard()): StatusDeps {
  return {
    worktrees: { conflictsFor: async () => bundle },
    resolvers,
    ...(subagents === undefined ? {} : { subagents }),
  } as unknown as StatusDeps
}

describe('handleResolveConflicts', () => {
  it('refuses a GET with 405', async () => {
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, {} as SandboxContext, resolveDepsFor({ entry: wtEntry, facts: midMerge }), SESSION, WORKSPACE, false)
    expect(replies[0]!.status).toBe(405)
  })

  it('refuses with 409 when worktree mode is off', async () => {
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, {} as SandboxContext, {} as StatusDeps, SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('worktree-off')
  })

  it('refuses with 409 when the session has no worktree', async () => {
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, {} as SandboxContext, resolveDepsFor(undefined), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('no-worktree')
  })

  it('refuses with 409 when the worktree is not mid-merge', async () => {
    const clean = { merging: false, conflicts: [], status: '', diff: '', truncated: false }
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, {} as SandboxContext, resolveDepsFor({ entry: wtEntry, facts: clean }), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('no-conflicts')
  })

  it('refuses with 503 when no subagent provider is registered', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, ctx, resolveDepsFor({ entry: wtEntry, facts: midMerge }, () => ({ list: () => [] })), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(503)
    expect(errorCode(replies[0]!.body)).toBe('no-subagents')
  })

  it('refuses with 409 when the session has no live agent', async () => {
    const ctx = { agents: { get: () => undefined } } as unknown as SandboxContext
    const { replies, respond } = capture()
    const subagents = () => ({ list: () => ['inline'] })
    await handleResolveConflicts(respond, ctx, resolveDepsFor({ entry: wtEntry, facts: midMerge }, subagents), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('no-agent')
  })

  it('refuses with 409 while the conversation agent is mid-turn', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION, status: 'running' }) } } as unknown as SandboxContext
    let started = 0
    const subagents = () => ({
      list: () => ['inline'],
      start: async () => {
        started += 1
        return { localAgent: { session: { id: 'child-1' } }, result: Promise.resolve({ stopReason: 'completed', output: [] }) }
      },
    })
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, ctx, resolveDepsFor({ entry: wtEntry, facts: midMerge }, subagents), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('agent-busy')
    expect(started).toBe(0)
  })

  it('frees the worktree when the resolver cannot be started', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    let attempts = 0
    const subagents = () => ({
      list: () => ['inline'],
      start: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('provider exploded')
        return { localAgent: { session: { id: 'child-2' } }, result: Promise.resolve({ stopReason: 'completed', output: [] }) }
      },
    })
    const deps = resolveDepsFor({ entry: wtEntry, facts: midMerge }, subagents)
    const { replies, respond } = capture()
    await expect(handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)).rejects.toThrow('provider exploded')
    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(attempts).toBe(2)
    expect(replies[0]!.status).toBe(200)
  })

  it('hands the conflicted files to a fresh resolver and answers with its session', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    const started: Array<{ provider: string; label?: string; prompt: string }> = []
    const subagents = () => ({
      list: () => ['inline'],
      start: async (provider: string, request: { label?: string; prompt: Array<{ text: string }> }) => {
        started.push({ provider, label: request.label, prompt: request.prompt.map((part) => part.text).join('\n') })
        return {
          localAgent: { session: { id: 'child-1' } },
          result: Promise.resolve({ stopReason: 'completed', output: [] }),
        }
      },
    })
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, ctx, resolveDepsFor({ entry: wtEntry, facts: midMerge }, subagents), SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(200)
    expect((replies[0]!.body as { data: unknown }).data).toEqual({
      provider: 'inline',
      childSessionId: 'child-1',
      conflicts: 2,
    })
    expect(started).toHaveLength(1)
    expect(started[0]!.label).toBe('conflict resolution')
    expect(started[0]!.prompt).toContain('src/a.ts')
    expect(started[0]!.prompt).toContain('refuse the turn when the engine is down')
    expect(started[0]!.prompt).toContain('git commit --no-edit')
    expect(started[0]!.prompt).toContain('Do not `git merge --abort`')
  })

  it('refuses a second resolver while one is already working on the worktree', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    let starts = 0
    const subagents = () => ({
      list: () => ['inline'],
      start: async () => {
        starts += 1
        return { localAgent: { session: { id: `child-${starts}` } }, result: new Promise<never>(() => {}) }
      },
    })
    const deps = resolveDepsFor({ entry: wtEntry, facts: midMerge }, subagents)
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(starts).toBe(1)
    expect(replies[0]!.status).toBe(200)
    expect(replies[1]!.status).toBe(409)
    expect(errorCode(replies[1]!.body)).toBe('resolver-running')
  })

  it('frees the worktree for another resolver once the first one settles', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    let starts = 0
    const subagents = () => ({
      list: () => ['inline'],
      start: async () => {
        starts += 1
        return {
          localAgent: { session: { id: `child-${starts}` } },
          result: Promise.resolve({ stopReason: 'error', output: [] }),
        }
      },
    })
    const deps = resolveDepsFor({ entry: wtEntry, facts: midMerge }, subagents)
    const { replies, respond } = capture()
    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(starts).toBe(2)
    expect(replies[1]!.status).toBe(200)
  })
})

describe('the /sandbox/api dispatch', () => {
  function dispatch(
    url: string,
    deps: StatusDeps,
    agents: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let handler: WebRoute['handler'] | undefined
    const ctx = {
      effect: (run: () => void) => run(),
      webServer: { register: (route: WebRoute) => { handler = route.handler; return () => {} } },
      sessions: { get: () => ({ id: SESSION, header: { cwd: WORKSPACE } }) },
      agents,
    } as unknown as SandboxContext
    registerStatusRoute(ctx, deps)
    const request = { method: 'POST', url, headers: { host: HOST } } as IncomingMessage
    let status = 0
    let body: unknown
    const response = {
      writeHead: (code: number) => { status = code },
      end: (payload?: string) => { body = payload === undefined ? undefined : JSON.parse(payload) },
    } as unknown as ServerResponse
    return Promise.resolve(handler!(request, response)).then(() => ({ status, body }))
  }

  it('routes resolve-conflicts to the resolver, not to the status endpoint', async () => {
    let started = 0
    const deps = resolveDepsFor({ entry: wtEntry, facts: midMerge }, () => ({
      list: () => ['inline'],
      start: async () => {
        started += 1
        return {
          localAgent: { session: { id: 'child-1' } },
          result: Promise.resolve({ stopReason: 'completed', output: [] }),
        }
      },
    }))
    const answer = await dispatch(`/sandbox/api/resolve-conflicts?session=${SESSION}`, deps, { get: () => ({ id: SESSION }) })
    expect(answer.status).toBe(200)
    expect(started).toBe(1)
    expect((answer.body as { data: { childSessionId: string } }).data.childSessionId).toBe('child-1')
  })
})

describe('createResolverGuard', () => {
  it('holds one slot per session until it is released', () => {
    const guard = createResolverGuard()
    expect(guard.tryStart('a')).toBeDefined()
    expect(guard.tryStart('a')).toBeUndefined()
    expect(guard.tryStart('b')).toBeDefined()
  })

  it('releases a slot whose child never settled, so the button is not locked for good', () => {
    let now = 0
    const guard = createResolverGuard(() => now)
    const first = guard.tryStart('a')
    expect(first).toBeDefined()
    now = 14 * 60_000
    expect(guard.tryStart('a')).toBeUndefined()
    now = 16 * 60_000
    expect(guard.tryStart('a')).toBeDefined()
  })

  it('keeps an expired holder from releasing a slot its replacement owns', () => {
    let now = 0
    const guard = createResolverGuard(() => now)
    const stale = guard.tryStart('a')!
    now = 16 * 60_000
    const replacement = guard.tryStart('a')!
    stale.release()
    expect(guard.tryStart('a')).toBeUndefined()
    replacement.release()
    expect(guard.tryStart('a')).toBeDefined()
  })
})
