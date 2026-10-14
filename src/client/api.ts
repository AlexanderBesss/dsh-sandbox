export interface WorktreeView {
  path: string
  branch: string
  mainWorkspace: string
  dirty: boolean
  unpushed: boolean
  merging: boolean
  conflicts?: string[]
  behind?: number
  prUrl?: string
}

export type SubagentKind = "review" | "resolve"

export interface SubagentView {
  kind: SubagentKind
  childSessionId: string
  startedAt: number
  cancelling: boolean
}

export interface SubagentChildView {
  parentSessionId: string
  kind: SubagentKind
  startedAt: number
  cancelling: boolean
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
  subagents?: SubagentView[]
  subagentChild?: SubagentChildView
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

async function postAction<T>(path: string, label: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json" },
  })
  const body = (await response.json()) as { ok: true; data: T } | { ok: false; error?: { code?: string; message?: string } }
  if (body.ok !== true) {
    throw new Error(body.error?.message ?? `${label} failed with HTTP ${response.status}`)
  }
  return body.data
}

export function createMergeRequest(sessionId: string): Promise<MergeRequestView> {
  return postAction(`/sandbox/api/merge-request?session=${encodeURIComponent(sessionId)}`, "merge request")
}

export function requestReview(sessionId: string): Promise<ReviewView> {
  return postAction(`/sandbox/api/review?session=${encodeURIComponent(sessionId)}`, "review request")
}

export function resolveConflicts(sessionId: string): Promise<ResolveView> {
  return postAction(`/sandbox/api/resolve-conflicts?session=${encodeURIComponent(sessionId)}`, "conflict resolution")
}

export function cancelSubagent(sessionId: string, kind: SubagentKind): Promise<{ cancelled: number }> {
  return postAction(
    `/sandbox/api/cancel-subagent?session=${encodeURIComponent(sessionId)}&kind=${kind}`,
    `cancelling the ${kind}`,
  )
}

export async function listSandboxContainers(): Promise<{ name: string; phase: string; createdAt?: string }[]> {
  const response = await fetch("/sandbox/api/list", { headers: { accept: "application/json" } })
  const body = (await response.json()) as
    | { ok: true; data: { name: string; phase: string; createdAt?: string }[] }
    | { ok: false; error?: { message?: string } }
  if (body.ok !== true) throw new Error(body.error?.message ?? `sandbox list failed with HTTP ${response.status}`)
  return body.data
}
