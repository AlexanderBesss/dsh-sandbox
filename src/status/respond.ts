import type { IncomingMessage, ServerResponse } from "node:http"

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

export function requirePost(respond: Respond, action: string, isPost: boolean): boolean {
  if (isPost) return true
  respond(405, failure("method-error", `${action} requires POST`))
  return false
}
