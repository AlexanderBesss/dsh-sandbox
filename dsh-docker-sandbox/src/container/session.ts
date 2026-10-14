/**
 * Which sandbox container a call belongs to.
 *
 * The shell, filesystem, and subprocess seams are deliberately session-free:
 * their specs carry a working directory, not a chat. Every chat in one workspace
 * shares that directory, so the workspace cannot identify the container. The
 * agent runtime can — `ctx.agents.currentInitiator()` returns the Agent driving
 * the current asynchronous chain, and an Agent carries its `session`.
 *
 * The identity is resolved once, at `resolve` / `spawn` / `execute` time, and
 * then bound to the handle: later reads, job polling, and cancellation can run
 * outside the initiator chain and must still reach the same container.
 *
 * @module dsh-docker-sandbox/container/session
 */

import { createHash } from "node:crypto"
import type { SandboxContext } from "../context.ts"
import type { SandboxConfig } from "../config.ts"
import type { WorktreeManager } from "./worktrees.ts"

/** A call that could not be attributed to a live, unarchived chat. */
export class SandboxSessionError extends Error {
  constructor(message: string, readonly code: "NO_SESSION" | "SESSION_ARCHIVED" | "SESSION_GONE") {
    super(message)
    this.name = "SandboxSessionError"
  }
}

/** The container a call is routed to, plus the workspace it mounts. */
export interface SandboxTarget {
  /** Conversation the call belongs to (`default` for the shared fallback). */
  sessionId: string
  /** Container name, which is also the name shown in the UI. */
  container: string
  /** Windows path of the workspace the container bind-mounts. */
  workspace: string
  /** True when the shared fallback container was used. */
  shared: boolean
  /**
   * Windows path of the checkout the worktree was carved from, when worktree
   * mode moved this session off the shared workspace.
   */
  mainWorkspace?: string
}

/** Prefix keeping sandbox containers recognizable and collision-free. */
export const CONTAINER_PREFIX = "dsh-sbx-"

/** The conversation a shared fallback container belongs to. */
export const DEFAULT_SESSION_ID = "default"

/** Longest conversation slug carried into a container name. */
const SLUG_MAX = 48

/** Short digest suffix keeping a truncated slug unique. */
export function slugDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8)
}

/**
 * The name-safe slug for one conversation id.
 *
 * Shared by the container name and the worktree/branch names so all three
 * identify the same conversation and separate the same collisions: a slug
 * that sanitization altered — truncated, or rewritten by the character
 * stripping — carries a short digest of the full id.
 *
 * @param sessionId - conversation identity.
 * @returns the slug, `unnamed` for an empty id.
 */
export function sessionSlugFor(sessionId: string): string {
  const slug = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug === sessionId && slug.length <= SLUG_MAX) return slug || "unnamed"
  const head = slug.slice(0, SLUG_MAX - 10)
  return `${head}-${slugDigest(sessionId)}`
}

/** Longest readable part a conversation title contributes to a name. */
const TITLE_SLUG_MAX = 40

/**
 * Turn human-readable text (a chat title, or its first message) into a ref-safe slug.
 *
 * Git refs rule out spaces, `~^:?*[`, `..`, `@{`, and a trailing `.lock`, so the
 * slug keeps only `a-z0-9`: accents are folded off (`café` → `cafe`) and
 * everything else — punctuation, emoji, non-latin script — becomes a separator.
 * Text with nothing latin-alphanumeric in it yields `""`, which callers read as
 * "no usable name" and answer with the session slug.
 *
 * @param text - the title, as the app or the first prompt states it.
 * @returns the slug, possibly empty.
 */
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

/**
 * The branch (and worktree directory) name for one conversation.
 *
 * A readable name is what makes a branch recognizable in `git branch`, on the
 * remote, and in a pull-request list, so the conversation's title drives it. The
 * short digest of the session id rides along because two chats can carry the
 * same title, and a branch name that names two conversations is worse than an
 * ugly one. With no usable title — the app has not named the chat yet, or its
 * title is not in latin script — the session slug is used, as before.
 *
 * @param title - the conversation title, when the app has one.
 * @param sessionId - conversation identity, source of the uniqueness digest.
 * @returns the slug carried after the branch prefix.
 */
export function branchSlugFor(title: string | undefined, sessionId: string): string {
  const readable = title === undefined ? "" : titleSlugFor(title)
  if (readable === "") return sessionSlugFor(sessionId)
  return `${readable}-${slugDigest(sessionId).slice(0, 6)}`
}

/**
 * Derive the sandbox container name for one conversation.
 *
 * Docker container names match `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; the session id is
 * lower-cased, stripped to name-safe characters, and truncated. The result is
 * stable for a session, which is what makes "the container this chat runs in"
 * a name a user can read — and `docker ps` shows the same string.
 *
 * A slug that sanitization altered — truncated, or rewritten by the character
 * stripping — carries a short digest of the full id: two ids sharing a
 * 48-character prefix, or two ids like `Session_42` and `session-42` that
 * sanitize to one slug, would otherwise name the same container, and one chat
 * would end up running inside another's box.
 *
 * @param sessionId - conversation identity.
 * @returns the container name.
 */
export function containerNameFor(sessionId: string): string {
  return `${CONTAINER_PREFIX}${sessionSlugFor(sessionId)}`.slice(0, 63).replace(/-+$/g, "")
}

/** Label filter matching every container this plugin owns. */
export const OWNERSHIP_LABEL = "dsh.sandbox=1"

/** Label carrying the conversation a sandbox container belongs to. */
export const SESSION_LABEL = "dsh.session"

/**
 * The label Docker Desktop uses to group containers into one stack card.
 * Stamping it with a per-workspace project name puts every session's
 * container from the same workspace under a single group in the Docker app.
 */
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project"

/**
 * Derive the Docker Desktop group name for one workspace.
 *
 * The readable part is the workspace directory's name; the digest keeps the
 * group unique per path (two `backend` folders in different places must not
 * merge into one stack card) and stable across sessions of the same chat
 * workspace. Compose project names must be lowercase alphanumeric or hyphen.
 *
 * @param workspace - host workspace directory the container mounts.
 * @returns the compose project label value.
 */
export function composeProjectFor(workspace: string): string {
  const base = workspace.split(/[\\/]+/).filter(Boolean).pop() ?? "workspace"
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "workspace"
  return `dsh-${slug}-${slugDigest(workspace.toLowerCase())}`
}

/**
 * The sandbox target for one named conversation.
 *
 * This does not depend on the initiating agent, which is what makes it usable
 * from a UI-driven call (the terminal panel opening a session) where no agent
 * chain is running.
 *
 * With worktree mode on, the workspace is remapped to the conversation's own
 * git worktree (created on first use, cached after); the checkout it was
 * carved from rides along as `mainWorkspace`.
 *
 * @param ctx - the plugin context (reads `sessions`).
 * @param config - plugin configuration (fallback workspace).
 * @param sessionId - conversation identity.
 * @param cwdHint - a workspace the caller already resolved, preferred over the store.
 * @param worktrees - the worktree manager, when the plugin built one.
 * @returns the target for that conversation.
 */
export function targetForSession(
  ctx: SandboxContext,
  config: SandboxConfig,
  sessionId: string,
  cwdHint?: string,
  worktrees?: WorktreeManager,
): SandboxTarget {
  // The workspace is the session's recorded cwd: the hint when the caller has
  // one, otherwise the session store, otherwise the configured fallback.
  const header = ctx.sessions?.get?.(sessionId)?.header
  const fromStore = header?.cwd
  const workspace = typeof cwdHint === "string" && cwdHint !== ""
    ? cwdHint
    : typeof fromStore === "string" && fromStore !== "" ? fromStore : config.workspaceRoot

  // A subagent's session carries its delegating parent; the worktree manager
  // aliases it onto the parent's tree so the child sees the parent's work.
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

/**
 * Resolve the sandbox target for the current call.
 *
 * @param ctx - the plugin context (reads `agents`).
 * @param config - plugin configuration (fallback workspace).
 * @param worktrees - the worktree manager, when the plugin built one.
 * @returns the target to route this call to.
 * @throws {SandboxSessionError} when the call has no chat and none is allowed.
 */
export function resolveTarget(
  ctx: SandboxContext,
  config: SandboxConfig,
  worktrees?: WorktreeManager,
): SandboxTarget {
  const agent = ctx.agents?.currentInitiator?.()
  // The base Agent contract is `{ id: SessionId }`; the runtime object also
  // carries its `session`. Either way the id is the conversation's.
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
