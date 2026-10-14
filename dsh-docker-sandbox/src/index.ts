/**
 * dsh-docker-sandbox — every conversation runs in its own Docker container.
 *
 * The plugin replaces the three capability seams that decide where work
 * happens, and registers one terminal backend:
 *
 * - `ctx.shell`       → {@link DockerShellExecutor}, one `docker exec` per command
 * - `ctx.fs`          → {@link DockerFileSystem}, host-backed over the bind
 *                       mount (file operations need no container)
 * - `ctx.subprocess`  → {@link DockerSubprocessRuntime}, the seam `glob` / `grep`
 *                       and the `pwsh` tool spawn through
 * - `shell` terminals → {@link createShellBackend}, a persistent shell in the
 *                       same container
 *
 * Swapping those providers relocates the whole tool family: `read` / `write` /
 * `edit` go through `ctx.fs`, `bash`-style commands go through `ctx.shell`, and
 * search goes through `ctx.subprocess`. Nothing is faked: when the Docker
 * daemon is not reachable the tools fail with a named error instead of quietly
 * running on the host.
 *
 * The container is named after the conversation (`dsh-sbx-<session>`), and the
 * session header shows that name, so "which container am I in?" is answerable
 * without leaving the app — it is the same string `docker ps` shows.
 *
 * @module dsh-docker-sandbox
 */

import type { Context } from "@deepseek-ai/cordis"
import type { SandboxContext, SubagentService } from "./context.ts"
import { Config, type SandboxConfig } from "./config.ts"
import { DockerFileSystem } from "./seams/fs.ts"
import { startContainerGc } from "./container/gc.ts"
import { createCliRunner } from "./container/git.ts"
import { createEngineGate } from "./container/engine-gate.ts"
import { createWarmInstall } from "./container/warm-install.ts"
import type { SandboxTarget } from "./container/session.ts"
import { type MountMode, PathMapper } from "./container/paths.ts"
import { Provisioner } from "./container/provisioner.ts"
import { registerStatusRoute } from "./status.ts"
import { DockerShellExecutor } from "./seams/shell.ts"
import { DockerSubprocessRuntime } from "./seams/subprocess.ts"
import { createShellBackend } from "./seams/terminal.ts"
import { DockerTransport } from "./container/transport.ts"
import { WorktreeManager } from "./container/worktrees.ts"

export const name = "docker-sandbox"

/**
 * Consumed services: chat identity, session store, HTTP routes.
 *
 * `terminals` is deliberately *not* injected: recent app builds isolate the
 * terminal service inside the `persistent-shell` group (`isolate: { terminals:
 * true }`), so a top-level entry can never see it, and injecting it would leave
 * the whole plugin pending — which starves `shell` / `fs` / `subprocess` and
 * breaks every tool. The terminal backend is registered through a deferred
 * child fiber instead (see `apply`), so it attaches when the service is
 * visible and stays harmlessly pending when it is not.
 */
export const inject = ["agents", "sessions", "webServer"]

export { Config }

export function apply(ctx: SandboxContext, config: SandboxConfig): void {
  const mountMode: MountMode = config.mountMode === "drives" ? "drives" : "workspace"
  const paths = new PathMapper(mountMode, config.containerWorkspace)
  const transport = new DockerTransport(config)
  // The warm install needs the provisioner (for its work lease) and the
  // provisioner needs the install (as its container-ready hook); the forward
  // declaration unties the knot, and the hook only ever fires after `apply`
  // has assigned the real handler.
  let warmInstall: (target: SandboxTarget) => void = () => undefined
  const provisioner = new Provisioner(transport, config, paths, ctx.logger, {
    // A container the engine still holds for a chat this app has open is not an
    // orphan, even when this process never provisioned it.
    isSessionLive: (sessionId) => ctx.sessions?.get?.(sessionId) !== undefined,
    // And an archived chat gets no *new* container either: the archive set is
    // durable, so a stale call naming an archived id is refused instead of
    // resurrecting a box nothing owns.
    isSessionArchived: (sessionId) =>
      (ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined)
        ?.archivedSessionIds?.includes(sessionId) === true,
    onContainerReady: (target) => warmInstall(target),
  })
  // Worktree mode is read live (it is a volatile option), so the manager is
  // always built; `ensure` is a no-op while the toggle is off.
  const worktrees = new WorktreeManager({
    git: createCliRunner(config.gitArgv, "git"),
    gh: createCliRunner(config.ghArgv, "gh"),
    config,
    logger: ctx.logger,
    paths,
  })
  warmInstall = createWarmInstall({ transport, provisioner, worktrees, config, logger: ctx.logger })

  // Registering a Service instance replaces the seam for the whole app; the
  // bundle patch has already disabled the local providers this displaces.
  const subprocess = new DockerSubprocessRuntime(ctx, { transport, provisioner, paths, config, worktrees })
  const shell = new DockerShellExecutor(ctx, { subprocess, provisioner, transport, paths, config, worktrees })
  const filesystem = new DockerFileSystem(ctx, { paths, config, worktrees })
  void shell
  void filesystem

  // Deferred: attach the `shell` terminal backend once `terminals` is visible
  // from this entry. A child fiber waits on it, so an isolated (or absent)
  // terminal service never blocks the shell/fs/subprocess takeover above.
  ctx.inject(["terminals"], (inner: Context) => {
    (inner as SandboxContext).terminals.registerBackend(
      createShellBackend(inner as SandboxContext, { transport, provisioner, paths, config, worktrees }),
    )
  })
  // Deferred: capture the subagent service when it becomes visible, so the
  // review button can spawn a fresh reviewer. An absent or isolated service
  // leaves the review route answering 503, and never blocks the seams.
  let subagents: SubagentService | undefined
  ctx.inject(["subagents"], (inner: Context) => {
    subagents = (inner as SandboxContext).subagents
  })

  registerStatusRoute(ctx, { provisioner, paths, config, worktrees, subagents: () => subagents })

  // The app stops an archived conversation's work through this hook — the
  // same seam the agent registry and job owners use — and the container is
  // this plugin's part of that work. (This covers archiving a *busy* chat;
  // archiving an idle one emits nothing, so the GC sweep below consults the
  // registry's archive set instead.)
  ctx.on("workspace/session-stop", ({ sessionId }: { sessionId: string }) =>
    provisioner.releaseSession(sessionId),
  )

  // Worktree mode with the engine down would edit the main checkout while
  // claiming the sandbox's isolation, so the turn fails with the instruction
  // that fixes it instead of answering. (See container/engine-gate.ts.)
  ctx.on("agent/pre-step", createEngineGate(provisioner, config))

  // A disposed session is gone for good: archived, deleted, or a subagent
  // child whose run settled (the reviewer's container used to sit in its
  // group until the idle TTL swept it). The store's teardown event covers
  // every kind of exit, so the container leaves with its session.
  ctx.on("session/disposed", (session: { id: string }) => provisioner.releaseSession(session.id))

  // The periodic sweep (archived conversations first, then the idle TTL) and
  // its shutdown cleanup.
  startContainerGc(ctx, provisioner, config, worktrees)

  // Say what the plugin took over, once, so a surprising tool error is
  // explainable from the log without reading the config.
  ctx.logger.info(
    `dsh-docker-sandbox: shell, fs, subprocess and shell terminals now run in Docker `
    + `(image ${config.image.get()}, mount ${config.mountMode}`
    + (config.worktree.get() ? ", worktree mode on" : "")
    + ")",
  )
}
