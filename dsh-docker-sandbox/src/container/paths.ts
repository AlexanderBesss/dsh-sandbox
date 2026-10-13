/**
 * Path translation between the two worlds one chat straddles.
 *
 * ```
 * Windows            F:\Projects\dsh-sandbox
 *   │  bind mount (Docker Desktop drive sharing)
 * container          /workspace            (workspace mode)
 *                  or /f/Projects/dsh-sandbox (drives mode)
 * ```
 *
 * The model and every tool speak the container world: `ctx.fs` targets, `read`
 * / `write` paths, and shell `cd` targets are container paths. The host-side
 * file tools keep seeing the same bytes because the volume is a bind mount of
 * the Windows workspace (Docker Desktop shares drives into its VM natively, so
 * no intermediate WSL path exists).
 *
 * Two mount modes are supported:
 *
 * - `workspace` (default): only the session workspace is mounted, at
 *   `containerWorkspace`. A path outside it is rejected with a named error
 *   rather than silently reaching host files.
 * - `drives`: every Windows drive root is mounted at `/<drive-letter>`, so
 *   mapping is a pure textual transform and any absolute Windows path has a
 *   container equivalent.
 *
 * @module dsh-docker-sandbox/container/paths
 */

export type MountMode = "workspace" | "drives"

/** One bind mount: Windows-visible source mounted at a container path. */
export interface SandboxMount {
  /** Volume source as Windows sees it (what `docker run -v` gets as host path). */
  hostPath: string
  /** Where it appears inside the container. */
  containerPath: string
}

/** A path that cannot be expressed inside the sandbox. */
export class SandboxPathError extends Error {
  constructor(
    message: string,
    readonly code: "PATH_OUTSIDE_SANDBOX" | "PATH_INVALID",
  ) {
    super(message)
    this.name = "SandboxPathError"
  }
}

/** Normalize Windows separators and collapse redundant slashes. */
function normalize(input: string): string {
  const slashed = input.replace(/\\/g, "/")
  const collapsed = slashed.replace(/\/{2,}/g, "/")
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed
}

/** True for `C:\…`, `C:/…` (a Windows absolute path with a drive letter). */
export function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
}

/** True for anything that looks like a Windows path: a drive-letter root or a UNC share. */
export function isWindowsPath(value: string): boolean {
  return isWindowsAbsolute(value) || /^\\\\/.test(value)
}

/** Resolve `.` / `..` segments without touching the filesystem. */
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
  constructor(
    readonly mode: MountMode,
    readonly containerWorkspace: string,
  ) {}

  /**
   * Translate a Windows path to the path the same file has under a drive-root
   * mount (`F:\Projects\x` → `/f/Projects/x`). Paths that are already POSIX
   * (container paths) pass through unchanged.
   *
   * @param path - Windows or container path.
   * @returns the container-world drive form.
   */
  static windowsToDrive(path: string): string {
    if (!isWindowsAbsolute(path)) return normalize(path)
    const drive = path[0]!.toLowerCase()
    return normalize(`/${drive}/${path.slice(2)}`)
  }

  /**
   * Translate a `/<drive>/…` path back to its Windows form.
   *
   * @param path - container path under a mounted drive root.
   * @returns the Windows form, or undefined when the path is not drive-backed.
   */
  static driveToWindows(path: string): string | undefined {
    const match = /^\/([a-zA-Z])(\/.*)?$/.exec(normalize(path))
    if (!match) return undefined
    const drive = match[1]!.toUpperCase()
    const rest = (match[2] ?? "").replace(/\//g, "\\")
    return `${drive}:${rest || "\\"}`
  }

  /**
   * Build the volume plan for one session workspace.
   *
   * @param workspace - Windows path of the session workspace.
   * @returns the bind mounts the sandbox container needs.
   */
  mountsFor(workspace: string): SandboxMount[] {
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
    return [{
      hostPath: workspace,
      containerPath: this.containerWorkspace,
    }]
  }

  /** The Windows path of the session workspace (the volume source). */
  workspaceHostPath(workspace: string): string {
    if (this.mode === "drives") return PathMapper.windowsToDrive(workspace)
    return this.mountsFor(workspace)[0]!.hostPath
  }

  /**
   * Translate any accepted path form into the container path.
   *
   * Accepts container paths, drive-mounted paths (`/f/…`), Windows absolute
   * paths, and relative paths (resolved against the container workspace).
   *
   * @param path - the path as a caller wrote it.
   * @param workspace - Windows path of the session workspace.
   * @returns the container-world path.
   * @throws {SandboxPathError} when the path has no container equivalent.
   */
  toContainer(path: string, workspace: string): string {
    const raw = normalize(path)
    const root = this.containerRoot(workspace)
    if (raw === "") return root

    // Already a container path.
    if (raw.startsWith("/")) {
      // A drive mount is always lower-cased, so `/F/x` and `/f/x` name one file.
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
      throw new SandboxPathError(
        `"${path}" is outside the sandbox mount (${this.mode} mode mounts ${this.describeMounts(workspace)}); `
        + "run the command with a working directory inside the workspace, or set mountMode to \"drives\"",
        "PATH_OUTSIDE_SANDBOX",
      )
    }

    if (isWindowsAbsolute(path)) return this.toContainer(PathMapper.windowsToDrive(path), workspace)

    // Relative: resolve inside the container workspace. A `..` that walks out
    // of the mount is rejected rather than resolved to a path the container
    // happens to have (which would read as host access the plugin does not
    // grant).
    const resolved = resolveSegments(`${root}/${raw}`)
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new SandboxPathError(
        `"${path}" resolves to "${resolved}", outside the sandbox mount (${this.mode} mode mounts ${this.describeMounts(workspace)})`,
        "PATH_OUTSIDE_SANDBOX",
      )
    }
    return resolved
  }

  /**
   * Translate a container path back to the Windows path a host tool would use.
   *
   * @param path - container path.
   * @param workspace - Windows path of the session workspace.
   * @returns the Windows form, or undefined when it has none — including when
   *   the anchor itself is not a Windows path, which leaves no host file to name.
   */
  toWindows(path: string, workspace: string): string | undefined {
    const raw = resolveSegments(normalize(path))
    if (this.mode === "workspace") {
      // `mountsFor` refuses a non-Windows anchor; this method reports "no host
      // path" instead, so a caller anchoring on a container path still gets a
      // usable target rather than a mapping error.
      if (!isWindowsAbsolute(workspace)) return undefined
      const root = this.containerRoot()
      if (raw !== root && !raw.startsWith(`${root}/`)) return undefined
      const host = normalize(this.workspaceHostPath(workspace))
      // `host` is normalized to `F:/…`, so everything after the drive letter
      // already begins with the separator that joins it to the container part.
      return `${host.slice(0, 2)}${host.slice(2).replace(/\//g, "\\")}${raw.slice(root.length).replace(/\//g, "\\")}`
    }
    return PathMapper.driveToWindows(raw)
  }

  /**
   * The container path a session's commands start in.
   *
   * @param workspace - Windows path of the session workspace; in `drives` mode
   *   this picks the drive root the session lives on.
   */
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

/** The drive root of a Windows path, e.g. `F:\\`. */
function workspaceDriveRoot(workspace: string): string {
  return isWindowsAbsolute(workspace) ? `${workspace[0]!.toUpperCase()}:\\` : workspace
}
