import type { IncomingMessage, ServerResponse } from "node:http"
import type { Context } from "@deepseek-ai/cordis"
import type { TerminalSessionService } from "@deepseek-ai/dsh-terminal"

export interface DurableUserMessage {
  role: "user"
  id: string
  source: Record<string, unknown>
  content: Array<{ type: string; text?: string }>
}

export interface LiveAgent {
  id: string
  session?: { id: string; header?: { cwd?: string } }
  status?: "idle" | "running"
  followup?(message: DurableUserMessage): void
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
    snapshotEvents?(): unknown[]
  } | undefined
}

export interface WebRoute {
  kind: "exact" | "prefix"
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

export interface WebServerService {
  register(route: WebRoute): () => void
}

export interface WorkspaceRegistryService {
  readonly archivedSessionIds: readonly string[]
}

export interface SubagentOutputBlock {
  type: string
  text?: string
}

export interface SubagentResult {
  stopReason: string
  output: SubagentOutputBlock[]
}

export interface SubagentRun {
  localAgent?: { session?: { id: string } }
  result: Promise<SubagentResult>
  dispose?(): void | Promise<void>
}

export interface SubagentService {
  list(): string[]
  start(
    provider: string,
    request: {
      prompt: Array<{ type: "text"; text: string }>
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
  workspaceRegistry?: WorkspaceRegistryService
  subagents?: SubagentService
}
