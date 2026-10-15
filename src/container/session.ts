import { createHash } from "node:crypto"
import type { SandboxContext } from "../context.ts"
import type { SandboxConfig } from "../config.ts"
import type { WorktreeManager } from "./worktrees.ts"

export class SandboxSessionError extends Error {
  constructor(message: string, readonly code: "NO_SESSION" | "SESSION_ARCHIVED" | "SESSION_GONE") {
    super(message)
    this.name = "SandboxSessionError"
  }
}

export interface SandboxTarget {
  sessionId: string
  container: string
  workspace: string
  shared: boolean
  mainWorkspace?: string
}

export const CONTAINER_PREFIX = "dsh-sbx-"

export const DEFAULT_SESSION_ID = "default"

const SLUG_MAX = 48

export function slugDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8)
}

function dashSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function sessionSlugFor(sessionId: string): string {
  const slug = dashSlug(sessionId)
  if (slug === sessionId && slug.length <= SLUG_MAX) return slug || "unnamed"
  const head = slug.slice(0, SLUG_MAX - 10)
  return `${head}-${slugDigest(sessionId)}`
}

const TITLE_SLUG_MAX = 40

export function titleSlugFor(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TITLE_SLUG_MAX)
    .replace(/-+$/g, "")
}

export function branchSlugFor(title: string | undefined, sessionId: string): string {
  const readable = title === undefined ? "" : titleSlugFor(title)
  if (readable === "") return sessionSlugFor(sessionId)
  return `${readable}-${slugDigest(sessionId).slice(0, 6)}`
}

export function containerNameFor(sessionId: string): string {
  return `${CONTAINER_PREFIX}${sessionSlugFor(sessionId)}`.slice(0, 63).replace(/-+$/g, "")
}

export const OWNERSHIP_LABEL = "dsh.sandbox=1"

export const SESSION_LABEL = "dsh.session"

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project"

export function composeProjectFor(workspace: string): string {
  const base = workspace.split(/[\\/]+/).filter(Boolean).pop() ?? "workspace"
  const slug = dashSlug(base).slice(0, 32) || "workspace"
  return `dsh-${slug}-${slugDigest(workspace.toLowerCase())}`
}

export function targetForSession(
  ctx: SandboxContext,
  config: SandboxConfig,
  sessionId: string,
  cwdHint?: string,
  worktrees?: WorktreeManager,
): SandboxTarget {
  const header = ctx.sessions?.get?.(sessionId)?.header
  const fromStore = header?.cwd
  const workspace = typeof cwdHint === "string" && cwdHint !== ""
    ? cwdHint
    : typeof fromStore === "string" && fromStore !== "" ? fromStore : config.workspaceRoot

  const parentSession = typeof header?.parentSession === "string" ? header.parentSession : undefined
  const entry = worktrees?.ensure(sessionId, workspace, parentSession)
  const identity = {
    sessionId,
    container: containerNameFor(sessionId),
    shared: sessionId === DEFAULT_SESSION_ID,
  }
  if (entry === undefined) return { ...identity, workspace }
  return { ...identity, workspace: entry.worktreePath, mainWorkspace: workspace }
}

export function resolveTarget(
  ctx: SandboxContext,
  config: SandboxConfig,
  worktrees?: WorktreeManager,
): SandboxTarget {
  const agent = ctx.agents?.currentInitiator?.()
  const sessionId = agent?.session?.id ?? agent?.id

  if (sessionId === undefined) {
    if (config.allowAgentless !== true) {
      throw new SandboxSessionError(
        "this call is not running inside a conversation, so it has no sandbox container; "
        + "set allowAgentless to true to route such calls to the shared container",
        "NO_SESSION",
      )
    }
    return targetForSession(ctx, config, DEFAULT_SESSION_ID, undefined, worktrees)
  }

  return targetForSession(ctx, config, sessionId, agent?.session?.header?.cwd, worktrees)
}
