import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SandboxConfig } from "../../config.ts"
import type { CliRunner } from "../git.ts"
import { gitDirFor, hostGitConfig, treesRootFor } from "./checkout.ts"
import { REGISTRY_FILE } from "./constants.ts"
import type { WorktreeEntry } from "./types.ts"

export class WorktreeRegistry {
  readonly entries = new Map<string, WorktreeEntry>()
  readonly roots = new Set<string>()
  private readonly loadedRoots = new Set<string>()

  constructor(
    private readonly git: CliRunner,
    private readonly config: SandboxConfig,
    private readonly warn: (key: string, message: string) => void,
  ) {}

  load(repoRoot: string): void {
    if (this.loadedRoots.has(repoRoot)) return
    this.loadedRoots.add(repoRoot)
    this.roots.add(repoRoot)
    try {
      const raw = JSON.parse(readFileSync(join(treesRootFor(this.config, repoRoot), REGISTRY_FILE), "utf8")) as {
        entries?: Record<string, WorktreeEntry>
      }
      for (const [sessionId, entry] of Object.entries(raw.entries ?? {})) {
        if (!this.entries.has(sessionId)) {
          if (typeof entry.hostGitDir !== "string" || entry.hostGitDir === "") {
            entry.hostGitDir = gitDirFor(this.git, entry)
          }
          if (typeof entry.gitConfig !== "object" || entry.gitConfig === null) {
            entry.gitConfig = hostGitConfig(this.git, entry.repoRoot)
          }
          if (typeof entry.prUrl !== "string") entry.prUrl = undefined
          this.entries.set(sessionId, entry)
        }
      }
    } catch {
    }
  }

  save(repoRoot: string): void {
    const root = treesRootFor(this.config, repoRoot)
    try {
      mkdirSync(root, { recursive: true })
      const entries: Record<string, WorktreeEntry> = {}
      for (const [sessionId, entry] of this.entries) {
        if (entry.repoRoot === repoRoot) entries[sessionId] = entry
      }
      writeFileSync(join(root, REGISTRY_FILE), JSON.stringify({ version: 1, entries }, null, 2))
    } catch (error) {
      this.warn(repoRoot, `could not write the worktree registry: ${(error as Error).message}`)
    }
  }
}
