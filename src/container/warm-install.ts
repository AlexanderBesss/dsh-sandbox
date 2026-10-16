
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { SandboxConfig } from "../config.ts"
import type { BootstrapLogger } from "./bootstrap.ts"
import type { DockerTransport } from "./transport.ts"
import type { Provisioner } from "./provisioner.ts"
import type { SandboxTarget } from "./session.ts"
import { containerNameFor } from "./session.ts"
import type { WorktreeEntry, WorktreeManager } from "./worktrees.ts"

export interface WarmInstallDeps {
  transport: DockerTransport
  provisioner: Provisioner
  worktrees: WorktreeManager
  config: SandboxConfig
  logger?: BootstrapLogger
}

export function installCommandFor(workspace: string, scripts = false): string | undefined {
  if (!existsSync(join(workspace, "package-lock.json"))) return undefined
  return scripts ? "npm ci --prefer-offline" : "npm ci --prefer-offline --ignore-scripts"
}

function runInstall(deps: WarmInstallDeps, target: SandboxTarget, command: string, onDone?: () => void): void {
  const release = deps.provisioner.beginWork(target.sessionId)
  const started = Date.now()
  deps.logger?.info?.(
    `dsh-docker-sandbox: updating session ${target.sessionId} worktree dependencies with "${command}" (background)`,
  )
  void deps.transport
    .execInContainer(target, ["/bin/sh", "-lc", command], { timeoutMs: deps.config.warmInstallTimeoutMs })
    .then(
      (result) => {
        if (result.code === 0) {
          onDone?.()
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

export function createWarmInstall(deps: WarmInstallDeps): (target: SandboxTarget) => void {
  const warmed = new Set<string>()
  return (target: SandboxTarget): void => {
    if (!deps.config.worktreeInstall.get()) return
    if (warmed.has(target.sessionId)) return
    warmed.add(target.sessionId)
    const entry = deps.worktrees.lookup(target.sessionId, target.workspace)
    if (entry === undefined) return
    if (existsSync(join(entry.worktreePath, "node_modules"))) return
    const command = installCommandFor(entry.worktreePath, deps.config.worktreeInstallScripts.get())
    if (command === undefined) {
      deps.logger?.info?.(
        `dsh-docker-sandbox: worktree "${entry.worktreePath}" has no package-lock.json, so no warm install was run`,
      )
      return
    }
    runInstall(deps, target, command, () => deps.worktrees.markInstalled?.(target.sessionId, target.workspace))
  }
}

export function createTreeReinstall(deps: WarmInstallDeps): (entry: WorktreeEntry) => void {
  return (entry: WorktreeEntry): void => {
    if (!deps.config.worktreeInstall.get()) return
    if (!existsSync(join(entry.worktreePath, "node_modules"))) return
    const command = installCommandFor(entry.worktreePath, deps.config.worktreeInstallScripts.get())
    if (command === undefined) return
    runInstall(
      deps,
      { sessionId: entry.sessionId, container: containerNameFor(entry.sessionId), workspace: entry.mainWorkspace, shared: false },
      command,
      () => deps.worktrees.markInstalled?.(entry.sessionId, entry.mainWorkspace),
    )
  }
}
