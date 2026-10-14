import type { IncomingMessage, ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import type {
  DurableUserMessage,
  SandboxContext,
  SubagentResult,
  SubagentRun,
  SubagentService,
} from "./context.ts"
import type { SandboxConfig } from "./config.ts"
import { PathMapper } from "./container/paths.ts"
import { Provisioner, type SandboxStatus } from "./container/provisioner.ts"
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

function settlementSummary(stopReason: string | undefined): string {
  const subject = "The code review of this session's worktree"
  switch (stopReason) {
    case "completed": return `${subject} finished.`
    case "aborted": return `${subject} was stopped before it finished.`
    case "max-tokens": return `${subject} ran out of room before it finished.`
    case "refusal": return `${subject} declined the task.`
    case "error": return `${subject} failed before it finished.`
    default: return `${subject} ended (${String(stopReason ?? "unknown")}) without reporting a verdict.`
  }
}

export function settlementMessage(childId: string, result: SubagentResult | undefined): DurableUserMessage {
  const summary = settlementSummary(result?.stopReason)
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
        : [{ type: "text", text: "Its review verdict:" }, ...closing.map((block) => ({ type: "text", text: block.text }))]),
    ],
  }
}

export async function settleReviewRun(
  ctx: SandboxContext,
  run: SubagentRun,
  sessionId: string,
  childId: string,
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
    const message = settlementMessage(childId, result)
    if (parent.status === "running" && parent.steer !== undefined) parent.steer(message)
    else parent.followup?.(message)
  } catch {
  }
}

export interface StatusDeps {
  provisioner: Provisioner
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
  subagents?: () => SubagentService | undefined
}

export function registerStatusRoute(ctx: SandboxContext, deps: StatusDeps): void {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/sandbox/api",
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const isPost = request.method === "POST"
      if (!sameOrigin(request)) {
        writeJson(request, response, 403, { ok: false, error: { code: "forbidden", message: "same-origin requests only" } })
        return
      }
      if (request.method !== "GET" && request.method !== "HEAD" && !isPost) {
        writeJson(request, response, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } })
        return
      }
      const url = new URL(request.url ?? "/", "http://dsh.internal")
      const action = url.pathname.slice("/sandbox/api/".length)

      try {
        if (action === "list") {
          writeJson(request, response, 200, { ok: true, data: await deps.provisioner.listOwned() })
          return
        }
        const sessionId = url.searchParams.get("session") ?? ""
        if (sessionId === "") {
          writeJson(request, response, 400, { ok: false, error: { code: "bad-request", message: "a session id is required" } })
          return
        }
        const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd
        const workspace = typeof headerCwd === "string" && headerCwd !== "" ? headerCwd : deps.config.workspaceRoot
        const target: SandboxTarget = {
          sessionId,
          container: containerNameFor(sessionId),
          workspace,
          shared: false,
        }
        const status: SandboxStatus = await deps.provisioner.status(target)
        if (action === "merge-request") {
          if (!isPost) {
            writeJson(request, response, 405, { ok: false, error: { code: "method-error", message: "merge-request requires POST" } })
            return
          }
          if (deps.worktrees === undefined) {
            writeJson(request, response, 409, {
              ok: false,
              error: { code: "worktree-off", message: "worktree mode is disabled, so this session has no branch to merge" },
            })
            return
          }
          const result = await deps.worktrees.mergeRequest(sessionId, workspace)
          writeJson(request, response, 200, { ok: true, data: result })
          return
        }
        if (action === "review") {
          if (!isPost) {
            writeJson(request, response, 405, { ok: false, error: { code: "method-error", message: "review requires POST" } })
            return
          }
          const bundle = deps.worktrees === undefined
            ? undefined
            : await deps.worktrees.reviewFor(sessionId, workspace)
          if (bundle === undefined) {
            writeJson(request, response, 409, {
              ok: false,
              error: { code: "no-worktree", message: "this session has no git worktree to review yet (worktree mode is off, or no tool call has created one)" },
            })
            return
          }
          if (changesAreEmpty(bundle.changes)) {
            writeJson(request, response, 409, {
              ok: false,
              error: { code: "no-changes", message: "this session has made no changes to review" },
            })
            return
          }
          const subagents = deps.subagents?.()
          if (subagents === undefined) {
            writeJson(request, response, 503, {
              ok: false,
              error: { code: "no-subagents", message: "the subagent service is not available" },
            })
            return
          }
          const provider = subagents.list()[0]
          if (provider === undefined) {
            writeJson(request, response, 503, {
              ok: false,
              error: { code: "no-subagents", message: "no subagent provider is registered" },
            })
            return
          }
          const parent = ctx.agents?.get?.(sessionId)
          if (parent === undefined) {
            writeJson(request, response, 409, {
              ok: false,
              error: { code: "no-agent", message: "this session has no live agent to delegate from" },
            })
            return
          }
          const run = await subagents.start(provider, {
            prompt: [{ type: "text", text: buildReviewPrompt(bundle.entry, bundle.changes) }],
            parent,
            signal: new AbortController().signal,
            label: "code review",
          })
          const childSessionId = run.localAgent?.session?.id ?? ""
          void settleReviewRun(ctx, run, sessionId, childSessionId)
          writeJson(request, response, 200, {
            ok: true,
            data: { provider, childSessionId },
          })
          return
        }
        const worktree = await deps.worktrees?.info(sessionId, workspace)
        const worktreeError = deps.worktrees?.failureFor(sessionId)
        writeJson(request, response, 200, {
          ok: true,
          data: {
            ...status,
            ...(worktree === undefined ? {} : { worktree }),
            ...(worktreeError === undefined ? {} : { worktreeError }),
          },
        })
      } catch (error) {
        const code = error instanceof SandboxUnavailableError ? error.code : "unknown"
        writeJson(request, response, 500, { ok: false, error: { code, message: (error as Error).message } })
      }
    },
  }), "dsh-docker-sandbox: status route")
}
