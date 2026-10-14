// outside packages cannot augment cordis's Context (the re-export shadows it); these shapes mirror shipped contracts

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Context } from "@deepseek-ai/cordis"
import type { TerminalSessionService } from "@deepseek-ai/dsh-terminal"

// shape the shipped Agent inbox accepts (dsh-agent-loop)
export interface DurableUserMessage {
  role: "user"
  id: string
  source: Record<string, unknown>
  content: Array<{ type: string; text?: string }>
}

export interface LiveAgent {
  id: string
  session?: { id: string; header?: { cwd?: string } }
  // mirrors the shipped agent loop's phase
  status?: "idle" | "running"
  // queues for the next turn, waking a quiescent agent
  followup?(message: DurableUserMessage): void
  // injects into the in-flight turn
  steer?(message: DurableUserMessage): void
}

export interface AgentService {
  currentInitiator(): LiveAgent | undefined
  get?(id: string): LiveAgent | undefined
}

export interface SessionService {
  get(id: string): {
    id: string
    header?: { cwd?: string; parentSession?: string }
    // durable event log, oldest first (dsh-session); read only to name a branch when the app has not titled it
    snapshotEvents?(): unknown[]
  } | undefined
}

export interface WebRoute {
  kind: "exact" | "prefix"
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

export interface WebServerService {
  // the disposer removes the route; a duplicate (kind, path) throws
  register(route: WebRoute): () => void
}

export interface WorkspaceRegistryService {
  // in archive order
  readonly archivedSessionIds: readonly string[]
}

export interface SubagentOutputBlock {
  type: string
  text?: string
}

export interface SubagentResult {
  // `completed` only when the child finished its turn cleanly
  stopReason: string
  output: SubagentOutputBlock[]
}

// the delegation tool consumes both `result` and `dispose`: an unsettled run leaves the child resident
export interface SubagentRun {
  localAgent?: { session?: { id: string } }
  result: Promise<SubagentResult>
  dispose?(): void | Promise<void>
}

// dsh-subagent: `start` resolves when the inbox accepts the prompt, not when the turn ends; `list()` is insertion order
export interface SubagentService {
  list(): string[]
  start(
    provider: string,
    request: {
      prompt: Array<{ type: "text"; text: string }>
      // its session anchors the child
      parent: { id: string; session?: { id: string } }
      signal: AbortSignal
      label?: string
    },
  ): Promise<SubagentRun>
}

export type SandboxContext = Context & {
  agents: AgentService
  sessions: SessionService
  terminals: TerminalSessionService
  webServer: WebServerService
  // not injected: only sampled during GC, so a missing registry must not stall the seams
  workspaceRegistry?: WorkspaceRegistryService
  // captured through a deferred inject: an absent or isolated service never blocks the plugin (same pattern as terminals)
  subagents?: SubagentService
}
