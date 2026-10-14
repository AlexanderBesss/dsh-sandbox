export interface WorktreeView {
  path: string
  branch: string
  mainWorkspace: string
  dirty: boolean
  unpushed: boolean
  merging: boolean
  conflicts?: string[]
  behind?: number
}

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
  worktree?: WorktreeView
  worktreeError?: string
}

export interface MergeRequestView {
  branch: string
  worktreePath: string
  committed: boolean
  pushed: boolean
  remote?: string
  prUrl?: string
  compareUrl?: string
  prError?: string
  renamedFrom?: string
  nameNote?: string
  briefError?: string
}

export interface ReviewView {
  provider: string
  childSessionId?: string
}

export interface ResolveView {
  provider: string
  childSessionId?: string
  conflicts: number
}

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

export async function resolveConflicts(sessionId: string): Promise<ResolveView> {
  const response = await fetch(`/sandbox/api/resolve-conflicts?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { accept: "application/json" },
  })
  const body = (await response.json()) as
    | { ok: true; data: ResolveView }
    | { ok: false; error?: { code?: string; message?: string } }
  if (body.ok !== true) {
    throw new Error(body.error?.message ?? `conflict resolution failed with HTTP ${response.status}`)
  }
  return body.data
}

export async function listSandboxContainers(): Promise<{ name: string; phase: string; createdAt?: string }[]> {
  const response = await fetch("/sandbox/api/list", { headers: { accept: "application/json" } })
  const body = (await response.json()) as
    | { ok: true; data: { name: string; phase: string; createdAt?: string }[] }
    | { ok: false; error?: { message?: string } }
  if (body.ok !== true) throw new Error(body.error?.message ?? `sandbox list failed with HTTP ${response.status}`)
  return body.data
}
