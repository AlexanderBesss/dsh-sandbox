import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleMergeRequest, handleResolveConflicts, handleReview, authorize, createResolverGuard, createSubagentRunRegistry, registerStatusRoute, type StatusDeps } from '../src/status.ts'
import type { SandboxConfig } from '../src/config.ts'
import type { ConnectionAdmission, ConnectionService } from '../src/context.ts'
import { testConfig } from './helpers.ts'
import type { SandboxContext, WebRoute } from '../src/context.ts'

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage
}

const HOST = '127.0.0.1:19387'

function configStub(apiToken = ''): SandboxConfig {
  return testConfig({ apiToken })
}

function connectionStub(admit: (request: IncomingMessage) => ConnectionAdmission): ConnectionService {
  return { admit }
}

const admitted = connectionStub(() => ({ peer: {} }))

function fenceRejects(status: number): ConnectionService {
  return connectionStub(() => ({ rejection: status }))
}

function denyCode(headers: Record<string, string>, config = configStub(), connection = admitted): string {
  const decision = authorize(request(headers), config, connection)
  return decision.allowed ? '' : decision.code
}

function denyStatus(headers: Record<string, string>, config = configStub(), connection = admitted): number {
  const decision = authorize(request(headers), config, connection)
  return decision.allowed ? 0 : decision.status
}

describe('authorize', () => {
  it('refuses a request with no Host header', () => {
    expect(denyCode({ origin: `http://${HOST}` })).toBe('bad-request')
  })

  it('accepts the desktop bridge shape: no Origin, admitted by the harness session', () => {
    expect(denyCode({ host: HOST })).toBe('')
  })

  it('accepts a web-profile request the harness admits', () => {
    expect(denyCode({ host: HOST, origin: `http://${HOST}`, cookie: 'dsh-session=sig' })).toBe('')
  })

  it('refuses what the harness fence rejects on Host or Origin', () => {
    expect(denyCode({ host: 'evil.example', origin: 'http://evil.example' }, configStub(), fenceRejects(403))).toBe('forbidden')
    expect(denyStatus({ host: 'evil.example' }, configStub(), fenceRejects(403))).toBe(403)
  })

  it('refuses a request without the signed browser session', () => {
    expect(denyCode({ host: HOST }, configStub(), fenceRejects(401))).toBe('unauthorized')
    expect(denyStatus({ host: HOST }, configStub(), fenceRejects(401))).toBe(401)
  })

  it('refuses when the composition provides no harness connection to admit through', () => {
    const decision = authorize(request({ host: HOST, origin: `http://${HOST}` }), configStub(), undefined)
    expect(decision.allowed ? '' : decision.code).toBe('unauthorized')
  })

  it('accepts an Origin-less scripted call that carries the bearer token', () => {
    expect(denyCode({ host: HOST, authorization: 'Bearer s3cret' }, configStub('s3cret'), fenceRejects(401))).toBe('')
  })

  it('refuses a wrong, short, or missing bearer token', () => {
    expect(denyCode({ host: HOST, authorization: 'Bearer s3cre' }, configStub('s3cret'))).toBe('unauthorized')
    expect(denyCode({ host: HOST, authorization: 'Bearer secret-sauce' }, configStub('s3cret'))).toBe('unauthorized')
    expect(denyCode({ host: HOST, authorization: 's3cret' }, configStub('s3cret'))).toBe('unauthorized')
    expect(denyCode({ host: HOST, origin: `http://${HOST}` }, configStub('s3cret'))).toBe('unauthorized')
  })

  it('never consults the harness session once the token matches', () => {
    const never = connectionStub(() => {
      throw new Error('admit must not run when a token is configured')
    })
    expect(denyCode({ host: HOST, origin: 'https://evil.example', authorization: 'Bearer s3cret' }, configStub('s3cret'), never)).toBe('')
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

  function depsFor(
    bundle: unknown,
    subagents?: () => unknown,
    runs = createSubagentRunRegistry(),
    resolvers = createResolverGuard(),
  ): StatusDeps {
    return {
      worktrees: { reviewFor: async () => bundle },
      resolvers,
      runs,
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

  it('refuses a second review while one is already running', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    let starts = 0
    const subagents = () => ({
      list: () => ['inline'],
      start: async () => {
        starts += 1
        return { localAgent: { session: { id: `child-${starts}` } }, result: new Promise<never>(() => {}) }
      },
    })
    const deps = depsFor({ entry, changes }, subagents)
    const { replies, respond } = capture()
    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(starts).toBe(1)
    expect(replies[0]!.status).toBe(200)
    expect(replies[1]!.status).toBe(409)
    expect(errorCode(replies[1]!.body)).toBe('review-running')
  })

  it('frees the review slot once the first review settles', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    let starts = 0
    const subagents = () => ({
      list: () => ['inline'],
      start: async () => {
        starts += 1
        return {
          localAgent: { session: { id: `child-${starts}` } },
          result: Promise.resolve({ stopReason: 'completed', output: [] }),
        }
      },
    })
    const deps = depsFor({ entry, changes }, subagents)
    const { replies, respond } = capture()
    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(starts).toBe(2)
    expect(replies[1]!.status).toBe(200)
  })

  it('a review slot and a resolver slot do not block each other', async () => {
    const ctx = { agents: { get: () => ({ id: SESSION }) } } as unknown as SandboxContext
    let starts = 0
    const subagents = () => ({
      list: () => ['inline'],
      start: async () => {
        starts += 1
        return { localAgent: { session: { id: `child-${starts}` } }, result: new Promise<never>(() => {}) }
      },
    })
    const deps = {
      worktrees: {
        reviewFor: async () => ({ entry, changes }),
        conflictsFor: async () => ({ entry: wtEntry, facts: midMerge }),
      },
      resolvers: createResolverGuard(),
      runs: createSubagentRunRegistry(),
      subagents,
    } as unknown as StatusDeps
    const { replies, respond } = capture()
    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(200)
    expect(replies[1]!.status).toBe(200)
    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(starts).toBe(2)
    expect(errorCode(replies[2]!.body)).toBe('review-running')
    expect(errorCode(replies[3]!.body)).toBe('resolver-running')
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

function resolveDepsFor(
  bundle: unknown,
  subagents?: () => unknown,
  resolvers = createResolverGuard(),
  runs = createSubagentRunRegistry(),
  config = configStub(),
  connection = admitted,
): StatusDeps {
  return {
    config,
    connection,
    worktrees: { conflictsFor: async () => bundle, lookup: () => undefined },
    resolvers,
    runs,
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
    headers: Record<string, string> = { host: HOST, origin: `http://${HOST}` },
    sessions: (id: string) => unknown = (id) => (id === SESSION ? { id: SESSION, header: { cwd: WORKSPACE } } : undefined),
    archived?: readonly string[],
  ): Promise<{ status: number; body: unknown }> {
    let handler: WebRoute['handler'] | undefined
    const ctx = {
      effect: (run: () => void) => run(),
      webServer: { register: (route: WebRoute) => { handler = route.handler; return () => {} } },
      sessions: { get: sessions },
      ...(archived === undefined ? {} : { get: (name: string) => (name === 'workspaceRegistry' ? { archivedSessionIds: archived } : undefined) }),
      agents,
    } as unknown as SandboxContext
    registerStatusRoute(ctx, deps)
    const request = { method: 'POST', url, headers } as IncomingMessage
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

  function resolverStarted(counter: { starts: number; child: string }) {
    return () => ({
      list: () => ['inline'],
      start: async () => {
        counter.starts += 1
        return {
          localAgent: { session: { id: counter.child } },
          result: Promise.resolve({ stopReason: 'completed', output: [] }),
        }
      },
    })
  }

  it('runs the action for an Origin-less POST once the harness admits the session', async () => {
    const counter = { starts: 0, child: 'child-1' }
    const deps = resolveDepsFor({ entry: wtEntry, facts: midMerge }, resolverStarted(counter))
    const answer = await dispatch(
      `/sandbox/api/resolve-conflicts?session=${SESSION}`,
      deps,
      { get: () => ({ id: SESSION }) },
      { host: HOST },
    )
    expect(answer.status).toBe(200)
    expect(counter.starts).toBe(1)
  })

  it('refuses an action naming a session the harness does not know', async () => {
    const counter = { starts: 0, child: 'child-1' }
    const deps = resolveDepsFor({ entry: wtEntry, facts: midMerge }, resolverStarted(counter))
    const answer = await dispatch('/sandbox/api/resolve-conflicts?session=stranger', deps, { get: () => ({ id: SESSION }) })
    expect(answer.status).toBe(404)
    expect(errorCode(answer.body)).toBe('unknown-session')
    expect(counter.starts).toBe(0)
  })

  it('refuses a status request naming a session the harness does not know', async () => {
    const deps = resolveDepsFor({ entry: wtEntry, facts: midMerge })
    const answer = await dispatch('/sandbox/api?session=stranger', deps, { get: () => ({ id: SESSION }) })
    expect(answer.status).toBe(404)
    expect(errorCode(answer.body)).toBe('unknown-session')
  })

  it('admits an archived chat through the session guard', async () => {
    const counter = { starts: 0, child: 'child-1' }
    const deps = resolveDepsFor({ entry: wtEntry, facts: midMerge }, resolverStarted(counter))
    const answer = await dispatch(
      '/sandbox/api/resolve-conflicts?session=archived-1',
      deps,
      { get: () => ({ id: SESSION }) },
      { host: HOST, origin: `http://${HOST}` },
      () => undefined,
      ['archived-1'],
    )
    expect(answer.status).toBe(200)
    expect(counter.starts).toBe(1)
  })

  it('admits a session whose registered worktree is the only trace of it', async () => {
    const counter = { starts: 0, child: 'child-1' }
    const deps = {
      ...resolveDepsFor({ entry: wtEntry, facts: midMerge }, resolverStarted(counter)),
      worktrees: {
        conflictsFor: async () => ({ entry: wtEntry, facts: midMerge }),
        lookup: () => ({ sessionId: 'child-9', mainWorkspace: WORKSPACE }),
      },
    } as unknown as StatusDeps
    const answer = await dispatch(
      '/sandbox/api/resolve-conflicts?session=child-9',
      deps,
      { get: () => ({ id: SESSION }) },
      { host: HOST, origin: `http://${HOST}` },
      () => undefined,
    )
    expect(answer.status).toBe(200)
    expect(counter.starts).toBe(1)
  })

  it('refuses an Origin-less POST at the gate when the harness session is missing', async () => {
    const counter = { starts: 0, child: 'child-1' }
    const deps = resolveDepsFor(
      { entry: wtEntry, facts: midMerge },
      resolverStarted(counter),
      createResolverGuard(),
      createSubagentRunRegistry(),
      configStub(),
      fenceRejects(401),
    )
    const answer = await dispatch(
      `/sandbox/api/resolve-conflicts?session=${SESSION}`,
      deps,
      { get: () => ({ id: SESSION }) },
      { host: HOST },
    )
    expect(answer.status).toBe(401)
    expect(errorCode(answer.body)).toBe('unauthorized')
    expect(counter.starts).toBe(0)
  })

  it('runs the action for an Origin-less POST once a token is configured', async () => {
    const counter = { starts: 0, child: 'child-9' }
    const deps = resolveDepsFor(
      { entry: wtEntry, facts: midMerge },
      resolverStarted(counter),
      createResolverGuard(),
      createSubagentRunRegistry(),
      configStub('s3cret'),
    )
    const answer = await dispatch(
      `/sandbox/api/resolve-conflicts?session=${SESSION}`,
      deps,
      { get: () => ({ id: SESSION }) },
      { host: HOST, authorization: 'Bearer s3cret' },
    )
    expect(answer.status).toBe(200)
    expect(counter.starts).toBe(1)
    expect((answer.body as { data: { childSessionId: string } }).data.childSessionId).toBe('child-9')
  })
})

describe('createResolverGuard', () => {
  it('holds one slot per key until it is released', () => {
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
