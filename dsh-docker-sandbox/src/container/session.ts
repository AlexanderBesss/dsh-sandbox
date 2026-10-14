// identity is resolved once at resolve/spawn/execute and bound to the handle — later reads run outside the agent chain
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

export function sessionSlugFor(sessionId: string): string {
  const slug = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug === sessionId && slug.length <= SLUG_MAX) return slug || "unnamed"
  const head = slug.slice(0, SLUG_MAX - 10)
  return `${head}-${slugDigest(sessionId)}`
}

const TITLE_SLUG_MAX = 40

// git ref rules leave only a-z0-9; an empty result means "no usable name" and callers answer with the session slug
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

// two chats can carry the same title; the session-id digest keeps their branches apart
export function branchSlugFor(title: string | undefined, sessionId: string): string {
  const readable = title === undefined ? "" : titleSlugFor(title)
  if (readable === "") return sessionSlugFor(sessionId)
  return `${readable}-${slugDigest(sessionId).slice(0, 6)}`
}

// docker names match [a-zA-Z0-9][a-zA-Z0-9_.-]* and cap at 63; the digest in sessionSlugFor keeps same-slug ids apart
export function containerNameFor(sessionId: string): string {
  return `${CONTAINER_PREFIX}${sessionSlugFor(sessionId)}`.slice(0, 63).replace(/-+$/g, "")
}

export const OWNERSHIP_LABEL = "dsh.sandbox=1"

export const SESSION_LABEL = "dsh.session"

// Docker Desktop stacks containers by this label; stamp per workspace to group that workspace's sessions in one card
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project"

// compose project names must be lowercase alphanumeric or hyphen; the digest keeps same-named folders from merging
export function composeProjectFor(workspace: string): string {
  const base = workspace.split(/[\\/]+/).filter(Boolean).pop() ?? "workspace"
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "workspace"
  return `dsh-${slug}-${slugDigest(workspace.toLowerCase())}`
}

// independent of the initiating agent, so UI-driven calls (no agent chain running) can use it
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

  // a subagent's session carries its delegating parent; the worktree manager aliases it onto the parent's tree
  const parentSession = typeof header?.parentSession === "string" ? header.parentSession : undefined
  const entry = worktrees?.ensure(sessionId, workspace, parentSession)
  if (entry !== undefined) {
    return {
      sessionId,
      container: containerNameFor(sessionId),
      workspace: entry.worktreePath,
      shared: sessionId === DEFAULT_SESSION_ID,
      mainWorkspace: workspace,
    }
  }

  return {
    sessionId,
    container: containerNameFor(sessionId),
    workspace,
    shared: sessionId === DEFAULT_SESSION_ID,
  }
}

export function resolveTarget(
  ctx: SandboxContext,
  config: SandboxConfig,
  worktrees?: WorktreeManager,
): SandboxTarget {
  const agent = ctx.agents?.currentInitiator?.()
  // the Agent contract gives { id }; the runtime object also carries session.id — either way the id is the conversation's
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
