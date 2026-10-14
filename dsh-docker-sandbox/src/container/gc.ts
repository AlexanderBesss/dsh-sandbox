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
      // ctx.get answers undefined for a name nobody provides — a missing registry would otherwise read as "nothing archived".
      registryReported = true
      ctx.logger.warn("dsh-docker-sandbox: no workspace registry in reach; archived containers are reclaimed by idle TTL only")
    }
    const archived = new Set(registry?.archivedSessionIds ?? [])
    const containers = await provisioner.releaseArchived(archived)
    const idle = await provisioner.collectIdle()
    // never destroy unmerged work: only archived, clean, merged worktrees are pruned (WorktreeManager.pruneForArchived).
    const prunedTrees = worktrees === undefined ? [] : await worktrees.pruneForArchived(archived)
    return { containers: [...containers, ...idle], worktrees: prunedTrees }
  }

  const gc = setInterval(() => {
    void sweep().then((deleted) => {
      if (deleted.containers.length > 0) ctx.logger.info(`dsh-docker-sandbox: released containers: ${deleted.containers.join(", ")}`)
      if (deleted.worktrees.length > 0) ctx.logger.info(`dsh-docker-sandbox: pruned merged worktrees: ${deleted.worktrees.join(", ")}`)
    }, (error: unknown) => {
      ctx.logger.warn(`dsh-docker-sandbox: container GC pass failed: ${(error as Error).message}`)
    })
  }, config.gcIntervalMs)
  gc.unref?.()

  ctx.effect(() => () => {
    clearInterval(gc)
    if (!config.gcOnUnload) return
    // Cordis awaits effect disposers, so returning the promise makes quit wait for the `docker rm`s instead of racing them.
    return provisioner.releaseAll().then(
      (deleted) => ctx.logger.info(`dsh-docker-sandbox: removed ${deleted.length} sandbox container(s) on unload`),
      (error: unknown) => ctx.logger.warn(`dsh-docker-sandbox: could not clean up on unload: ${(error as Error).message}`),
    )
  }, "dsh-docker-sandbox: sandbox lifecycle")
}
