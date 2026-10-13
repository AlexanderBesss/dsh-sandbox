/**
 * The status route the session header chip reads.
 *
 * The chip has to answer "which container is this chat running in?" without
 * waiting for a tool call, so the plugin exposes one small read-only endpoint
 * over the app's embedded web server. It is same-origin and read-only: it
 * names the container, its state, and its workspace, and nothing else.
 *
 * @module dsh-docker-sandbox/status
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { SandboxContext, SubagentService } from "./context.ts"
import type { SandboxConfig } from "./config.ts"
import { PathMapper } from "./container/paths.ts"
import { Provisioner, type SandboxStatus } from "./container/provisioner.ts"
import { buildReviewPrompt, changesAreEmpty } from "./container/review.ts"
import { containerNameFor, type SandboxTarget } from "./container/session.ts"
import { SandboxUnavailableError } from "./container/transport.ts"
import type { WorktreeManager } from "./container/worktrees.ts"

/** One JSON reply, written and closed. HEAD gets headers only. */
function writeJson(request: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(request.method === "HEAD" ? undefined : payload)
}

/**
 * Reject cross-site requests.
 *
 * The comparison is the full host (name *and* port): another app on the same
 * host but a different port is a different origin and gets refused. The app's
 * own renderer lives on the `dsh-app:` scheme and its fetches are bridged to
 * this server carrying that origin (or, depending on the bridge, none), so a
 * `dsh-app:` origin always passes and a missing `Origin` passes as well:
 * browsers attach `Origin` to every POST, so a POST that reaches this route
 * without one came from the bridge or from a local non-browser client - never
 * from a cross-site web page, which is the only thing a CSRF guard can act
 * on. A cross-site web page cannot forge or omit `Origin`, and `Sec-Fetch-Site`
 * is checked first when the client reports it.
 */
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

export interface StatusDeps {
  provisioner: Provisioner
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
  /** The subagent service, once the deferred inject has seen it. */
  subagents?: () => SubagentService | undefined
}

/** Register `/sandbox/api/*` and dispose it with the plugin fiber. */
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
        // The workspace comes from the session store, not the request: the chip
        // must not be able to ask about an arbitrary directory.
        const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd
        const workspace = typeof headerCwd === "string" && headerCwd !== "" ? headerCwd : deps.config.workspaceRoot
        // The raw checkout, not the worktree: the provisioner reports the
        // container it actually has, and the worktree rides along below.
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
          // Fire-and-forget: `start` resolves when the child's inbox accepts
          // the prompt, not when the review finishes. The signal never
          // aborts, so the reviewer runs to completion on its own.
          const run = await subagents.start(provider, {
            prompt: [{ type: "text", text: buildReviewPrompt(bundle.entry, bundle.changes) }],
            parent,
            signal: new AbortController().signal,
            label: "code review",
          })
          writeJson(request, response, 200, {
            ok: true,
            data: { provider, childSessionId: run.localAgent?.session?.id },
          })
          return
        }
        // Read-only peek: opening a chat never runs `git worktree add`.
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
