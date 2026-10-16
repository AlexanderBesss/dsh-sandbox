import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ConnectionService } from "../context.ts"
import type { SandboxConfig } from "../config.ts"

export type Respond = (status: number, body: unknown) => void

export interface FailureBody {
  ok: false
  error: { code: string; message: string }
}

export function failure(code: string, message: string): FailureBody {
  return { ok: false, error: { code, message } }
}

export function writeJson(request: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(request.method === "HEAD" ? undefined : payload)
}

export type Authorization =
  | { allowed: true }
  | { allowed: false; status: number; code: string; message: string }

function deny(status: number, code: string, message: string): Authorization {
  return { allowed: false, status, code, message }
}

// sha256 on both sides so timingSafeEqual never compares buffers of different
// lengths, which would leak how long the operator's token is.
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(expected).digest(),
  )
}

// The harness Connection owns request trust and browser authentication: its fence
// pins Host to loopback or trustedHosts and any attached Origin to that Host, then
// requires the signed browser-session cookie. The desktop bridge forwards that
// cookie while stripping Origin, so an absent Origin must stay admissible here.
export function authorize(
  request: IncomingMessage,
  config: SandboxConfig,
  connection?: ConnectionService,
): Authorization {
  const host = request.headers.host
  if (host === undefined) return deny(400, "bad-request", "a Host header is required")
  const token = config.apiToken.get()
  if (token !== "") {
    return tokenMatches(String(request.headers.authorization ?? ""), `Bearer ${token}`)
      ? { allowed: true }
      : deny(401, "unauthorized", "a valid bearer token is required")
  }
  if (connection === undefined) {
    return deny(403, "unauthorized", "the sandbox API needs the harness browser session, or set apiToken to allow scripted access")
  }
  const admission = connection.admit(request)
  if ("rejection" in admission) {
    return admission.rejection === 401
      ? deny(401, "unauthorized", "the sandbox API needs the harness browser session, or set apiToken to allow scripted access")
      : deny(403, "forbidden", "the request Host or Origin is not trusted")
  }
  return { allowed: true }
}

export function requirePost(respond: Respond, action: string, isPost: boolean): boolean {
  if (isPost) return true
  respond(405, failure("method-error", `${action} requires POST`))
  return false
}
