/**
 * The worktree warm install: a fresh worktree gets its dependencies in the
 * container, in the background.
 *
 * A `git worktree add` checks out tracked files only, so a session's worktree
 * never has `node_modules` (it is gitignored), and the main checkout's tree is
 * no use: it carries Windows binaries (`@rolldown/binding-win32-x64-msvc`)
 * that a Linux container cannot load. So the container installs its own —
 * pinned to the lockfile (`npm ci`), warm from the shared npm cache
 * (`npmCacheHost`), and only for worktree sessions: installing into a *shared*
 * checkout would replace the host's own `node_modules` with Linux binaries.
 *
 * It is background work, not a gate: the chat answers while it runs, the
 * container holds a work lease so the GC sweep cannot reclaim it mid-install,
 * and a failure only logs — the agent can always install by hand.
 *
 * @module dsh-docker-sandbox/container/warm-install
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { SandboxConfig } from "../config.ts"
import type { BootstrapLogger } from "./bootstrap.ts"
import type { DockerTransport } from "./transport.ts"
import type { Provisioner } from "./provisioner.ts"
import type { SandboxTarget } from "./session.ts"
import type { WorktreeManager } from "./worktrees.ts"

export interface WarmInstallDeps {
  transport: DockerTransport
  provisioner: Provisioner
  worktrees: WorktreeManager
  config: SandboxConfig
  logger?: BootstrapLogger
}

/** The install command one lockfile implies, or undefined when none does. */
export function installCommandFor(workspace: string): string | undefined {
  if (existsSync(join(workspace, "package-lock.json"))) return "npm ci --prefer-offline"
  // pnpm/bun/yarn are not in the sandbox image, and corepack would need a
  // network round trip the first time; a session that wants one can run it.
  return undefined
}

/**
 * Build the `onContainerReady` handler that warms one session's worktree.
 *
 * @returns a fire-and-forget handler for the provisioner hook.
 */
export function createWarmInstall(deps: WarmInstallDeps): (target: SandboxTarget) => void {
  /** Sessions already warmed (or already answered "nothing to do") here. */
  const warmed = new Set<string>()
  return (target: SandboxTarget): void => {
    if (!deps.config.worktreeInstall.get()) return
    if (warmed.has(target.sessionId)) return
    warmed.add(target.sessionId)
    // Only a session that actually owns a worktree: the host path of the
    // container's workspace is the worktree itself, and a shared checkout's
    // node_modules belongs to the host.
    const entry = deps.worktrees.lookup(target.sessionId, target.workspace)
    if (entry === undefined) return
    if (existsSync(join(entry.worktreePath, "node_modules"))) return
    const command = installCommandFor(entry.worktreePath)
    if (command === undefined) {
      deps.logger?.info?.(
        `dsh-docker-sandbox: worktree "${entry.worktreePath}" has no package-lock.json, so no warm install was run`,
      )
      return
    }
    const release = deps.provisioner.beginWork(target.sessionId)
    const started = Date.now()
    deps.logger?.info?.(
      `dsh-docker-sandbox: warming session ${target.sessionId} worktree with "${command}" (background)`,
    )
    void deps.transport
      .execInContainer(target, ["/bin/sh", "-lc", command], { timeoutMs: deps.config.warmInstallTimeoutMs })
      .then(
        (result) => {
          if (result.code === 0) {
            deps.logger?.info?.(
              `dsh-docker-sandbox: worktree install finished in ${Date.now() - started} ms`,
            )
          } else {
            deps.logger?.warn?.(
              `dsh-docker-sandbox: worktree install failed (exit ${result.code}): `
              + result.stderr.toString("utf8").trim().split("\n").slice(-3).join(" | "),
            )
          }
        },
        (error: unknown) => {
          deps.logger?.warn?.(`dsh-docker-sandbox: worktree install failed: ${(error as Error).message}`)
        },
      )
      .finally(release)
  }
}
