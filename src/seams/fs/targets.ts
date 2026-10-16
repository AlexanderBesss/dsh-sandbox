import { realpath as nodeRealpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { FsError, FsTargetKey, type FsTarget } from "@deepseek-ai/dsh-fs"
import type { SandboxContext } from "../../context.ts"
import type { SandboxConfig } from "../../config.ts"
import { isWindowsAbsolute, type PathMapper } from "../../container/paths.ts"
import { resolveTarget, SandboxSessionError, type SandboxTarget } from "../../container/session.ts"
import type { WorktreeManager } from "../../container/worktrees.ts"
import { isNotFound, outsideSandboxError } from "../fs-helpers.ts"

export type HostRealpath = (path: string) => Promise<string>

export interface FsDeps {
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
  realpath?: HostRealpath
}

const onWindows = process.platform === "win32"

const anchors = new WeakMap<FsTarget, string>()

function trySession(ctx: SandboxContext, deps: FsDeps): SandboxTarget | undefined {
  try {
    return resolveTarget(ctx, deps.config, deps.worktrees)
  } catch {
    return undefined
  }
}

function pathIdentity(path: string): string {
  const slashed = resolve(path).replace(/[\\/]+/g, "/")
  return onWindows ? slashed.toLowerCase() : slashed
}

function within(root: string, path: string): boolean {
  const parent = pathIdentity(root)
  const child = pathIdentity(path)
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
}

// Only the nearest existing ancestor can be realpath'd; the not-yet-existing tail is
// re-appended so a write that creates a new file still resolves inside the mount.
async function resolveThroughLinks(path: string, realpath: HostRealpath): Promise<{ real: string; tail: string[] } | undefined> {
  let current = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return { real: await realpath(current), tail }
    } catch (error) {
      if (!isNotFound(error)) return undefined
      const parent = dirname(current)
      if (parent === current) return undefined
      tail.unshift(basename(current))
      current = parent
    }
  }
}

// A mount root is resolved once per resolver: a bind mount moved or replaced mid-session
// keeps the root it had when it was first touched.
const realRoots = new WeakMap<HostRealpath, Map<string, string>>()

async function realMountRoot(mountRoot: string, realpath: HostRealpath): Promise<string | undefined> {
  let cache = realRoots.get(realpath)
  if (cache === undefined) {
    cache = new Map<string, string>()
    realRoots.set(realpath, cache)
  }
  const key = pathIdentity(mountRoot)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const resolved = await resolveThroughLinks(mountRoot, realpath)
  if (resolved === undefined) return undefined
  cache.set(key, resolved.real)
  return resolved.real
}

// The lexical mount check in PathMapper is not enough: the kernel resolves symlinks on the way
// to the file, so containment is re-checked against the resolved path before any host I/O.
async function resolveContainedHostPath(
  hostPath: string,
  realRoot: string,
  displayPath: string,
  realpath: HostRealpath,
): Promise<string> {
  const linked = await resolveThroughLinks(hostPath, realpath)
  if (linked === undefined) throw outsideSandboxError(displayPath)
  const resolved = linked.tail.length === 0 ? linked.real : join(linked.real, ...linked.tail)
  if (!within(realRoot, resolved)) throw outsideSandboxError(displayPath)
  return resolved
}

function mountRoots(ctx: SandboxContext, deps: FsDeps, target: FsTarget, host: string): string[] {
  const anchor = anchors.get(target) ?? trySession(ctx, deps)?.workspace
  if (anchor !== undefined) {
    try {
      return deps.paths.mountsFor(anchor).map((mount) => mount.hostPath)
    } catch {
      return []
    }
  }
  const drive = /^[A-Za-z]:/.exec(host)
  return deps.paths.mode === "drives" && drive !== null ? [`${drive[0]}\\`] : []
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
  const target: FsTarget = {
    path: containerPath,
    targetKey: FsTargetKey(containerPath),
    displayPath: containerPath,
    ...(hostPath ? { hostPath } : {}),
  }
  anchors.set(target, anchor)
  return target
}

export function childTarget(target: FsTarget, name: string): FsTarget {
  const child: FsTarget = {
    path: `${target.path}/${name}`,
    targetKey: FsTargetKey(`${String(target.targetKey)}/${name}`),
    displayPath: `${target.displayPath}/${name}`,
    ...(target.hostPath === undefined ? {} : { hostPath: join(target.hostPath, name) }),
  }
  const anchor = anchors.get(target)
  if (anchor !== undefined) anchors.set(child, anchor)
  return child
}

export function fsHostPath(ctx: SandboxContext, deps: FsDeps, target: FsTarget): string {
  if (typeof target.hostPath === "string" && target.hostPath !== "") return target.hostPath
  const session = trySession(ctx, deps)
  const mapped = session === undefined ? undefined : deps.paths.toWindows(target.path ?? target.displayPath, session.workspace)
  if (mapped === undefined) {
    throw new FsError(`"${target.displayPath}" has no host file behind it; it is outside the sandbox mount`, "FS_IO_ERROR")
  }
  return mapped
}

export async function fsHostOf(ctx: SandboxContext, deps: FsDeps, target: FsTarget): Promise<string> {
  const realpath = deps.realpath ?? nodeRealpath
  const host = fsHostPath(ctx, deps, target)
  const root = mountRoots(ctx, deps, target, host).find((candidate) => within(candidate, host))
  if (root === undefined) throw outsideSandboxError(target.displayPath)
  const realRoot = await realMountRoot(root, realpath)
  if (realRoot === undefined) throw outsideSandboxError(target.displayPath)
  return resolveContainedHostPath(host, realRoot, target.displayPath, realpath)
}
