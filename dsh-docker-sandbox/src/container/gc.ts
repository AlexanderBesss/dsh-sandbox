import type { SandboxContext } from "../context.ts"
import type { SandboxConfig } from "../config.ts"
import type { Provisioner } from "./provisioner.ts"
import type { WorktreeManager } from "./worktrees.ts"

export function startContainerGc(
  ctx: SandboxContext,
  provisioner: Provisioner,
  config: SandboxConfig,
  worktrees?: WorktreeManager,
): void {
  let registryReported = false
  const sweep = async (): Promise<{ containers: string[]; worktrees: string[] }> => {
    const registry = ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined
    if (registry?.archivedSessionIds === undefined && !registryReported) {
      registryReported = true
      ctx.logger.warn("dsh-docker-sandbox: no workspace registry in reach; archived containers are reclaimed by idle TTL only")
    }
    const archived = new Set(registry?.archivedSessionIds ?? [])
    const containers = await provisioner.releaseArchived(archived)
    const idle = await provisioner.collectIdle()
    const prunedTrees = worktrees === undefined ? [] : await worktrees.pruneForArchived(archived)
    const isIdleLive = (sessionId: string): boolean =>
      !archived.has(sessionId)
      && ctx.sessions?.get?.(sessionId) !== undefined
      && ctx.agents?.get?.(sessionId)?.status !== "running"
    if (worktrees !== undefined) await worktrees.syncLive(archived, isIdleLive)
    return { containers: [...containers, ...idle], worktrees: prunedTrees }
  }

  const gc = setInterval(() => {
    void sweep().then((result) => {
      if (result.containers.length > 0) ctx.logger.info(`dsh-docker-sandbox: released containers: ${result.containers.join(", ")}`)
      if (result.worktrees.length > 0) ctx.logger.info(`dsh-docker-sandbox: pruned merged worktrees: ${result.worktrees.join(", ")}`)
    }, (error: unknown) => {
      ctx.logger.warn(`dsh-docker-sandbox: container GC pass failed: ${(error as Error).message}`)
    })
  }, config.gcIntervalMs)
  gc.unref?.()

  ctx.effect(() => () => {
    clearInterval(gc)
    if (!config.gcOnUnload) return
    return provisioner.releaseAll().then(
      (deleted) => ctx.logger.info(`dsh-docker-sandbox: removed ${deleted.length} sandbox container(s) on unload`),
      (error: unknown) => ctx.logger.warn(`dsh-docker-sandbox: could not clean up on unload: ${(error as Error).message}`),
    )
  }, "dsh-docker-sandbox: sandbox lifecycle")
}
