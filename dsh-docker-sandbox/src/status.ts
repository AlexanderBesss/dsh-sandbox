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
import type { SandboxContext } from "./context.ts"
import type { SandboxConfig } from "./config.ts"
import { PathMapper } from "./container/paths.ts"
import { Provisioner, type SandboxStatus } from "./container/provisioner.ts"
import { containerNameFor, type SandboxTarget } from "./container/session.ts"
import { SandboxUnavailableError } from "./container/transport.ts"

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
 * A request with no `Origin` header (curl, a form GET) passes: the endpoint is
 * read-only and names nothing an attacker could act on beyond container names,
 * so the guard is about the browser-driven chip, not a hard auth boundary.
 * The comparison is the full host (name *and* port): another app on the same
 * host but a different port is a different origin and gets refused.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host
  if (host === undefined) return false
  if (String(request.headers["sec-fetch-site"] ?? "") === "cross-site") return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

export interface StatusDeps {
  provisioner: Provisioner
  paths: PathMapper
  config: SandboxConfig
}

/** Register `/sandbox/api/*` and dispose it with the plugin fiber. */
export function registerStatusRoute(ctx: SandboxContext, deps: StatusDeps): void {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/sandbox/api",
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (!sameOrigin(request)) {
        writeJson(request, response, 403, { ok: false, error: { code: "forbidden", message: "same-origin requests only" } })
        return
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
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
        const target: SandboxTarget = {
          sessionId,
          container: containerNameFor(sessionId),
          workspace: typeof headerCwd === "string" && headerCwd !== "" ? headerCwd : deps.config.workspaceRoot,
          shared: false,
        }
        const status: SandboxStatus = await deps.provisioner.status(target)
        writeJson(request, response, 200, { ok: true, data: status })
      } catch (error) {
        const code = error instanceof SandboxUnavailableError ? error.code : "unknown"
        writeJson(request, response, 500, { ok: false, error: { code, message: (error as Error).message } })
      }
    },
  }), "dsh-docker-sandbox: status route")
}
