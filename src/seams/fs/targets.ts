import { join } from "node:path"
import { FsError, FsTargetKey, type FsTarget } from "@deepseek-ai/dsh-fs"
import type { SandboxContext } from "../../context.ts"
import type { SandboxConfig } from "../../config.ts"
import { isWindowsAbsolute, type PathMapper } from "../../container/paths.ts"
import { resolveTarget, SandboxSessionError } from "../../container/session.ts"
import type { WorktreeManager } from "../../container/worktrees.ts"

export interface FsDeps {
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
}

function trySession(ctx: SandboxContext, deps: FsDeps) {
  try {
    return resolveTarget(ctx, deps.config, deps.worktrees)
  } catch {
    return undefined
  }
}

export function fsTargetFor(ctx: SandboxContext, deps: FsDeps, path: string, cwd?: string): FsTarget {
  const session = trySession(ctx, deps)
  const anchor = session?.workspace ?? cwd ?? (isWindowsAbsolute(path) ? path : undefined)
  if (anchor === undefined) {
    throw new SandboxSessionError(
      "this call is not running inside a conversation and names no working directory, so its path has no sandbox root",
      "NO_SESSION",
    )
  }
  const joined = cwd !== undefined && !path.startsWith("/") && !isWindowsAbsolute(path) ? `${cwd}/${path}` : path
  const containerPath = deps.paths.toContainer(joined, anchor)
  const hostPath = deps.paths.toWindows(containerPath, anchor)
  return {
    path: containerPath,
    targetKey: FsTargetKey(containerPath),
    displayPath: containerPath,
    ...(hostPath ? { hostPath } : {}),
  }
}

export function fsHostOf(ctx: SandboxContext, deps: FsDeps, target: FsTarget): string {
  if (typeof target.hostPath === "string" && target.hostPath !== "") return target.hostPath
  const session = trySession(ctx, deps)
  const mapped = session === undefined ? undefined : deps.paths.toWindows(target.path ?? target.displayPath, session.workspace)
  if (mapped === undefined) {
    throw new FsError(`"${target.displayPath}" has no host file behind it; it is outside the sandbox mount`, "FS_IO_ERROR")
  }
  return mapped
}

export function childTarget(target: FsTarget, name: string): FsTarget {
  return {
    path: `${target.path}/${name}`,
    targetKey: FsTargetKey(`${String(target.targetKey)}/${name}`),
    displayPath: `${target.displayPath}/${name}`,
    ...(target.hostPath === undefined ? {} : { hostPath: join(target.hostPath, name) }),
  }
}
