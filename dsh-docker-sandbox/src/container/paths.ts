// container files are a Docker Desktop bind mount of the Windows workspace; drives mode maps paths by text transform
export type MountMode = "workspace" | "drives"

export interface SandboxMount {
  hostPath: string
  containerPath: string
}

// a worktree's .git file points into the main repo via a Windows path the container cannot see; mount the main .git too
export interface ExtraMount {
  mount: SandboxMount
  containerGitDir: string
  gitConfig: Record<string, string>
  // the app hands tools the session's original header cwd; paths under it must alias onto the worktree or be rejected
  aliasHost?: string
}

export class SandboxPathError extends Error {
  constructor(
    message: string,
    readonly code: "PATH_OUTSIDE_SANDBOX" | "PATH_INVALID",
  ) {
    super(message)
    this.name = "SandboxPathError"
  }
}

function normalize(input: string): string {
  const slashed = input.replace(/\\/g, "/")
  const collapsed = slashed.replace(/\/{2,}/g, "/")
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed
}

export function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
}

export function isWindowsPath(value: string): boolean {
  return isWindowsAbsolute(value) || /^\\\\/.test(value)
}

function resolveSegments(path: string): string {
  const absolute = path.startsWith("/")
  const out: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (out.length === 0) {
        if (!absolute) return ".."
        continue
      }
      out.pop()
      continue
    }
    out.push(segment)
  }
  return (absolute ? "/" : "") + out.join("/")
}

export class PathMapper {
  private readonly extraMounts = new Map<string, ExtraMount>()

  constructor(
    readonly mode: MountMode,
    readonly containerWorkspace: string,
  ) {}

  registerExtraMount(workspace: string, extra: ExtraMount): void {
    this.extraMounts.set(normalize(workspace), extra)
  }

  extraMountFor(workspace: string): ExtraMount | undefined {
    return this.extraMounts.get(normalize(workspace))
  }

  static windowsToDrive(path: string): string {
    if (!isWindowsAbsolute(path)) return normalize(path)
    const drive = path[0]!.toLowerCase()
    return normalize(`/${drive}/${path.slice(2)}`)
  }

  static driveToWindows(path: string): string | undefined {
    const match = /^\/([a-zA-Z])(\/.*)?$/.exec(normalize(path))
    if (!match) return undefined
    const drive = match[1]!.toUpperCase()
    const rest = (match[2] ?? "").replace(/\//g, "\\")
    return `${drive}:${rest || "\\"}`
  }

  mountsFor(workspace: string): SandboxMount[] {
    const extra = this.extraMounts.get(normalize(workspace))
    if (this.mode === "drives") {
      const drives = new Set<string>()
      if (isWindowsAbsolute(workspace)) drives.add(workspace[0]!.toLowerCase())
      drives.add("c")
      return [...drives].sort().map((drive) => ({
        hostPath: `${drive.toUpperCase()}:\\`,
        containerPath: `/${drive}`,
      }))
    }
    if (!isWindowsAbsolute(workspace)) {
      throw new SandboxPathError(
        `the session workspace "${workspace}" is not a Windows absolute path, so it cannot be bind-mounted into the sandbox`,
        "PATH_INVALID",
      )
    }
    const mounts = [{
      hostPath: workspace,
      containerPath: this.containerWorkspace,
    }]
    // in drives mode the drive mount already covers the main repo's `.git`; workspace mode needs it explicitly
    if (extra !== undefined) mounts.push(extra.mount)
    return mounts
  }

  workspaceHostPath(workspace: string): string {
    if (this.mode === "drives") return PathMapper.windowsToDrive(workspace)
    return this.mountsFor(workspace)[0]!.hostPath
  }

  toContainer(path: string, workspace: string): string {
    const raw = normalize(path)
    const root = this.containerRoot(workspace)
    if (raw === "") return root

    if (raw.startsWith("/")) {
      // a drive mount is always lower-cased, so `/F/x` and `/f/x` name one file
      if (this.mode === "drives" && /^\/[a-z](\/|$)/i.test(raw)) {
        return resolveSegments(`/${raw[1]!.toLowerCase()}${raw.slice(2)}`)
      }
      const driveRoot = PathMapper.windowsToDrive(workspace)
      if (this.mode === "workspace" && (raw === driveRoot || raw.startsWith(`${driveRoot}/`))) {
        return resolveSegments(`${root}${raw.slice(driveRoot.length)}`)
      }
      if (raw === root || raw.startsWith(`${root}/`)) {
        return resolveSegments(raw)
      }
      const extra = this.extraMounts.get(normalize(workspace))
      if (extra !== undefined) {
        const mounted = extra.mount.containerPath
        if (raw === mounted || raw.startsWith(`${mounted}/`)) return resolveSegments(raw)
        const hostDrive = PathMapper.windowsToDrive(extra.mount.hostPath)
        if (raw === hostDrive || raw.startsWith(`${hostDrive}/`)) {
          return resolveSegments(`${mounted}${raw.slice(hostDrive.length)}`)
        }
        if (extra.aliasHost !== undefined) {
          const aliasDrive = PathMapper.windowsToDrive(extra.aliasHost)
          if (raw === aliasDrive) return resolveSegments(root)
          if (raw.startsWith(`${aliasDrive}/`)) {
            return resolveSegments(`${root}${raw.slice(aliasDrive.length)}`)
          }
        }
      }
      throw new SandboxPathError(
        `"${path}" is outside the sandbox mount (${this.mode} mode mounts ${this.describeMounts(workspace)}); `
        + "run the command with a working directory inside the workspace, or set mountMode to \"drives\"",
        "PATH_OUTSIDE_SANDBOX",
      )
    }

    if (isWindowsAbsolute(path)) return this.toContainer(PathMapper.windowsToDrive(path), workspace)

    // a `..` that walks out of the mount is rejected, not resolved to a path the container happens to have
    const resolved = resolveSegments(`${root}/${raw}`)
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new SandboxPathError(
        `"${path}" resolves to "${resolved}", outside the sandbox mount (${this.mode} mode mounts ${this.describeMounts(workspace)})`,
        "PATH_OUTSIDE_SANDBOX",
      )
    }
    return resolved
  }

  toWindows(path: string, workspace: string): string | undefined {
    const raw = resolveSegments(normalize(path))
    const extra = this.extraMounts.get(normalize(workspace))
    if (extra !== undefined) {
      const mounted = extra.mount.containerPath
      if (raw === mounted || raw.startsWith(`${mounted}/`)) {
        const host = normalize(extra.mount.hostPath)
        return `${host.slice(0, 2)}${host.slice(2).replace(/\//g, "\\")}${raw.slice(mounted.length).replace(/\//g, "\\")}`
      }
    }
    if (this.mode === "workspace") {
      // unlike mountsFor, a non-Windows anchor reports "no host path" rather than throwing
      if (!isWindowsAbsolute(workspace)) return undefined
      const root = this.containerRoot()
      if (raw !== root && !raw.startsWith(`${root}/`)) return undefined
      const host = normalize(this.workspaceHostPath(workspace))
      // `host` is normalized to `F:/…`, so everything after the drive letter already begins with the joining separator
      return `${host.slice(0, 2)}${host.slice(2).replace(/\//g, "\\")}${raw.slice(root.length).replace(/\//g, "\\")}`
    }
    return PathMapper.driveToWindows(raw)
  }

  containerRoot(workspace?: string): string {
    if (this.mode === "drives") {
      return PathMapper.windowsToDrive(workspace ? workspaceDriveRoot(workspace) : "C:\\")
    }
    return this.containerWorkspace
  }

  private describeMounts(workspace: string): string {
    return this.mountsFor(workspace).map((mount) => `${mount.hostPath} → ${mount.containerPath}`).join(", ")
  }
}

function workspaceDriveRoot(workspace: string): string {
  return isWindowsAbsolute(workspace) ? `${workspace[0]!.toUpperCase()}:\\` : workspace
}
