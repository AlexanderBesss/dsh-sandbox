export function normalize(input: string): string {
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

export function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

export function resolveSegments(path: string): string {
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

export function windowsToDrivePath(path: string): string {
  if (!isWindowsAbsolute(path)) return normalize(path)
  const drive = path[0]!.toLowerCase()
  return normalize(`/${drive}/${path.slice(2)}`)
}

export function driveToWindowsPath(path: string): string | undefined {
  const match = /^\/([a-zA-Z])(\/.*)?$/.exec(normalize(path))
  if (!match) return undefined
  const drive = match[1]!.toUpperCase()
  const rest = (match[2] ?? "").replace(/\//g, "\\")
  return `${drive}:${rest || "\\"}`
}

export function hostToWindows(host: string): string {
  return `${host.slice(0, 2)}${host.slice(2).replace(/\//g, "\\")}`
}

export function windowsSuffix(raw: string, prefix: string): string {
  return raw.slice(prefix.length).replace(/\//g, "\\")
}

export function workspaceDriveRoot(workspace: string): string {
  return isWindowsAbsolute(workspace) ? `${workspace[0]!.toUpperCase()}:\\` : workspace
}
