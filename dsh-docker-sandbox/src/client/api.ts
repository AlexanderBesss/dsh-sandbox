/**
 * The client half: a chip in the session header naming the container this chat
 * runs in.
 *
 * The host owns the engine; the client only reads `/sandbox/api`, so the chip
 * works even when Docker is down — it reports that instead of disappearing.
 *
 * @module dsh-docker-sandbox/client
 */

/** What the session-header button and tooltip show about one worktree. */
export interface WorktreeView {
  path: string
  branch: string
  mainWorkspace: string
  dirty: boolean
  unpushed: boolean
}

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
  /** Present when worktree mode gave this chat its own checkout. */
  worktree?: WorktreeView
  /** Present when worktree creation failed, with the reason. */
  worktreeError?: string
}

/** What `/sandbox/api/merge-request` returns. */
export interface MergeRequestView {
  branch: string
  worktreePath: string
  committed: boolean
  pushed: boolean
  remote?: string
  prUrl?: string
  compareUrl?: string
  /** Why no pull request was opened (gh missing, unauthenticated, …). */
  prError?: string
  /** The branch was renamed to this request's name before pushing. */
  renamedFrom?: string
  /** Why the branch kept its name when the naming pass proposed another. */
  nameNote?: string
  /** Why there was no naming pass (no subagent service, timeout, …). */
  briefError?: string
}

/** What `/sandbox/api/review` returns. */
export interface ReviewView {
  provider: string
  childSessionId?: string
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

/**
 * Commit the session's worktree, push its branch, and open a pull request.
 *
 * POST because it changes state; the route requires a same-origin `Origin`,
 * which the browser attaches on its own.
 */
export async function createMergeRequest(sessionId: string): Promise<MergeRequestView> {
  const response = await fetch(`/sandbox/api/merge-request?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { accept: "application/json" },
  })
  const body = (await response.json()) as
    | { ok: true; data: MergeRequestView }
    | { ok: false; error?: { code?: string; message?: string } }
  if (body.ok !== true) {
    throw new Error(body.error?.message ?? `merge request failed with HTTP ${response.status}`)
  }
  return body.data
}

/**
 * Spawn a fresh review subagent for the session's worktree changes.
 *
 * The subagent starts with no memory of this conversation: the route hands it
 * the collected diff and lets it verify with its own tools. POST because it
 * starts work; the route requires the browser's same-origin `Origin`.
 */
export async function requestReview(sessionId: string): Promise<ReviewView> {
  const response = await fetch(`/sandbox/api/review?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { accept: "application/json" },
  })
  const body = (await response.json()) as
    | { ok: true; data: ReviewView }
    | { ok: false; error?: { code?: string; message?: string } }
  if (body.ok !== true) {
    throw new Error(body.error?.message ?? `review request failed with HTTP ${response.status}`)
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
