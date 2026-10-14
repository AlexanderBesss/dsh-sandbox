import type { Context } from "@deepseek-ai/cordis"
import { randomUUID } from "node:crypto"
import type { DurableUserMessage, SandboxContext, SubagentService } from "./context.ts"
import { Config, type SandboxConfig } from "./config.ts"
import { DockerFileSystem } from "./seams/fs.ts"
import { startContainerGc } from "./container/gc.ts"
import { createCliRunner } from "./container/git.ts"
import { createEngineGate } from "./container/engine-gate.ts"
import { createTreeReinstall, createWarmInstall } from "./container/warm-install.ts"
import type { SandboxTarget } from "./container/session.ts"
import { createPrBrief } from "./container/pr-brief.ts"
import { createSessionTitleReader } from "./container/session-title.ts"
import { type MountMode, PathMapper } from "./container/paths.ts"
import { Provisioner } from "./container/provisioner.ts"
import { createResolverGuard, registerStatusRoute } from "./status.ts"
import { DockerShellExecutor } from "./seams/shell.ts"
import { DockerSubprocessRuntime } from "./seams/subprocess.ts"
import { createShellBackend } from "./seams/terminal.ts"
import { DockerTransport } from "./container/transport.ts"
import { WorktreeManager, type WorktreeEntry } from "./container/worktrees.ts"

export const name = "docker-sandbox"

export const inject = ["agents", "sessions", "webServer"]

export { Config }

export function apply(ctx: SandboxContext, config: SandboxConfig): void {
  const mountMode: MountMode = config.mountMode === "drives" ? "drives" : "workspace"
  const paths = new PathMapper(mountMode, config.containerWorkspace)
  const transport = new DockerTransport(config)
  let warmInstall: (target: SandboxTarget) => void = () => undefined
  let reinstallTree: (entry: WorktreeEntry) => void = () => undefined
  const provisioner = new Provisioner(transport, config, paths, ctx.logger, {
    isSessionLive: (sessionId) => ctx.sessions?.get?.(sessionId) !== undefined,
    isSessionArchived: (sessionId) =>
      (ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined)
        ?.archivedSessionIds?.includes(sessionId) === true,
    onContainerReady: (target) => warmInstall(target),
  })
  let subagents: SubagentService | undefined
  const git = createCliRunner(config.gitArgv, "git")
  const worktrees = new WorktreeManager({
    git,
    gh: createCliRunner(config.ghArgv, "gh"),
    config,
    logger: ctx.logger,
    paths,
    titleFor: createSessionTitleReader(ctx),
    brief: createPrBrief({
      subagents: () => subagents,
      parentFor: (sessionId) => ctx.agents?.get?.(sessionId),
      git,
      config,
      logger: ctx.logger,
    }),
    notify: (sessionId, text): boolean => {
      const agent = ctx.agents?.get?.(sessionId)
      if (agent === undefined) return false
      const message: DurableUserMessage = {
        role: "user",
        id: randomUUID(),
        source: { kind: "worktree-sync", form: "notice", summary: text.split("\n")[0] ?? text },
        content: [{ type: "text", text }],
      }
      try {
        if (agent.status === "running" && agent.steer !== undefined) {
          agent.steer(message)
          return true
        }
        if (agent.followup === undefined) return false
        agent.followup(message)
        return true
      } catch {
        return false
      }
    },
    onTreeChanged: (entry) => reinstallTree(entry),
  })
  warmInstall = createWarmInstall({ transport, provisioner, worktrees, config, logger: ctx.logger })
  reinstallTree = createTreeReinstall({ transport, provisioner, worktrees, config, logger: ctx.logger })

  const subprocess = new DockerSubprocessRuntime(ctx, { transport, provisioner, paths, config, worktrees })
  const shell = new DockerShellExecutor(ctx, { subprocess, provisioner, transport, paths, config, worktrees })
  const filesystem = new DockerFileSystem(ctx, { paths, config, worktrees })
  void shell
  void filesystem

  ctx.inject(["terminals"], (inner: Context) => {
    (inner as SandboxContext).terminals.registerBackend(
      createShellBackend(inner as SandboxContext, { transport, provisioner, paths, config, worktrees }),
    )
  })
  ctx.inject(["subagents"], (inner: Context) => {
    subagents = (inner as SandboxContext).subagents
  })

  registerStatusRoute(ctx, {
    provisioner,
    paths,
    config,
    worktrees,
    subagents: () => subagents,
    resolvers: createResolverGuard(),
  })

  ctx.on("workspace/session-stop", ({ sessionId }: { sessionId: string }) =>
    provisioner.releaseSession(sessionId),
  )

  const engineGate = createEngineGate(provisioner, config, {
    worktrees,
    workspaceFor: (sessionId) => ctx.sessions?.get?.(sessionId)?.header?.cwd ?? config.workspaceRoot,
  })
  ctx.on("agent/pre-step", engineGate)

  ctx.on("session/disposed", (session: { id: string }) => {
    provisioner.releaseSession(session.id)
    engineGate.forget(session.id)
  })

  startContainerGc(ctx, provisioner, config, worktrees)

  ctx.logger.info(
    `dsh-docker-sandbox: shell, fs, subprocess and shell terminals now run in Docker `
    + `(image ${config.image.get()}, mount ${config.mountMode}`
    + (config.worktree.get() ? ", worktree mode on" : "")
    + ")",
  )
}
