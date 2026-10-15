import { existsSync } from "node:fs"
import { join } from "node:path"
import { collectConflicts, conflictedFiles } from "../conflicts.ts"
import { CliCommandError } from "../git.ts"
import { collectChanges, type SessionChanges } from "../review.ts"
import { branchSlugFor } from "../session.ts"
import { addWorktree, gitDirFor, hostGitConfig, lockfileHash, registerMount, treesRootFor } from "./checkout.ts"
import { PUSH_MS, QUICK_MS } from "./constants.ts"
import type { ManagerContext } from "./context.ts"
import { errorDetail } from "./errors.ts"
import {
  applyBriefName,
  briefFor,
  branchLog,
  commitSubject,
  commitWorktree,
  isDirty,
  openPullRequest,
  prFacts,
  pushOrigin,
} from "./merge-request.ts"
import { OriginTracker } from "./origin.ts"
import { countBehind, isMerging, tryGit } from "./probes.ts"
import { WorktreeRegistry } from "./registry.ts"
import { syncEntry } from "./sync.ts"
import type {
  ConflictBundle,
  MergeRequestResult,
  SyncOutcome,
  WorktreeDeps,
  WorktreeEntry,
  WorktreeInfo,
} from "./types.ts"

export class WorktreeManager {
  private readonly failures = new Map<string, string>()
  private readonly warned = new Set<string>()
  private readonly registry: WorktreeRegistry
  private readonly origin: OriginTracker
  private readonly ctx: ManagerContext

  constructor(private readonly deps: WorktreeDeps) {
    const warn = (key: string, message: string): void => this.warnOnce(key, message)
    this.registry = new WorktreeRegistry(deps.git, deps.config, warn)
    this.origin = new OriginTracker(deps.git, deps.config, warn)
    this.ctx = { deps, registry: this.registry, origin: this.origin }
  }

  get enabled(): boolean {
    return this.deps.config.worktree.get()
  }

  ensure(sessionId: string, workspace: string, parentSessionId?: string): WorktreeEntry | undefined {
    if (!this.enabled) return undefined
    const cached = this.registry.entries.get(sessionId)
    if (cached !== undefined) return this.verify(cached)
    if (this.failures.has(sessionId)) return undefined
    if (parentSessionId !== undefined) {
      const parent = this.lookup(parentSessionId, workspace)
      if (parent !== undefined) return this.verify(parent)
    }
    try {
      const repoRoot = this.repoRootFor(workspace)
      if (repoRoot === undefined) {
        this.warnOnce(workspace,
          `workspace "${workspace}" is not a git checkout, so session ${sessionId} shares it like before`)
        return undefined
      }
      this.registry.load(repoRoot)
      const known = this.registry.entries.get(sessionId)
      if (known !== undefined) return this.verify(known)
      return this.create(sessionId, workspace, repoRoot)
    } catch (error) {
      const detail = errorDetail(error)
      this.failures.set(sessionId, detail)
      this.deps.logger?.warn?.(
        `dsh-docker-sandbox: could not create a worktree for session ${sessionId}: ${detail}; `
        + "the session shares the workspace instead",
      )
      return undefined
    }
  }

  lookup(sessionId: string, workspace: string): WorktreeEntry | undefined {
    if (!this.enabled) return undefined
    const cached = this.registry.entries.get(sessionId)
    if (cached !== undefined) {
      registerMount(this.deps.paths, cached)
      return cached
    }
    try {
      const repoRoot = this.repoRootFor(workspace)
      if (repoRoot === undefined) return undefined
      this.registry.load(repoRoot)
      const entry = this.registry.entries.get(sessionId)
      if (entry !== undefined) registerMount(this.deps.paths, entry)
      return entry
    } catch {
      return undefined
    }
  }

  failureFor(sessionId: string): string | undefined {
    return this.failures.get(sessionId)
  }

  async info(sessionId: string, workspace: string): Promise<WorktreeInfo | undefined> {
    const entry = this.lookup(sessionId, workspace)
    if (entry === undefined) return undefined
    const status = await tryGit(this.deps.git, ["status", "--porcelain"], entry.worktreePath)
    const count = await tryGit(this.deps.git, ["rev-list", "--count", "HEAD", "--not", "--remotes"], entry.worktreePath)
    const merging = await isMerging(this.deps.git, entry.worktreePath)
    const conflicts = merging ? await conflictedFiles(this.deps.git, entry) : []
    const originRef = this.deps.config.worktreeSync.get() ? this.origin.cachedRef(entry.repoRoot) : undefined
    const behind = originRef === undefined ? undefined : await countBehind(this.deps.git, entry.worktreePath, originRef)
    return {
      path: entry.worktreePath,
      branch: entry.branch,
      mainWorkspace: entry.mainWorkspace,
      dirty: status !== undefined && status.stdout.trim() !== "",
      unpushed: count !== undefined && Number.parseInt(count.stdout.trim(), 10) > 0,
      merging,
      ...(merging ? { conflicts } : {}),
      ...(behind === undefined ? {} : { behind }),
      ...(entry.prUrl === undefined ? {} : { prUrl: entry.prUrl }),
    }
  }

  async reviewFor(sessionId: string, workspace: string): Promise<{ entry: WorktreeEntry; changes: SessionChanges } | undefined> {
    const entry = this.lookup(sessionId, workspace)
    if (entry === undefined) return undefined
    return { entry, changes: await collectChanges(this.deps.git, entry) }
  }

  async conflictsFor(sessionId: string, workspace: string): Promise<ConflictBundle | undefined> {
    const entry = this.lookup(sessionId, workspace)
    if (entry === undefined) return undefined
    return { entry, facts: await collectConflicts(this.deps.git, entry) }
  }

  async syncFor(sessionId: string, workspace: string): Promise<SyncOutcome | undefined> {
    if (!this.enabled || !this.deps.config.worktreeSync.get()) return undefined
    const entry = this.lookup(sessionId, workspace)
    if (entry === undefined) return undefined
    return syncEntry(this.ctx, entry)
  }

  async syncLive(archived: ReadonlySet<string>, isIdleLive: (sessionId: string) => boolean): Promise<SyncOutcome[]> {
    if (!this.enabled || !this.deps.config.worktreeSync.get()) return []
    for (const repoRoot of [...this.registry.roots]) this.registry.load(repoRoot)
    const outcomes: SyncOutcome[] = []
    for (const [sessionId, entry] of [...this.registry.entries]) {
      if (archived.has(sessionId) || !isIdleLive(sessionId)) continue
      outcomes.push(await syncEntry(this.ctx, entry))
    }
    return outcomes
  }

  markInstalled(sessionId: string, workspace: string): void {
    const entry = this.lookup(sessionId, workspace)
    if (entry === undefined) return
    const hash = lockfileHash(entry.worktreePath)
    if (hash === undefined) return
    entry.lockHash = hash
    this.registry.save(entry.repoRoot)
  }

  async mergeRequest(sessionId: string, workspace: string): Promise<MergeRequestResult> {
    const entry = this.ensure(sessionId, workspace)
    if (entry === undefined) {
      const why = this.failures.get(sessionId)
      throw new CliCommandError(
        why
          ?? `session ${sessionId} has no git worktree (worktree mode is off, or its workspace is not a git checkout)`,
        "GIT_FAILED",
        why,
      )
    }

    if (await isMerging(this.deps.git, entry.worktreePath)) {
      throw new CliCommandError(
        `session ${sessionId} is mid-merge with main: resolve the conflict markers in the conversation and commit before opening a merge request`,
        "GIT_FAILED",
      )
    }

    const title = this.deps.titleFor?.(sessionId)
    await this.deps.git.run(["add", "-A"], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    const staged = await prFacts(this.ctx, entry, title)
    const answered = await briefFor(this.ctx, sessionId, staged)
    const brief = answered.brief

    await this.deps.git.run(["add", "-A"], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    const dirty = await isDirty(this.deps.git, entry)
    const committed = dirty
    if (dirty) await commitWorktree(this.deps.git, entry, commitSubject(sessionId, title, brief?.title))

    const renamed = applyBriefName(this.ctx, sessionId, entry, brief?.branchSlug)
    const log = await branchLog(this.ctx, entry, staged.base)
    const remote = await pushOrigin(this.ctx, entry)
    const pr = remote === undefined ? {} : await openPullRequest(this.ctx, entry, remote, {
      ...staged,
      branch: entry.branch,
      log,
      ...(brief === undefined
        ? {}
        : {
            summary: brief.bullets,
            ...(brief.title === undefined ? {} : { briefTitle: brief.title }),
          }),
    })
    if (pr.prUrl !== undefined && entry.prUrl !== pr.prUrl) {
      entry.prUrl = pr.prUrl
      this.registry.save(entry.repoRoot)
    }

    return {
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      committed,
      pushed: remote !== undefined,
      ...(remote === undefined ? {} : { remote }),
      ...pr,
      ...(renamed.from === undefined ? {} : { renamedFrom: renamed.from }),
      ...(renamed.note === undefined ? {} : { nameNote: renamed.note }),
      ...(answered.error === undefined ? {} : { briefError: answered.error }),
    }
  }

  async pruneForArchived(archived: ReadonlySet<string>): Promise<string[]> {
    if (!this.enabled || archived.size === 0) return []
    for (const repoRoot of [...this.registry.roots]) this.registry.load(repoRoot)
    const removed: string[] = []
    for (const [sessionId, entry] of [...this.registry.entries]) {
      if (!archived.has(sessionId)) continue
      if (!existsSync(entry.worktreePath)) {
        this.registry.entries.delete(sessionId)
        this.registry.save(entry.repoRoot)
        continue
      }
      const status = await tryGit(this.deps.git, ["status", "--porcelain"], entry.worktreePath)
      if (status === undefined || status.stdout.trim() !== "") continue
      if (await isMerging(this.deps.git, entry.worktreePath)) continue
      const merged = await tryGit(this.deps.git, ["merge-base", "--is-ancestor", entry.branch, "HEAD"], entry.repoRoot)
      const originRef = this.origin.cachedRef(entry.repoRoot)
      const mergedUpstream = merged === undefined && originRef !== undefined
        ? await tryGit(this.deps.git, ["merge-base", "--is-ancestor", entry.branch, originRef], entry.repoRoot)
        : undefined
      if (merged === undefined && mergedUpstream === undefined) continue
      await tryGit(this.deps.git, ["worktree", "remove", entry.worktreePath], entry.repoRoot)
      await tryGit(this.deps.git, ["branch", "-D", entry.branch], entry.repoRoot)
      this.registry.entries.delete(sessionId)
      this.registry.save(entry.repoRoot)
      removed.push(entry.worktreePath)
    }
    return removed
  }

  private repoRootFor(workspace: string): string | undefined {
    try {
      const out = this.deps.git.runSync(["rev-parse", "--show-toplevel"], { cwd: workspace, timeoutMs: QUICK_MS }).stdout.trim()
      if (out === "") return undefined
      this.registry.roots.add(out)
      return out
    } catch (error) {
      if (error instanceof CliCommandError && error.code === "GIT_MISSING") throw error
      return undefined
    }
  }

  private create(sessionId: string, workspace: string, repoRoot: string): WorktreeEntry {
    const slug = branchSlugFor(this.deps.titleFor?.(sessionId), sessionId)
    const worktreePath = join(treesRootFor(this.deps.config, repoRoot), slug)
    const baseRef = this.deps.config.worktreeSync.get() ? this.origin.refForSync(repoRoot) : undefined
    const entry: WorktreeEntry = {
      sessionId,
      mainWorkspace: workspace,
      repoRoot,
      worktreePath,
      branch: `${this.deps.config.worktreeBranchPrefix}${slug}`,
      createdAt: Date.now(),
      hostGitDir: gitDirFor(this.deps.git, { worktreePath, repoRoot }),
      gitConfig: hostGitConfig(this.deps.git, repoRoot),
      ...(baseRef === undefined ? {} : { baseRef }),
    }
    addWorktree(this.deps.git, entry, baseRef)
    entry.hostGitDir = gitDirFor(this.deps.git, entry)
    this.registry.entries.set(sessionId, entry)
    registerMount(this.deps.paths, entry)
    this.registry.save(repoRoot)
    this.deps.logger?.info?.(
      `dsh-docker-sandbox: session ${sessionId} now works in git worktree "${entry.worktreePath}" (branch ${entry.branch})`,
    )
    return entry
  }

  private verify(entry: WorktreeEntry): WorktreeEntry {
    if (!existsSync(entry.worktreePath)) addWorktree(this.deps.git, entry)
    if (entry.hostGitDir === "") entry.hostGitDir = gitDirFor(this.deps.git, entry)
    registerMount(this.deps.paths, entry)
    return entry
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.deps.logger?.warn?.(`dsh-docker-sandbox: ${message}`)
  }
}
