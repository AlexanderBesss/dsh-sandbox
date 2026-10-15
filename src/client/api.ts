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

interface ApiError {
  code?: string
  message?: string
}

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error?: ApiError }

async function requestJson<T>(path: string, label: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" }, ...init })
  const body = (await response.json()) as ApiEnvelope<T>
  if (body.ok !== true) {
    throw new Error(body.error?.message ?? `${label} failed with HTTP ${response.status}`)
  }
  return body.data
}

function postAction<T>(path: string, label: string): Promise<T> {
  return requestJson<T>(path, label, { method: "POST" })
}

export function fetchSandboxStatus(sessionId: string): Promise<SandboxStatusView> {
  return requestJson(`/sandbox/api/status?session=${encodeURIComponent(sessionId)}`, "sandbox status")
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

export function listSandboxContainers(): Promise<{ name: string; phase: string; createdAt?: string }[]> {
  return requestJson("/sandbox/api/list", "sandbox list")
}
