import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createResolverGuard,
  createSubagentRunRegistry,
  handleCancelSubagent,
  handleResolveConflicts,
  handleReview,
  registerStatusRoute,
  subagentViews,
  type StatusDeps,
} from '../src/status.ts'
import type { DurableUserMessage, SandboxContext, SubagentResult, WebRoute } from '../src/context.ts'

const SESSION = 'session-3'
const WORKSPACE = 'F:\\Projects\\dsh-sandbox'
const HOST = '127.0.0.1:19387'

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
const changes = { log: 'abc123 fix', status: '', diff: '+x', truncated: false }
const midMerge = {
  merging: true,
  conflicts: ['src/a.ts'],
  mergingRef: 'abc123456789',
  mergingSubject: 'subject',
  status: 'UU src/a.ts',
  diff: 'diff --git a/src/a.ts b/src/a.ts\n',
  truncated: false,
  diffPathsTruncated: false,
}

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

function idleParent(): { delivered: DurableUserMessage[]; ctx: SandboxContext } {
  const delivered: DurableUserMessage[] = []
  const agent = {
    id: SESSION,
    status: 'idle' as const,
    followup: (message: DurableUserMessage) => void delivered.push(message),
    steer: (message: DurableUserMessage) => void delivered.push(message),
  }
  return { delivered, ctx: { agents: { get: () => agent } } as unknown as SandboxContext }
}

interface Started {
  label?: string
  signal: AbortSignal
}

// Mirrors how the app behaves: the run settles with stopReason "aborted" once
// the signal handed to start fires.
function cancellableSubagents(started: Started[]): () => unknown {
  let children = 0
  return () => ({
    list: () => ['inline'],
    start: async (_provider: string, request: { label?: string; signal: AbortSignal }) => {
      children += 1
      started.push({ label: request.label, signal: request.signal })
      const result = new Promise<SubagentResult>((resolve) => {
        request.signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', output: [] }), { once: true })
      })
      return { localAgent: { session: { id: `child-${children}` } }, result }
    },
  })
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

function reviewDeps(subagents: () => unknown, runs = createSubagentRunRegistry()): StatusDeps {
  return {
    worktrees: { reviewFor: async () => ({ entry: wtEntry, changes }), info: async () => undefined, failureFor: () => undefined },
    runs,
    subagents,
  } as unknown as StatusDeps
}

function resolveDeps(subagents: () => unknown, runs = createSubagentRunRegistry(), resolvers = createResolverGuard()): StatusDeps {
  return {
    worktrees: { conflictsFor: async () => ({ entry: wtEntry, facts: midMerge }) },
    runs,
    resolvers,
    subagents,
  } as unknown as StatusDeps
}

describe('createSubagentRunRegistry', () => {
  it('tracks a started child until its run settles', () => {
    const runs = createSubagentRunRegistry(() => 1000)
    const handle = runs.track(SESSION, 'review', new AbortController(), 'child-1')
    expect(runs.running(SESSION).map((entry) => entry.childSessionId)).toEqual(['child-1'])
    expect(handle.startedAt).toBe(1000)
    runs.release(SESSION, handle)
    expect(runs.running(SESSION)).toEqual([])
  })

  it('aborts only the children of the cancelled kind', () => {
    const runs = createSubagentRunRegistry()
    const review = new AbortController()
    const resolver = new AbortController()
    runs.track(SESSION, 'review', review, 'child-1')
    runs.track(SESSION, 'resolve', resolver, 'child-2')
    const hit = runs.cancel(SESSION, 'review')
    expect(hit.map((entry) => entry.childSessionId)).toEqual(['child-1'])
    expect(review.signal.aborted).toBe(true)
    expect(resolver.signal.aborted).toBe(false)
    expect(runs.running(SESSION).every((entry) => entry.cancelling === (entry.kind === 'review'))).toBe(true)
  })

  it('cancels every child of a session, including several reviews', () => {
    const runs = createSubagentRunRegistry()
    const first = new AbortController()
    const second = new AbortController()
    runs.track(SESSION, 'review', first, 'child-1')
    runs.track(SESSION, 'resolve', second, 'child-2')
    runs.track('other', 'review', new AbortController(), 'child-3')
    expect(runs.cancelAll(SESSION).map((entry) => entry.childSessionId)).toEqual(['child-1', 'child-2'])
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(runs.running('other')).toHaveLength(1)
  })

  it('reports nothing for a session with no children', () => {
    const runs = createSubagentRunRegistry()
    expect(runs.cancel(SESSION, 'review')).toEqual([])
    expect(runs.running(SESSION)).toEqual([])
  })

  it('keeps reporting a cancelled child briefly, then drops one that never settles', () => {
    let now = 0
    const runs = createSubagentRunRegistry(() => now)
    runs.track(SESSION, 'review', new AbortController(), 'child-1')
    runs.cancel(SESSION, 'review')
    now = 59_000
    expect(runs.running(SESSION)).toHaveLength(1)
    now = 61_000
    expect(runs.running(SESSION)).toEqual([])
  })

  it('never drops a child that was not cancelled', () => {
    let now = 0
    const runs = createSubagentRunRegistry(() => now)
    runs.track(SESSION, 'review', new AbortController(), 'child-1')
    now = 20 * 60_000
    expect(runs.running(SESSION)).toHaveLength(1)
  })
})

describe('handleCancelSubagent', () => {
  it('refuses a GET with 405', async () => {
    const { replies, respond } = capture()
    await handleCancelSubagent(respond, reviewDeps(cancellableSubagents([])), SESSION, 'review', false)
    expect(replies[0]!.status).toBe(405)
  })

  it('refuses an unknown kind with 400', async () => {
    const { replies, respond } = capture()
    await handleCancelSubagent(respond, reviewDeps(cancellableSubagents([])), SESSION, undefined, true)
    expect(replies[0]!.status).toBe(400)
    expect(errorCode(replies[0]!.body)).toBe('bad-request')
  })

  it('refuses with 409 when no child of that kind is running', async () => {
    const { replies, respond } = capture()
    await handleCancelSubagent(respond, reviewDeps(cancellableSubagents([])), SESSION, 'review', true)
    expect(replies[0]!.status).toBe(409)
    expect(errorCode(replies[0]!.body)).toBe('no-run')
  })

  it('aborts the running review and answers with its child session', async () => {
    const started: Started[] = []
    const runs = createSubagentRunRegistry()
    const deps = reviewDeps(cancellableSubagents(started), runs)
    const { ctx } = idleParent()
    const { replies, respond } = capture()
    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    await handleCancelSubagent(respond, deps, SESSION, 'review', true)
    expect(replies[1]!.status).toBe(200)
    expect((replies[1]!.body as { data: { cancelled: number } }).data.cancelled).toBe(1)
    expect(started[0]!.signal.aborted).toBe(true)
  })
})

describe('cancelling a review', () => {
  it('stops the child, tells the chat it was stopped, and forgets the run', async () => {
    const started: Started[] = []
    const runs = createSubagentRunRegistry()
    const deps = reviewDeps(cancellableSubagents(started), runs)
    const { delivered, ctx } = idleParent()
    const { replies, respond } = capture()

    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(200)
    await handleCancelSubagent(respond, deps, SESSION, 'review', true)
    await flush()

    expect(started[0]!.signal.aborted).toBe(true)
    const text = delivered[0]!.content.map((block) => block.text ?? '').join('\n')
    expect(text).toContain('code review')
    expect(text).toContain('stopped before it finished')
    expect(runs.running(SESSION)).toEqual([])
  })
})

describe('the review and resolver runs share one registry with the status endpoint', () => {
  it('reports a running review, marks it cancelling, and drops it once it settles', async () => {
    const started: Started[] = []
    const runs = createSubagentRunRegistry()
    const deps = reviewDeps(cancellableSubagents(started), runs)
    const { ctx } = idleParent()
    const { replies, respond } = capture()
    await handleReview(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(runs.running(SESSION).map((entry) => entry.kind)).toEqual(['review'])

    await handleCancelSubagent(respond, deps, SESSION, 'review', true)
    expect(subagentViews(runs.running(SESSION))).toEqual([
      { kind: 'review', childSessionId: 'child-1', startedAt: expect.any(Number), cancelling: true },
    ])

    await flush()
    expect(runs.running(SESSION)).toEqual([])
  })

  it('posts the stopped notice to the chat and frees the worktree for another resolver', async () => {
    const started: Started[] = []
    const runs = createSubagentRunRegistry()
    const resolvers = createResolverGuard()
    const deps = resolveDeps(cancellableSubagents(started), runs, resolvers)
    const { delivered, ctx } = idleParent()
    const { replies, respond } = capture()

    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(replies[0]!.status).toBe(200)
    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(errorCode(replies[1]!.body)).toBe('resolver-running')

    await handleCancelSubagent(respond, deps, SESSION, 'resolve', true)
    await flush()

    const text = delivered[0]!.content.map((block) => block.text ?? '').join('\n')
    expect(text).toContain('conflict resolver')
    expect(text).toContain('stopped before it finished')
    expect(started).toHaveLength(1)

    await handleResolveConflicts(respond, ctx, deps, SESSION, WORKSPACE, true)
    expect(replies[3]!.status).toBe(200)
    expect(started).toHaveLength(2)
  })
})

describe('the cancel-subagent route', () => {
  function dispatch(url: string, deps: StatusDeps, agents: unknown): Promise<{ status: number; body: unknown }> {
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

  it('routes cancel-subagent to the registry instead of to the status endpoint', async () => {
    const started: Started[] = []
    const runs = createSubagentRunRegistry()
    const deps = reviewDeps(cancellableSubagents(started), runs)
    const agents = { get: () => ({ id: SESSION }) }
    const startedAnswer = await dispatch(`/sandbox/api/review?session=${SESSION}`, deps, agents)
    expect(startedAnswer.status).toBe(200)

    const statusAnswer = await dispatch(`/sandbox/api/status?session=${SESSION}`, {
      ...deps,
      provisioner: { status: async () => ({ container: 'dsh-sbx-session-3', image: 'node:24', phase: 'running', ready: true, workspace: WORKSPACE, containerWorkspace: '/workspace', lastUsedAt: 0 }) },
    } as unknown as StatusDeps, agents)
    expect((statusAnswer.body as { data: { subagents: Array<{ kind: string }> } }).data.subagents[0]!.kind).toBe('review')

    const cancelAnswer = await dispatch(`/sandbox/api/cancel-subagent?session=${SESSION}&kind=review`, deps, agents)
    expect(cancelAnswer.status).toBe(200)
    expect(started[0]!.signal.aborted).toBe(true)
  })

  it('answers 400 for a cancel-subagent call with no kind', async () => {
    const answer = await dispatch(`/sandbox/api/cancel-subagent?session=${SESSION}`, reviewDeps(cancellableSubagents([])), { get: () => ({ id: SESSION }) })
    expect(answer.status).toBe(400)
  })
})
