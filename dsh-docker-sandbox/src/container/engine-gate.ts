
import type { Events } from "@deepseek-ai/cordis"
import type { SandboxConfig } from "../config.ts"
import type { Provisioner } from "./provisioner.ts"

export function createEngineGate(
  provisioner: Provisioner,
  config: SandboxConfig,
): Events["agent/pre-step"] {
  return async (_payload, next) => {
    if (!config.worktree.get()) return await next()
    const engine = await provisioner.engineReachable()
    if (engine.reachable) return await next()
    throw new Error(
      "dsh-docker-sandbox: this conversation runs in a Docker sandbox, but the Docker engine is not reachable"
      + ` (${engine.error ?? "no detail"}). Start Docker Desktop (or your Docker engine) and send the message again.`,
    )
  }
}
