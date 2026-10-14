import type { SandboxContext } from "../context.ts"
import type { TerminalBackend, TerminalBackendSession } from "@deepseek-ai/dsh-terminal"
import type { SandboxConfig } from "../config.ts"
import type { PathMapper } from "../container/paths.ts"
import type { Provisioner } from "../container/provisioner.ts"
import { resolveTarget, targetForSession } from "../container/session.ts"
import type { DockerTransport } from "../container/transport.ts"
import type { WorktreeManager } from "../container/worktrees.ts"
import { ContainerTerminalSession } from "./terminal/session.ts"

export { ContainerTerminalSession }

export interface TerminalDeps {
  transport: DockerTransport
  provisioner: Provisioner
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
}

export function createShellBackend(ctx: SandboxContext, deps: TerminalDeps): TerminalBackend {
  return {
    type: "shell",
    spawn: async (request) => {
      const sessionId = request.sessionId === undefined || request.sessionId === ""
        ? resolveTarget(ctx, deps.config, deps.worktrees).sessionId
        : String(request.sessionId)
      const target = targetForSession(ctx, deps.config, sessionId, undefined, deps.worktrees)
      const cwd = request.cwd === undefined
        ? deps.paths.containerRoot(target.workspace)
        : deps.paths.toContainer(request.cwd, target.workspace)
      const session = new ContainerTerminalSession(
        deps.transport,
        deps.provisioner,
        deps.config,
        target,
        cwd,
      )
      await session.start()
      return session as unknown as TerminalBackendSession
    },
  }
}
