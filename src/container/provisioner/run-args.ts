import type { SandboxConfig } from "../../config.ts"
import type { PathMapper, SandboxMount } from "../paths.ts"
import { COMPOSE_PROJECT_LABEL, composeProjectFor, OWNERSHIP_LABEL, SESSION_LABEL, type SandboxTarget } from "../session.ts"

function volumeArg(mount: SandboxMount): string {
  return `${mount.hostPath.replace(/\\/g, "/")}:${mount.containerPath}`
}

export function buildRunArgs(config: SandboxConfig, paths: PathMapper, target: SandboxTarget): string[] {
  const mounts = paths.mountsFor(target.workspace)
  const args: string[] = [
    "run",
    "-d",
    "--name",
    target.container,
    "--label",
    OWNERSHIP_LABEL,
    "--label",
    `${SESSION_LABEL}=${target.sessionId}`,
    "--label",
    `${COMPOSE_PROJECT_LABEL}=${composeProjectFor(target.workspace)}`,
    ...mounts.flatMap((mount) => ["-v", volumeArg(mount)]),
    "-w",
    paths.containerRoot(target.workspace),
  ]

  if (config.npmCacheHost !== "") {
    args.push("-v", volumeArg({ hostPath: config.npmCacheHost, containerPath: "/root/.npm" }))
  }

  const extra = paths.extraMountFor(target.workspace)
  if (extra !== undefined) {
    args.push(
      "-e",
      `GIT_DIR=${extra.containerGitDir}`,
      "-e",
      `GIT_WORK_TREE=${paths.containerRoot(target.workspace)}`,
    )
    const mirrored = Object.entries(extra.gitConfig)
    if (mirrored.length > 0) {
      args.push("-e", `GIT_CONFIG_COUNT=${mirrored.length}`)
      mirrored.forEach(([key, value], index) => {
        args.push("-e", `GIT_CONFIG_KEY_${index}=${key}`, "-e", `GIT_CONFIG_VALUE_${index}=${value}`)
      })
    }
  }

  const limits = config.resourceLimits
  const cpu = limits?.cpu.get()
  const memory = limits?.memory.get()
  const memorySwap = limits?.memorySwap.get()
  if (cpu) args.push("--cpus", cpu)
  if (memory) args.push("--memory", memory)
  if (memorySwap) args.push("--memory-swap", memorySwap)

  args.push(config.image.get(), ...config.command)
  return args
}
