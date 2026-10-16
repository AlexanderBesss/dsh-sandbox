import {
  driveToWindowsPath,
  hostToWindows,
  isUnder,
  isWindowsAbsolute,
  normalize,
  resolveSegments,
  windowsSuffix,
  windowsToDrivePath,
  workspaceDriveRoot,
} from "./paths/geometry.ts"

export { isWindowsAbsolute, isWindowsPath } from "./paths/geometry.ts"

export type MountMode = "workspace" | "drives"

export interface SandboxMount {
  hostPath: string
  containerPath: string
}

export interface ExtraMount {
  mount: SandboxMount
  containerGitDir: string
  gitConfig: Record<string, string>
  aliasHost?: string
  readOnlyMounts?: SandboxMount[]
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
    return windowsToDrivePath(path)
  }

  static driveToWindows(path: string): string | undefined {
    return driveToWindowsPath(path)
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
    if (extra !== undefined) mounts.push(extra.mount)
    return mounts
  }

  workspaceHostPath(workspace: string): string {
    if (this.mode === "drives") return windowsToDrivePath(workspace)
    return this.mountsFor(workspace)[0]!.hostPath
  }

  toContainer(path: string, workspace: string): string {
    const raw = normalize(path)
    const root = this.containerRoot(workspace)
    if (raw === "") return root

    if (raw.startsWith("/")) {
      const mapped = this.resolveMountedPath(raw, workspace, root)
      if (mapped !== undefined) return mapped
      throw new SandboxPathError(
        `"${path}" is outside the sandbox mount (${this.mode} mode mounts ${this.describeMounts(workspace)}); `
        + "run the command with a working directory inside the workspace, or set mountMode to \"drives\"",
        "PATH_OUTSIDE_SANDBOX",
      )
    }

    if (isWindowsAbsolute(path)) return this.toContainer(windowsToDrivePath(path), workspace)

    const resolved = resolveSegments(`${root}/${raw}`)
    if (!isUnder(resolved, root)) {
      throw new SandboxPathError(
        `"${path}" resolves to "${resolved}", outside the sandbox mount (${this.mode} mode mounts ${this.describeMounts(workspace)})`,
        "PATH_OUTSIDE_SANDBOX",
      )
    }
    return resolved
  }

  private resolveMountedPath(raw: string, workspace: string, root: string): string | undefined {
    // Collapse before testing containment: a prefix test on an un-collapsed path
    // passes for "/workspace/../../etc/passwd", and the kernel resolves ".." later.
    const collapsed = resolveSegments(raw)

    if (this.mode === "drives") {
      const drive = /^\/([a-z])(\/.*)?$/i.exec(collapsed)
      if (drive === null) return undefined
      const containerRoot = `/${drive[1]!.toLowerCase()}`
      const mounted = this.mountsFor(workspace).some((mount) => mount.containerPath === containerRoot)
      return mounted ? `${containerRoot}${drive[2] ?? ""}` : undefined
    }

    if (this.mode === "workspace") {
      const driveRoot = windowsToDrivePath(workspace)
      if (isUnder(collapsed, driveRoot)) {
        const mapped = resolveSegments(`${root}${collapsed.slice(driveRoot.length)}`)
        return isUnder(mapped, root) ? mapped : undefined
      }
    }

    if (isUnder(collapsed, root)) return collapsed

    const extra = this.extraMounts.get(normalize(workspace))
    if (extra === undefined) return undefined
    const mounted = extra.mount.containerPath
    if (isUnder(collapsed, mounted)) return collapsed
    const hostDrive = windowsToDrivePath(extra.mount.hostPath)
    if (isUnder(collapsed, hostDrive)) {
      const mapped = resolveSegments(`${mounted}${collapsed.slice(hostDrive.length)}`)
      return isUnder(mapped, mounted) ? mapped : undefined
    }
    if (extra.aliasHost !== undefined) {
      const aliasDrive = windowsToDrivePath(extra.aliasHost)
      if (collapsed === aliasDrive) return resolveSegments(root)
      if (isUnder(collapsed, aliasDrive)) {
        const mapped = resolveSegments(`${root}${collapsed.slice(aliasDrive.length)}`)
        return isUnder(mapped, root) ? mapped : undefined
      }
    }
    return undefined
  }

  toWindows(path: string, workspace: string): string | undefined {
    const raw = resolveSegments(normalize(path))
    const extra = this.extraMounts.get(normalize(workspace))
    if (extra !== undefined && isUnder(raw, extra.mount.containerPath)) {
      return `${hostToWindows(normalize(extra.mount.hostPath))}${windowsSuffix(raw, extra.mount.containerPath)}`
    }
    if (this.mode === "workspace") {
      if (!isWindowsAbsolute(workspace)) return undefined
      const root = this.containerRoot()
      if (!isUnder(raw, root)) return undefined
      return `${hostToWindows(normalize(this.workspaceHostPath(workspace)))}${windowsSuffix(raw, root)}`
    }
    const drive = /^\/([a-z])(\/.*)?$/i.exec(raw)
    if (drive === null) return undefined
    const containerRoot = `/${drive[1]!.toLowerCase()}`
    if (!this.mountsFor(workspace).some((mount) => mount.containerPath === containerRoot)) return undefined
    return driveToWindowsPath(raw)
  }

  containerRoot(workspace?: string): string {
    if (this.mode === "drives") {
      return windowsToDrivePath(workspace ? workspaceDriveRoot(workspace) : "C:\\")
    }
    return this.containerWorkspace
  }

  private describeMounts(workspace: string): string {
    return this.mountsFor(workspace).map((mount) => `${mount.hostPath} → ${mount.containerPath}`).join(", ")
  }
}
