import type { Context } from "@deepseek-ai/cordis"
import type { SandboxContext, SubagentService } from "./context.ts"
import { Config, type SandboxConfig } from "./config.ts"
import { DockerFileSystem } from "./seams/fs.ts"
import { startContainerGc } from "./container/gc.ts"
import { createCliRunner } from "./container/git.ts"
import { createEngineGate } from "./container/engine-gate.ts"
import { createWarmInstall } from "./container/warm-install.ts"
import type { SandboxTarget } from "./container/session.ts"
import { createPrBrief } from "./container/pr-brief.ts"
import { createSessionTitleReader } from "./container/session-title.ts"
import { type MountMode, PathMapper } from "./container/paths.ts"
import { Provisioner } from "./container/provisioner.ts"
import { registerStatusRoute } from "./status.ts"
import { DockerShellExecutor } from "./seams/shell.ts"
import { DockerSubprocessRuntime } from "./seams/subprocess.ts"
import { createShellBackend } from "./seams/terminal.ts"
import { DockerTransport } from "./container/transport.ts"
import { WorktreeManager } from "./container/worktrees.ts"

export const name = "docker-sandbox"

// recent app builds isolate `terminals`; injecting it here would leave the whole plugin pending and starve the seams
export const inject = ["agents", "sessions", "webServer"]

export { Config }

export function apply(ctx: SandboxContext, config: SandboxConfig): void {
  const mountMode: MountMode = config.mountMode === "drives" ? "drives" : "workspace"
  const paths = new PathMapper(mountMode, config.containerWorkspace)
  const transport = new DockerTransport(config)
  // warm install and provisioner depend on each other; the hook only fires after the real handler is assigned
  let warmInstall: (target: SandboxTarget) => void = () => undefined
  const provisioner = new Provisioner(transport, config, paths, ctx.logger, {
    // a container for a chat this app still has open is not an orphan, even one this process never provisioned
    isSessionLive: (sessionId) => ctx.sessions?.get?.(sessionId) !== undefined,
    // the archive set is durable, so a stale call naming an archived id is refused, not resurrected
    isSessionArchived: (sessionId) =>
      (ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined)
        ?.archivedSessionIds?.includes(sessionId) === true,
    onContainerReady: (target) => warmInstall(target),
  })
  // hoisted: the naming pass closes over this; the deferred inject fills it in
  let subagents: SubagentService | undefined
  const git = createCliRunner(config.gitArgv, "git")
  // worktree mode is volatile, so the manager is always built; `ensure` no-ops while the toggle is off
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
  })
  warmInstall = createWarmInstall({ transport, provisioner, worktrees, config, logger: ctx.logger })

  // registering a Service instance replaces the seam app-wide; the bundle patch has already disabled the local providers
  const subprocess = new DockerSubprocessRuntime(ctx, { transport, provisioner, paths, config, worktrees })
  const shell = new DockerShellExecutor(ctx, { subprocess, provisioner, transport, paths, config, worktrees })
  const filesystem = new DockerFileSystem(ctx, { paths, config, worktrees })
  void shell
  void filesystem

  // deferred so an isolated or absent `terminals` service never blocks the seam takeover above
  ctx.inject(["terminals"], (inner: Context) => {
    (inner as SandboxContext).terminals.registerBackend(
      createShellBackend(inner as SandboxContext, { transport, provisioner, paths, config, worktrees }),
    )
  })
  // deferred: an absent or isolated subagent service leaves the review route answering 503, never blocks the seams
  ctx.inject(["subagents"], (inner: Context) => {
    subagents = (inner as SandboxContext).subagents
  })

  registerStatusRoute(ctx, { provisioner, paths, config, worktrees, subagents: () => subagents })

  // stops a busy archived chat; archiving an idle one emits nothing, so the GC sweep also consults the archive set
  ctx.on("workspace/session-stop", ({ sessionId }: { sessionId: string }) =>
    provisioner.releaseSession(sessionId),
  )

  // worktree mode with the engine down would edit the main checkout while claiming isolation, so the gate fails the turn
  ctx.on("agent/pre-step", createEngineGate(provisioner, config))

  // the teardown event covers every exit kind (archive, delete, settled subagent child), so the container leaves too
  ctx.on("session/disposed", (session: { id: string }) => provisioner.releaseSession(session.id))

  startContainerGc(ctx, provisioner, config, worktrees)

  ctx.logger.info(
    `dsh-docker-sandbox: shell, fs, subprocess and shell terminals now run in Docker `
    + `(image ${config.image.get()}, mount ${config.mountMode}`
    + (config.worktree.get() ? ", worktree mode on" : "")
    + ")",
  )
}
