import type { SandboxConfig } from "../../config.ts"
import type { CliRunner } from "../git.ts"
import { FETCH_MS } from "./constants.ts"
import { errorDetail } from "./errors.ts"
import { remoteBranchExists, tryGitSync } from "./probes.ts"

export class OriginTracker {
  private readonly lastFetch = new Map<string, { at: number; ok: boolean }>()
  private readonly fetchInflight = new Map<string, Promise<boolean>>()

  constructor(
    private readonly git: CliRunner,
    private readonly config: SandboxConfig,
    private readonly warn: (key: string, message: string) => void,
  ) {}

  cachedRef(repoRoot: string): string | undefined {
    if (this.lastFetch.get(repoRoot)?.ok !== true) return undefined
    return this.resolvedRef(repoRoot)
  }

  async refFor(repoRoot: string): Promise<string | undefined> {
    if (!await this.fetch(repoRoot)) return undefined
    return this.resolvedRef(repoRoot)
  }

  refForSync(repoRoot: string): string | undefined {
    if (!this.fetchSync(repoRoot)) return undefined
    return this.resolvedRef(repoRoot)
  }

  private resolvedRef(repoRoot: string): string | undefined {
    const branch = this.mainBranchFor(repoRoot)
    if (branch === undefined || remoteBranchExists(this.git, repoRoot, branch) !== true) return undefined
    return `origin/${branch}`
  }

  private mainBranchFor(repoRoot: string): string | undefined {
    const out = tryGitSync(this.git, ["symbolic-ref", "--short", "HEAD"], repoRoot)?.stdout.trim()
    return out === undefined || out === "" ? undefined : out
  }

  private fetchBudget(repoRoot: string): boolean | undefined {
    const seen = this.lastFetch.get(repoRoot)
    if (seen !== undefined && Date.now() - seen.at < this.config.worktreeSyncIntervalMs) return seen.ok
    return undefined
  }

  private recordFetch(repoRoot: string, ok: boolean, error?: unknown): boolean {
    if (!ok) {
      this.warn(`${repoRoot}\u0000fetch`, `could not fetch origin in ${repoRoot}: ${errorDetail(error)}; worktrees keep their current base`)
    }
    this.lastFetch.set(repoRoot, { at: Date.now(), ok })
    return ok
  }

  private fetchSync(repoRoot: string): boolean {
    const budget = this.fetchBudget(repoRoot)
    if (budget !== undefined) return budget
    try {
      this.git.runSync(["fetch", "origin"], { cwd: repoRoot, timeoutMs: FETCH_MS })
      return this.recordFetch(repoRoot, true)
    } catch (error) {
      return this.recordFetch(repoRoot, false, error)
    }
  }

  // The turn-start and GC sync paths must not block the host event loop on a
  // network fetch; only worktree creation (already synchronous) uses the sync one.
  private fetch(repoRoot: string): Promise<boolean> {
    const running = this.fetchInflight.get(repoRoot)
    if (running !== undefined) return running
    const budget = this.fetchBudget(repoRoot)
    if (budget !== undefined) return Promise.resolve(budget)
    const run = this.git
      .run(["fetch", "origin"], { cwd: repoRoot, timeoutMs: FETCH_MS })
      .then(
        () => this.recordFetch(repoRoot, true),
        (error: unknown) => this.recordFetch(repoRoot, false, error),
      )
    this.fetchInflight.set(repoRoot, run)
    run.finally(() => {
      if (this.fetchInflight.get(repoRoot) === run) this.fetchInflight.delete(repoRoot)
    })
    return run
  }
}
