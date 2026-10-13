/**
 * The host services this plugin consumes, as a local type.
 *
 * Cordis's `Context` is a proxy whose public interface is augmented by services
 * *inside* the cordis package (`declare module './context.ts'`). An outside
 * package cannot reach that declaration through the package entry — augmenting
 * `"@deepseek-ai/cordis"` would shadow the re-export instead of widening it —
 * so the services are described here and intersected into the context type the
 * plugin passes around.
 *
 * Each shape was read off the live service contract (the inspect provider's
 * `listService` output) or a shipped call site, not guessed:
 *
 * - `agents.currentInitiator()` returns the initiating `Agent`, whose base
 *   interface is `{ id: SessionId }`; the runtime object also carries its
 *   `session`, and the shipped code reads `currentInitiator()?.session`.
 * - `sessions.get(id)` returns the live `Session`; `header.cwd` is the
 *   validated absolute workspace recorded in the immutable SessionHeader.
 * - `webServer.register(route)` takes `{ kind, path, handler }` and returns a
 *   disposer; a duplicate `(kind, path)` throws.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Context } from "@deepseek-ai/cordis"
import type { TerminalSessionService } from "@deepseek-ai/dsh-terminal"

/** The agent registry slice this plugin reads. */
export interface AgentService {
  /** The Agent that initiated the current async chain, if any. */
  currentInitiator(): {
    id: string
    session?: { id: string; header?: { cwd?: string } }
  } | undefined
  /** The live Agent for a session id, if one is registered. */
  get?(id: string): {
    id: string
    session?: { id: string; header?: { cwd?: string } }
  } | undefined
}

/** The session store slice this plugin reads. */
export interface SessionService {
  /** The live session, or undefined when none has that id. */
  get(id: string): {
    id: string
    header?: { cwd?: string; parentSession?: string }
  } | undefined
}

/** One HTTP route on the embedded web server. */
export interface WebRoute {
  /** Match the exact path, or this path and everything below it. */
  kind: "exact" | "prefix"
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

/** The embedded HTTP carrier. */
export interface WebServerService {
  /** Register a named route; the disposer removes it. */
  register(route: WebRoute): () => void
}

/** The workspace registry slice this plugin reads (`dsh-workspace`). */
export interface WorkspaceRegistryService {
  /** Archived session ids, in archive order. */
  readonly archivedSessionIds: readonly string[]
}

/** One started subagent run; the child session rides on `localAgent`. */
export interface SubagentRun {
  localAgent?: { session?: { id: string } }
}

/**
 * The subagent service (`dsh-subagent`), read for the review button.
 *
 * The shape mirrors the shipped call sites: `start(name, request)` establishes
 * a one-shot child on a registered provider and resolves when the child's
 * inbox accepts the prompt (not when the turn finishes), and `list()` names
 * the registered providers in insertion order.
 */
export interface SubagentService {
  /** Registered provider names, in insertion order. */
  list(): string[]
  /** Start one one-shot child; resolves at initial inbox acceptance. */
  start(
    provider: string,
    request: {
      prompt: Array<{ type: "text"; text: string }>
      /** The delegating parent Agent (its session anchors the child). */
      parent: { id: string; session?: { id: string } }
      signal: AbortSignal
      label?: string
    },
  ): Promise<SubagentRun>
}

/**
 * The context as this plugin sees it: the cordis context plus the four DSH
 * services it consumes. `apply()` receives this, and every seam class keeps it
 * for its own lookups.
 */
export type SandboxContext = Context & {
  /** Live agents and the initiating-agent boundary (`dsh-agent`). */
  agents: AgentService
  /** In-memory session store (`dsh-session`). */
  sessions: SessionService
  /** Persistent terminal sessions (`dsh-terminal`). */
  terminals: TerminalSessionService
  /** Embedded HTTP server (`dsh-web-server`). */
  webServer: WebServerService
  /**
   * Workspace accounting, read for its archive set. Not injected: the plugin
   * only samples it during GC, so a missing registry must not stall the seams.
   */
  workspaceRegistry?: WorkspaceRegistryService
  /**
   * Subagent spawner (`dsh-subagent`), read for the review button. Captured
   * through a deferred inject, so an absent or isolated service never blocks
   * the plugin (same pattern as `terminals`).
   */
  subagents?: SubagentService
}
