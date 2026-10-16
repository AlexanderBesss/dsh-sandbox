import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SandboxConfig } from "../../config.ts"
import type { CliRunner } from "../git.ts"
import { PathMapper, type SandboxMount } from "../paths.ts"
import { slugDigest } from "../session.ts"
import { ADD_MS, QUICK_MS } from "./constants.ts"
import { tryGitSync } from "./probes.ts"
import type { WorktreeEntry } from "./types.ts"

const GIT_CONFIG_KEYS = ["core.autocrlf", "user.name", "user.email"]

export function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "")
}

export function treesRootFor(config: SandboxConfig, repoRoot: string): string {
  const trimmed = trimTrailingSeparators(repoRoot)
  const configured = config.worktreeRoot.get()
  if (configured !== "") {
    const leaf = trimmed.split(/[\\/]+/).pop() ?? "repo"
    return join(configured, `${leaf}-${slugDigest(trimmed.toLowerCase())}`)
  }
  return `${trimmed}.worktrees`
}

export function addWorktree(git: CliRunner, entry: WorktreeEntry, base?: string): void {
  const branchExists = tryGitSync(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${entry.branch}`], entry.repoRoot)?.code === 0
  const add = (): void => {
    if (branchExists) git.runSync(["worktree", "add", entry.worktreePath, entry.branch], { cwd: entry.repoRoot, timeoutMs: ADD_MS })
    else git.runSync(["worktree", "add", "-B", entry.branch, entry.worktreePath, base ?? "HEAD"], { cwd: entry.repoRoot, timeoutMs: ADD_MS })
  }
  try {
    add()
  } catch (first) {
    try {
      git.runSync(["worktree", "prune"], { cwd: entry.repoRoot, timeoutMs: QUICK_MS })
      add()
    } catch {
      throw first
    }
  }
}

export function gitDirFor(git: CliRunner, entry: Pick<WorktreeEntry, "worktreePath" | "repoRoot">): string {
  const detected = tryGitSync(git, ["rev-parse", "--absolute-git-dir"], entry.worktreePath)?.stdout.trim()
  if (detected !== undefined && detected !== "") return detected
  const leaf = trimTrailingSeparators(entry.worktreePath).split(/[\\/]+/).pop() ?? "worktree"
  return `${trimTrailingSeparators(entry.repoRoot)}/.git/worktrees/${leaf}`
}

export function hostGitConfig(git: CliRunner, cwd: string): Record<string, string> {
  const config: Record<string, string> = {}
  for (const key of GIT_CONFIG_KEYS) {
    const value = tryGitSync(git, ["config", "--get", key], cwd)?.stdout.trim()
    if (value !== undefined && value !== "") config[key] = value
  }
  return config
}

export function registerMount(paths: PathMapper, entry: WorktreeEntry): void {
  const gitHost = `${trimTrailingSeparators(entry.repoRoot)}/.git`
  paths.registerExtraMount(entry.worktreePath, {
    mount: { hostPath: gitHost, containerPath: PathMapper.windowsToDrive(gitHost) },
    containerGitDir: PathMapper.windowsToDrive(entry.hostGitDir),
    gitConfig: entry.gitConfig,
    aliasHost: entry.mainWorkspace,
    readOnlyMounts: lockGitSurfaces(paths, entry),
  })
}

// The gitdir mount has to stay writable for the container's own git, so the surfaces
// a container could use to steer the *host's* git are overlaid read-only instead.
// commondir and gitdir are the pointers that decide *which* gitdir a worktree reads:
// leaving them writable lets a container relocate the whole config surface that the
// rest of this list locks, and <worktree>/.git is the same pointer from the other side.
const LOCKED_GIT_SURFACES = ["config", "config.worktree", "hooks", "info", "commondir", "gitdir"] as const

export function lockGitSurfaces(paths: PathMapper, entry: WorktreeEntry): SandboxMount[] {
  const locked: SandboxMount[] = []
  for (const dir of [`${trimTrailingSeparators(entry.repoRoot)}/.git`, entry.hostGitDir]) {
    const root = trimTrailingSeparators(dir)
    if (root === "") continue
    for (const name of LOCKED_GIT_SURFACES) {
      const hostPath = `${root}/${name}`
      if (!existsSync(hostPath)) continue
      locked.push({ hostPath, containerPath: PathMapper.windowsToDrive(hostPath) })
    }
  }
  const dotGit = join(entry.worktreePath, ".git")
  if (existsSync(dotGit)) {
    const worktreeRoot = paths.mode === "drives"
      ? PathMapper.windowsToDrive(entry.worktreePath)
      : paths.containerRoot(entry.worktreePath)
    locked.push({ hostPath: dotGit, containerPath: `${worktreeRoot}/.git` })
  }
  return locked
}

export function lockfileHash(worktreePath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(join(worktreePath, "package-lock.json"))).digest("hex")
  } catch {
    return undefined
  }
}
