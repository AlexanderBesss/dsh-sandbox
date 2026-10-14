import type { IncomingMessage, ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import type {
  DurableUserMessage,
  LiveAgent,
  SandboxContext,
  SubagentResult,
  SubagentRun,
  SubagentService,
} from "./context.ts"
import type { SandboxConfig } from "./config.ts"
import { PathMapper } from "./container/paths.ts"
import { Provisioner, type SandboxStatus } from "./container/provisioner.ts"
import { buildConflictPrompt } from "./container/conflicts.ts"
import { buildReviewPrompt, changesAreEmpty } from "./container/review.ts"
import { containerNameFor, type SandboxTarget } from "./container/session.ts"
import { SandboxUnavailableError } from "./container/transport.ts"
import type { WorktreeManager } from "./container/worktrees.ts"

function writeJson(request: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(request.method === "HEAD" ? undefined : payload)
}

export function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host
  if (host === undefined) return false
  if (String(request.headers["sec-fetch-site"] ?? "") === "cross-site") return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === "dsh-app:") return true
    return parsed.host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

export interface SettlementKind {
  subject: string
  verdict: string
}

export const REVIEW_SETTLEMENT: SettlementKind = {
  subject: "The code review of this session's worktree",
  verdict: "Its review verdict:",
}

export const CONFLICT_SETTLEMENT: SettlementKind = {
  subject: "The conflict resolver for this session's worktree",
  verdict: "How it resolved the conflicts:",
}

function settlementSummary(stopReason: string | undefined, kind: SettlementKind): string {
  switch (stopReason) {
    case "completed": return `${kind.subject} finished.`
    case "aborted": return `${kind.subject} was stopped before it finished.`
    case "max-tokens": return `${kind.subject} ran out of room before it finished.`
    case "refusal": return `${kind.subject} declined the task.`
    case "error": return `${kind.subject} failed before it finished.`
    default: return `${kind.subject} ended (${String(stopReason ?? "unknown")}) without reporting.`
  }
}

export function settlementMessage(
  childId: string,
  result: SubagentResult | undefined,
  kind: SettlementKind,
): DurableUserMessage {
  const summary = settlementSummary(result?.stopReason, kind)
  const closing = (result?.output ?? []).filter(
    (block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string" && block.text !== "",
  )
  return {
    role: "user",
    id: randomUUID(),
    source: { kind: "subagent-settled", form: "notice", summary, senderSessionId: childId },
    content: [
      { type: "text", text: summary },
      ...(closing.length === 0
        ? [{ type: "text", text: "It left no closing message." }]
        : [{ type: "text", text: kind.verdict }, ...closing.map((block) => ({ type: "text", text: block.text }))]),
    ],
  }
}

export async function settleSubagentRun(
  ctx: SandboxContext,
  run: SubagentRun,
  sessionId: string,
  childId: string,
  kind: SettlementKind,
): Promise<void> {
  let result: SubagentResult | undefined
  try {
    result = await run.result
  } catch {
    result = undefined
  }
  try {
    await run.dispose?.()
  } catch {
  }
  try {
    const parent = ctx.agents?.get?.(sessionId)
    if (parent === undefined) return
    const message = settlementMessage(childId, result, kind)
    if (parent.status === "running" && parent.steer !== undefined) parent.steer(message)
    else parent.followup?.(message)
  } catch {
  }
}

// A resolver mutates the worktree, so only one may run per session at a time.
// The slot expires on its own: a child whose result never settles must not lock
// the button for the rest of the session. A slot releases only its own entry, so
// a resolver that outlived the expiry cannot free whoever replaced it.
const RESOLVER_TTL_MS = 15 * 60_000

export interface ResolverSlot {
  release(): void
}

export interface ResolverGuard {
  tryStart(sessionId: string): ResolverSlot | undefined
}

export function createResolverGuard(now: () => number = Date.now): ResolverGuard {
  const held = new Map<string, ResolverSlot & { expiresAt: number }>()
  return {
    tryStart: (sessionId) => {
      const previous = held.get(sessionId)
      if (previous !== undefined && previous.expiresAt > now()) return undefined
      const slot: ResolverSlot & { expiresAt: number } = {
        expiresAt: now() + RESOLVER_TTL_MS,
        release: () => {
          if (held.get(sessionId) === slot) held.delete(sessionId)
        },
      }
      held.set(sessionId, slot)
      return slot
    },
  }
}

export type SubagentKind = "review" | "resolve"

export interface SubagentHandle {
  kind: SubagentKind
  childSessionId: string
  controller: AbortController
  startedAt: number
  cancelling: boolean
  cancelledAt?: number
}

export interface SubagentView {
  kind: SubagentKind
  childSessionId: string
  startedAt: number
  cancelling: boolean
}

// A started child is kept here so the header pill can offer to stop it: the
// subagent service only cancels a run through the AbortSignal handed to start,
// so the controller has to outlive the request that started the run. Entries
// leave when the run settles, which an abort also causes.
// A child that ignores the abort and never settles would otherwise pin the pill
// in "stopping…" for the rest of the session, so a cancelled entry stops being
// reported after this much time — the same escape the resolver slot has.
const CANCEL_REPORT_TTL_MS = 60_000

export interface SubagentRunRegistry {
  track(sessionId: string, kind: SubagentKind, controller: AbortController, childSessionId: string): SubagentHandle
  release(sessionId: string, handle: SubagentHandle): void
  running(sessionId: string): SubagentHandle[]
  cancel(sessionId: string, kind: SubagentKind): SubagentHandle[]
  cancelAll(sessionId: string): SubagentHandle[]
  findByChild(childSessionId: string): { sessionId: string; handle: SubagentHandle } | undefined
}

export function createSubagentRunRegistry(now: () => number = Date.now): SubagentRunRegistry {
  const running = new Map<string, Set<SubagentHandle>>()
  const abortMatching = (sessionId: string, matches: (handle: SubagentHandle) => boolean): SubagentHandle[] => {
    const held = running.get(sessionId)
    if (held === undefined) return []
    const hit = [...held].filter(matches)
    for (const handle of hit) {
      handle.cancelling = true
      handle.cancelledAt = now()
      handle.controller.abort()
    }
    return hit
  }
  return {
    track: (sessionId, kind, controller, childSessionId) => {
      const handle: SubagentHandle = { kind, childSessionId, controller, startedAt: now(), cancelling: false }
      const held = running.get(sessionId) ?? new Set<SubagentHandle>()
      held.add(handle)
      running.set(sessionId, held)
      return handle
    },
    release: (sessionId, handle) => {
      const held = running.get(sessionId)
      if (held === undefined) return
      held.delete(handle)
      if (held.size === 0) running.delete(sessionId)
    },
    running: (sessionId) => [...(running.get(sessionId) ?? [])].filter(
      (handle) => handle.cancelledAt === undefined || now() - handle.cancelledAt <= CANCEL_REPORT_TTL_MS,
    ),
    cancel: (sessionId, kind) => abortMatching(sessionId, (handle) => handle.kind === kind),
    cancelAll: (sessionId) => abortMatching(sessionId, () => true),
    findByChild: (childSessionId) => {
      for (const [sessionId, held] of running) {
        for (const handle of held) {
          if (handle.childSessionId !== childSessionId) continue
          if (handle.cancelledAt !== undefined && now() - handle.cancelledAt > CANCEL_REPORT_TTL_MS) continue
          return { sessionId, handle }
        }
      }
      return undefined
    },
  }
}

export function subagentViews(handles: SubagentHandle[]): SubagentView[] {
  return handles.map((handle) => ({
    kind: handle.kind,
    childSessionId: handle.childSessionId,
    startedAt: handle.startedAt,
    cancelling: handle.cancelling,
  }))
}

export interface StatusDeps {
  provisioner: Provisioner
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
  subagents?: () => SubagentService | undefined
  resolvers: ResolverGuard
  runs: SubagentRunRegistry
}

type Respond = (status: number, body: unknown) => void

export async function handleMergeRequest(
  respond: Respond,
  deps: StatusDeps,
  sessionId: string,
  workspace: string,
  isPost: boolean,
): Promise<void> {
  if (!isPost) {
    respond(405, { ok: false, error: { code: "method-error", message: "merge-request requires POST" } })
    return
  }
  if (deps.worktrees === undefined) {
    respond(409, {
      ok: false,
      error: { code: "worktree-off", message: "worktree mode is disabled, so this session has no branch to merge" },
    })
    return
  }
  const result = await deps.worktrees.mergeRequest(sessionId, workspace)
  respond(200, { ok: true, data: result })
}

interface SubagentLaunch {
  subagents: SubagentService
  provider: string
  parent: LiveAgent
}

function subagentLaunch(
  respond: Respond,
  ctx: SandboxContext,
  deps: StatusDeps,
  sessionId: string,
): SubagentLaunch | undefined {
  const subagents = deps.subagents?.()
  const provider = subagents?.list()[0]
  if (subagents === undefined || provider === undefined) {
    respond(503, {
      ok: false,
      error: {
        code: "no-subagents",
        message: subagents === undefined ? "the subagent service is not available" : "no subagent provider is registered",
      },
    })
    return undefined
  }
  const parent = ctx.agents?.get?.(sessionId)
  if (parent === undefined) {
    respond(409, {
      ok: false,
      error: { code: "no-agent", message: "this session has no live agent to delegate from" },
    })
    return undefined
  }
  return { subagents, provider, parent }
}

export async function handleReview(
  respond: Respond,
  ctx: SandboxContext,
  deps: StatusDeps,
  sessionId: string,
  workspace: string,
  isPost: boolean,
): Promise<void> {
  if (!isPost) {
    respond(405, { ok: false, error: { code: "method-error", message: "review requires POST" } })
    return
  }
  const bundle = deps.worktrees === undefined
    ? undefined
    : await deps.worktrees.reviewFor(sessionId, workspace)
  if (bundle === undefined) {
    respond(409, {
      ok: false,
      error: { code: "no-worktree", message: "this session has no git worktree to review yet (worktree mode is off, or no tool call has created one)" },
    })
    return
  }
  if (changesAreEmpty(bundle.changes)) {
    respond(409, {
      ok: false,
      error: { code: "no-changes", message: "this session has made no changes to review" },
    })
    return
  }
  const launch = subagentLaunch(respond, ctx, deps, sessionId)
  if (launch === undefined) return
  const controller = new AbortController()
  const run = await launch.subagents.start(launch.provider, {
    prompt: [{ type: "text", text: buildReviewPrompt(bundle.entry, bundle.changes) }],
    parent: launch.parent,
    signal: controller.signal,
    label: "code review",
  })
  const childSessionId = run.localAgent?.session?.id ?? ""
  const handle = deps.runs.track(sessionId, "review", controller, childSessionId)
  void settleSubagentRun(ctx, run, sessionId, childSessionId, REVIEW_SETTLEMENT)
    .finally(() => deps.runs.release(sessionId, handle))
  respond(200, { ok: true, data: { provider: launch.provider, childSessionId } })
}

export async function handleResolveConflicts(
  respond: Respond,
  ctx: SandboxContext,
  deps: StatusDeps,
  sessionId: string,
  workspace: string,
  isPost: boolean,
): Promise<void> {
  if (!isPost) {
    respond(405, { ok: false, error: { code: "method-error", message: "resolve-conflicts requires POST" } })
    return
  }
  if (deps.worktrees === undefined) {
    respond(409, {
      ok: false,
      error: { code: "worktree-off", message: "worktree mode is disabled, so this session has no merge to resolve" },
    })
    return
  }
  const bundle = await deps.worktrees.conflictsFor(sessionId, workspace)
  if (bundle === undefined) {
    respond(409, {
      ok: false,
      error: { code: "no-worktree", message: "this session has no git worktree to resolve conflicts in (worktree mode is off, or no tool call has created one)" },
    })
    return
  }
  if (!bundle.facts.merging) {
    respond(409, {
      ok: false,
      error: { code: "no-conflicts", message: "this session's worktree is not mid-merge, so there is nothing to resolve" },
    })
    return
  }
  const launch = subagentLaunch(respond, ctx, deps, sessionId)
  if (launch === undefined) return
  if (launch.parent.status === "running") {
    respond(409, {
      ok: false,
      error: {
        code: "agent-busy",
        message: "the conversation's agent is mid-turn and may already be resolving these markers; wait for its turn to end, then click again",
      },
    })
    return
  }
  const slot = deps.resolvers.tryStart(sessionId)
  if (slot === undefined) {
    respond(409, {
      ok: false,
      error: { code: "resolver-running", message: "a resolver is already working on this worktree; its report lands in the chat when it finishes" },
    })
    return
  }
  let run: SubagentRun
  const controller = new AbortController()
  try {
    run = await launch.subagents.start(launch.provider, {
      prompt: [{ type: "text", text: buildConflictPrompt(bundle.entry, bundle.facts) }],
      parent: launch.parent,
      signal: controller.signal,
      label: "conflict resolution",
    })
  } catch (error) {
    slot.release()
    throw error
  }
  const childSessionId = run.localAgent?.session?.id ?? ""
  const handle = deps.runs.track(sessionId, "resolve", controller, childSessionId)
  void settleSubagentRun(ctx, run, sessionId, childSessionId, CONFLICT_SETTLEMENT)
    .finally(() => {
      deps.runs.release(sessionId, handle)
      slot.release()
    })
  respond(200, { ok: true, data: { provider: launch.provider, childSessionId, conflicts: bundle.facts.conflicts.length } })
}

const CANCEL_LABEL: Record<SubagentKind, string> = {
  review: "review",
  resolve: "resolver",
}

export function subagentKindOf(value: string | null): SubagentKind | undefined {
  return value === "review" || value === "resolve" ? value : undefined
}

export async function handleCancelSubagent(
  respond: Respond,
  deps: StatusDeps,
  sessionId: string,
  kind: SubagentKind | undefined,
  isPost: boolean,
): Promise<void> {
  if (!isPost) {
    respond(405, { ok: false, error: { code: "method-error", message: "cancel-subagent requires POST" } })
    return
  }
  if (kind === undefined) {
    respond(400, { ok: false, error: { code: "bad-request", message: "kind must be review or resolve" } })
    return
  }
  const handles = deps.runs.cancel(sessionId, kind)
  if (handles.length === 0) {
    respond(409, {
      ok: false,
      error: { code: "no-run", message: `no ${CANCEL_LABEL[kind]} is running for this session` },
    })
    return
  }
  respond(200, {
    ok: true,
    data: { cancelled: handles.length, childSessionIds: handles.map((handle) => handle.childSessionId) },
  })
}

export function registerStatusRoute(ctx: SandboxContext, deps: StatusDeps): void {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/sandbox/api",
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const isPost = request.method === "POST"
      const respond: Respond = (status, body) => writeJson(request, response, status, body)
      if (!sameOrigin(request)) {
        respond(403, { ok: false, error: { code: "forbidden", message: "same-origin requests only" } })
        return
      }
      if (request.method !== "GET" && request.method !== "HEAD" && !isPost) {
        respond(405, { ok: false, error: { code: "method-error", message: "method not allowed" } })
        return
      }
      const url = new URL(request.url ?? "/", "http://dsh.internal")
      const action = url.pathname.slice("/sandbox/api/".length)

      try {
        if (action === "list") {
          respond(200, { ok: true, data: await deps.provisioner.listOwned() })
          return
        }
        const sessionId = url.searchParams.get("session") ?? ""
        if (sessionId === "") {
          respond(400, { ok: false, error: { code: "bad-request", message: "a session id is required" } })
          return
        }
        const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd
        const workspace = typeof headerCwd === "string" && headerCwd !== "" ? headerCwd : deps.config.workspaceRoot

        if (action === "merge-request") {
          await handleMergeRequest(respond, deps, sessionId, workspace, isPost)
          return
        }
        if (action === "review") {
          await handleReview(respond, ctx, deps, sessionId, workspace, isPost)
          return
        }
        if (action === "resolve-conflicts") {
          await handleResolveConflicts(respond, ctx, deps, sessionId, workspace, isPost)
          return
        }
        if (action === "cancel-subagent") {
          await handleCancelSubagent(respond, deps, sessionId, subagentKindOf(url.searchParams.get("kind")), isPost)
          return
        }
        const target: SandboxTarget = {
          sessionId,
          container: containerNameFor(sessionId),
          workspace,
          shared: false,
        }
        const status: SandboxStatus = await deps.provisioner.status(target)
        const worktree = await deps.worktrees?.info(sessionId, workspace)
        const worktreeError = deps.worktrees?.failureFor(sessionId)
        const subagents = subagentViews(deps.runs.running(sessionId))
        const childOf = deps.runs.findByChild(sessionId)
        respond(200, {
          ok: true,
          data: {
            ...status,
            ...(worktree === undefined ? {} : { worktree }),
            ...(worktreeError === undefined ? {} : { worktreeError }),
            ...(subagents.length === 0 ? {} : { subagents }),
            ...(childOf === undefined
              ? {}
              : {
                  subagentChild: {
                    parentSessionId: childOf.sessionId,
                    kind: childOf.handle.kind,
                    startedAt: childOf.handle.startedAt,
                    cancelling: childOf.handle.cancelling,
                  },
                }),
          },
        })
      } catch (error) {
        const code = error instanceof SandboxUnavailableError ? error.code : "unknown"
        respond(500, { ok: false, error: { code, message: (error as Error).message } })
      }
    },
  }), "dsh-docker-sandbox: status route")
}
