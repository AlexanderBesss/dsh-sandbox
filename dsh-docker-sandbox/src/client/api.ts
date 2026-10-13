/**
 * The client half: a chip in the session header naming the container this chat
 * runs in.
 *
 * The host owns the engine; the client only reads `/sandbox/api`, so the chip
 * works even when Docker is down — it reports that instead of disappearing.
 *
 * @module dsh-docker-sandbox/client
 */

/** What `/sandbox/api/status` returns for one conversation. */
export interface SandboxStatusView {
  container: string
  image: string
  phase: string
  ready: boolean
  workspace: string
  containerWorkspace: string
  createdAt?: string
  lastUsedAt: number
  error?: string
}

/** One JSON call to the plugin's status route. */
export async function fetchSandboxStatus(sessionId: string): Promise<SandboxStatusView> {
  const response = await fetch(`/sandbox/api/status?session=${encodeURIComponent(sessionId)}`, {
    headers: { accept: "application/json" },
  })
  const body = (await response.json()) as
    | { ok: true; data: SandboxStatusView }
    | { ok: false; error?: { code?: string; message?: string } }
  if (body.ok !== true) {
    throw new Error(body.error?.message ?? `sandbox status failed with HTTP ${response.status}`)
  }
  return body.data
}

/** Every sandbox container the plugin owns. */
export async function listSandboxContainers(): Promise<{ name: string; phase: string; createdAt?: string }[]> {
  const response = await fetch("/sandbox/api/list", { headers: { accept: "application/json" } })
  const body = (await response.json()) as
    | { ok: true; data: { name: string; phase: string; createdAt?: string }[] }
    | { ok: false; error?: { message?: string } }
  if (body.ok !== true) throw new Error(body.error?.message ?? `sandbox list failed with HTTP ${response.status}`)
  return body.data
}
