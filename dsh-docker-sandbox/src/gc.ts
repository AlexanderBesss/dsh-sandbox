/**
 * The container GC loop.
 *
 * One pass: archived conversations first (their archive may be event-free),
 * then the idle sweep. The loop runs on a timer, is disposed with the plugin
 * fiber, and — when `gcOnUnload` is on — releases every owned container
 * during shutdown, so leaving sandbox containers behind after nothing is
 * driving them is not a leak.
 *
 * @module dsh-docker-sandbox/gc
 */

import type { SandboxContext } from "./context.ts"
import type { SandboxConfig } from "./config.ts"
import type { Provisioner } from "./provisioner.ts"

/** Start the periodic sweep and its shutdown cleanup, disposed with the fiber. */
export function startContainerGc(ctx: SandboxContext, provisioner: Provisioner, config: SandboxConfig): void {
  let registryReported = false
  const sweep = async (): Promise<string[]> => {
    const registry = ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined
    if (registry?.archivedSessionIds === undefined && !registryReported) {
      // `ctx.get` answers `undefined` for a name nobody provides, so a missing
      // registry would otherwise look like "nothing is archived" forever.
      registryReported = true
      ctx.logger.warn("dsh-docker-sandbox: no workspace registry in reach; archived containers are reclaimed by idle TTL only")
    }
    const archived = await provisioner.releaseArchived(new Set(registry?.archivedSessionIds ?? []))
    const idle = await provisioner.collectIdle()
    return [...archived, ...idle]
  }

  const gc = setInterval(() => {
    void sweep().then((deleted) => {
      if (deleted.length > 0) ctx.logger.info(`dsh-docker-sandbox: released containers: ${deleted.join(", ")}`)
    }, (error: unknown) => {
      ctx.logger.warn(`dsh-docker-sandbox: container GC pass failed: ${(error as Error).message}`)
    })
  }, config.gcIntervalMs)
  gc.unref?.()

  ctx.effect(() => () => {
    clearInterval(gc)
    if (!config.gcOnUnload) return
    // Return the promise: Cordis awaits effect disposers during shutdown, so
    // the app quit actually waits for the `docker rm`s instead of racing them.
    return provisioner.releaseAll().then(
      (deleted) => ctx.logger.info(`dsh-docker-sandbox: removed ${deleted.length} sandbox container(s) on unload`),
      (error: unknown) => ctx.logger.warn(`dsh-docker-sandbox: could not clean up on unload: ${(error as Error).message}`),
    )
  }, "dsh-docker-sandbox: sandbox lifecycle")
}
