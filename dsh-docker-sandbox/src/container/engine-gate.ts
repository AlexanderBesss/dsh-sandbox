
import type { Events } from "@deepseek-ai/cordis"
import type { SandboxConfig } from "../config.ts"
import type { Provisioner } from "./provisioner.ts"
import type { WorktreeManager } from "./worktrees.ts"

export interface TurnSyncDeps {
  worktrees: WorktreeManager
  workspaceFor: (sessionId: string) => string
}

export type EngineGate = Events["agent/pre-step"] & {
  forget(sessionId: string): void
}

export function createEngineGate(
  provisioner: Provisioner,
  config: SandboxConfig,
  sync?: TurnSyncDeps,
): EngineGate {
  const lastTurn = new Map<string, number>()
  const gate: Events["agent/pre-step"] = async (payload, next) => {
    if (!config.worktree.get()) return await next()
    const engine = await provisioner.engineReachable()
    if (!engine.reachable) {
      throw new Error(
        "dsh-docker-sandbox: this conversation runs in a Docker sandbox, but the Docker engine is not reachable"
        + ` (${engine.error ?? "no detail"}). Start Docker Desktop (or your Docker engine) and send the message again.`,
      )
    }
    if (sync !== undefined && config.worktreeSync.get() && lastTurn.get(payload.agent.id) !== payload.turn) {
      lastTurn.set(payload.agent.id, payload.turn)
      try {
        await sync.worktrees.syncFor(payload.agent.id, sync.workspaceFor(payload.agent.id))
      } catch {
      }
    }
    return await next()
  }
  return Object.assign(gate, {
    forget: (sessionId: string): void => {
      lastTurn.delete(sessionId)
    },
  })
}
