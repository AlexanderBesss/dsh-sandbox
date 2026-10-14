import type { IncomingMessage, ServerResponse } from "node:http"
import type { SandboxContext } from "../context.ts"
import { containerNameFor, type SandboxTarget } from "../container/session.ts"
import { SandboxUnavailableError } from "../container/transport.ts"
import {
  handleCancelSubagent,
  handleMergeRequest,
  handleResolveConflicts,
  handleReview,
  subagentKindOf,
  type StatusDeps,
} from "./handlers.ts"
import { failure, sameOrigin, writeJson, type Respond } from "./respond.ts"
import { subagentViews } from "./run-registry.ts"

const ROUTE_PATH = "/sandbox/api"
const ACTION_OFFSET = ROUTE_PATH.length + 1

interface StatusCall {
  respond: Respond
  ctx: SandboxContext
  deps: StatusDeps
  sessionId: string
  workspace: string
  params: URLSearchParams
  isPost: boolean
}

const ACTIONS: ReadonlyMap<string, (call: StatusCall) => Promise<void>> = new Map([
  ["merge-request", ({ respond, deps, sessionId, workspace, isPost }) => handleMergeRequest(respond, deps, sessionId, workspace, isPost)],
  ["review", ({ respond, ctx, deps, sessionId, workspace, isPost }) => handleReview(respond, ctx, deps, sessionId, workspace, isPost)],
  ["resolve-conflicts", ({ respond, ctx, deps, sessionId, workspace, isPost }) => handleResolveConflicts(respond, ctx, deps, sessionId, workspace, isPost)],
  ["cancel-subagent", ({ respond, deps, sessionId, params, isPost }) => handleCancelSubagent(respond, deps, sessionId, subagentKindOf(params.get("kind")), isPost)],
])

async function respondStatus(
  respond: Respond,
  deps: StatusDeps,
  sessionId: string,
  workspace: string,
): Promise<void> {
  const target: SandboxTarget = {
    sessionId,
    container: containerNameFor(sessionId),
    workspace,
    shared: false,
  }
  const status = await deps.provisioner.status(target)
  const worktree = await deps.worktrees?.info(sessionId, workspace)
  const worktreeError = deps.worktrees?.failureFor(sessionId)
  const subagents = subagentViews(deps.runs.running(sessionId))
  const childOf = deps.runs.findByChild(sessionId)
  const extras: Record<string, unknown> = {}
  if (worktree !== undefined) extras.worktree = worktree
  if (worktreeError !== undefined) extras.worktreeError = worktreeError
  if (subagents.length > 0) extras.subagents = subagents
  if (childOf !== undefined) {
    extras.subagentChild = {
      parentSessionId: childOf.sessionId,
      kind: childOf.handle.kind,
      startedAt: childOf.handle.startedAt,
      cancelling: childOf.handle.cancelling,
    }
  }
  respond(200, { ok: true, data: { ...status, ...extras } })
}

export function registerStatusRoute(ctx: SandboxContext, deps: StatusDeps): void {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const isPost = request.method === "POST"
      const respond: Respond = (status, body) => writeJson(request, response, status, body)
      if (!sameOrigin(request)) {
        respond(403, failure("forbidden", "same-origin requests only"))
        return
      }
      if (request.method !== "GET" && request.method !== "HEAD" && !isPost) {
        respond(405, failure("method-error", "method not allowed"))
        return
      }
      const url = new URL(request.url ?? "/", "http://dsh.internal")
      const action = url.pathname.slice(ACTION_OFFSET)

      try {
        if (action === "list") {
          respond(200, { ok: true, data: await deps.provisioner.listOwned() })
          return
        }
        const sessionId = url.searchParams.get("session") ?? ""
        if (sessionId === "") {
          respond(400, failure("bad-request", "a session id is required"))
          return
        }
        const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd
        const workspace = typeof headerCwd === "string" && headerCwd !== "" ? headerCwd : deps.config.workspaceRoot
        const actionHandler = ACTIONS.get(action)
        if (actionHandler === undefined) {
          await respondStatus(respond, deps, sessionId, workspace)
          return
        }
        await actionHandler({ respond, ctx, deps, sessionId, workspace, params: url.searchParams, isPost })
      } catch (error) {
        const code = error instanceof SandboxUnavailableError ? error.code : "unknown"
        respond(500, error instanceof Error ? failure(code, error.message) : { ok: false, error: { code } })
      }
    },
  }), "dsh-docker-sandbox: status route")
}
