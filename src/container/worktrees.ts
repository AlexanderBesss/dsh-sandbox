import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SandboxConfig } from "../config.ts"
import type { BootstrapLogger } from "./bootstrap.ts"
import { collectConflicts, conflictedFiles, type ConflictFacts } from "./conflicts.ts"
import { CliCommandError, type CliResult, type CliRunner } from "./git.ts"
import { PathMapper } from "./paths.ts"
import type { PrBrief, PullRequestBrief } from "./pr-brief.ts"
import { prBodyFor, prTitleFor, type PullRequestFacts } from "./pr-description.ts"
import { collectChanges, forkPointFor, type SessionChanges } from "./review.ts"
import { branchSlugFor, sessionSlugFor, slugDigest } from "./session.ts"

export interface WorktreeEntry {
  sessionId: string
  mainWorkspace: string
  repoRoot: string
  worktreePath: string
  branch: string
  renamedFrom?: string
  createdAt: number
  hostGitDir: string
  gitConfig: Record<string, string>
  baseRef?: string
  lockHash?: string
  notifiedBehind?: string
  notifiedMerging?: boolean
  prUrl?: string
}

export interface WorktreeInfo {
  path: string
  branch: string
  mainWorkspace: string
  dirty: boolean
  unpushed: boolean
  merging: boolean
  conflicts?: string[]
  behind?: number
  prUrl?: string
}

export interface ConflictBundle {
  entry: WorktreeEntry
  facts: ConflictFacts
}

export type SyncState = "up-to-date" | "merged" | "conflict" | "failed" | "deferred" | "unavailable"

export interface SyncOutcome {
  state: SyncState
  behind?: number
  conflicts?: string[]
}

export interface MergeRequestResult {
  branch: string
  worktreePath: string
  committed: boolean
  pushed: boolean
  remote?: string
  prUrl?: string
  compareUrl?: string
  prError?: string
  renamedFrom?: string
  nameNote?: string
  briefError?: string
}

export interface WorktreeDeps {
  git: CliRunner
  gh?: CliRunner
  config: SandboxConfig
  logger?: BootstrapLogger
  paths: PathMapper
  titleFor?: (sessionId: string) => string | undefined
  brief?: PrBrief
  notify?: (sessionId: string, text: string) => boolean
  onTreeChanged?: (entry: WorktreeEntry) => void
}

const REGISTRY_FILE = "registry.json"

const QUICK_MS = 15000
const ADD_MS = 120000
const PUSH_MS = 120000
const FETCH_MS = 30000
const MERGE_MS = 60000

export function compareUrlFor(remoteUrl: string, branch: string): string | undefined {
  const ssh = /^git@([a-zA-Z0-9.-]+):(.+?)(?:\.git)?$/i.exec(remoteUrl)
  const https = /^https?:\/\/([a-zA-Z0-9.-]+)\/(.+?)(?:\.git)?\/?$/i.exec(remoteUrl)
  const host = ssh?.[1] ?? https?.[1]
  const path = ssh?.[2] ?? https?.[2]
  if (host === undefined || path === undefined) return undefined
  if (/github\./i.test(host)) return `https://${host}/${path}/compare/${branch}?expand=1`
  if (/gitlab/i.test(host)) {
    return `https://${host}/${path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`
  }
  return undefined
}

export class WorktreeManager {
  private readonly entries = new Map<string, WorktreeEntry>()
  private readonly failures = new Map<string, string>()
  private readonly loadedRoots = new Set<string>()
  private readonly repoRoots = new Set<string>()
  private readonly warned = new Set<string>()
  private readonly lastFetch = new Map<string, { at: number; ok: boolean }>()
  private readonly fetchInflight = new Map<string, Promise<boolean>>()

  constructor(private readonly deps: WorktreeDeps) {}

  get enabled(): boolean {
    return this.deps.config.worktree.get()
  }

  ensure(sessionId: string, workspace: string, parentSessionId?: string): WorktreeEntry | undefined {
    if (!this.enabled) return undefined
    const cached = this.entries.get(sessionId)
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
      this.loadRegistry(repoRoot)
      const known = this.entries.get(sessionId)
      if (known !== undefined) return this.verify(known)
      return this.create(sessionId, workspace, repoRoot)
    } catch (error) {
      const detail = error instanceof CliCommandError ? error.detail ?? error.message : String(error)
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
    const cached = this.entries.get(sessionId)
    if (cached !== undefined) {
      this.registerMount(cached)
      return cached
    }
    try {
      const repoRoot = this.repoRootFor(workspace)
      if (repoRoot === undefined) return undefined
      this.loadRegistry(repoRoot)
      const entry = this.entries.get(sessionId)
      if (entry !== undefined) this.registerMount(entry)
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
    const status = await this.tryGit(["status", "--porcelain"], entry.worktreePath)
    const count = await this.tryGit(["rev-list", "--count", "HEAD", "--not", "--remotes"], entry.worktreePath)
    const merging = await this.isMerging(entry)
    const conflicts = merging ? await conflictedFiles(this.deps.git, entry) : []
    const originRef = this.deps.config.worktreeSync.get() ? this.cachedOriginRef(entry.repoRoot) : undefined
    const behind = originRef === undefined ? undefined : await this.countBehind(entry, originRef)
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

  private cachedOriginRef(repoRoot: string): string | undefined {
    if (this.lastFetch.get(repoRoot)?.ok !== true) return undefined
    return this.resolvedOriginRef(repoRoot)
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
    return this.syncEntry(entry)
  }

  async syncLive(archived: ReadonlySet<string>, isIdleLive: (sessionId: string) => boolean): Promise<SyncOutcome[]> {
    if (!this.enabled || !this.deps.config.worktreeSync.get()) return []
    for (const repoRoot of [...this.repoRoots]) this.loadRegistry(repoRoot)
    const outcomes: SyncOutcome[] = []
    for (const [sessionId, entry] of [...this.entries]) {
      if (archived.has(sessionId) || !isIdleLive(sessionId)) continue
      outcomes.push(await this.syncEntry(entry))
    }
    return outcomes
  }

  markInstalled(sessionId: string, workspace: string): void {
    const entry = this.lookup(sessionId, workspace)
    if (entry === undefined) return
    const hash = lockfileHash(entry.worktreePath)
    if (hash === undefined) return
    entry.lockHash = hash
    this.saveRegistry(entry.repoRoot)
  }

  private async syncEntry(entry: WorktreeEntry): Promise<SyncOutcome> {
    if (await this.isMerging(entry)) {
      await this.notifyMidMerge(entry)
      return { state: "conflict" }
    }
    if (entry.notifiedMerging === true) {
      entry.notifiedMerging = undefined
      this.saveRegistry(entry.repoRoot)
    }
    const originRef = await this.originRefFor(entry.repoRoot)
    if (originRef === undefined) return { state: "unavailable" }
    const behind = await this.countBehind(entry, originRef)
    if (behind === undefined) return { state: "unavailable" }
    if (behind === 0) {
      if (entry.notifiedBehind !== undefined) {
        entry.notifiedBehind = undefined
        this.saveRegistry(entry.repoRoot)
      }
      this.reinstallIfStale(entry)
      return { state: "up-to-date" }
    }
    const status = await this.tryGit(["status", "--porcelain"], entry.worktreePath)
    if (status === undefined) return { state: "unavailable" }
    if (status.stdout.trim() !== "") {
      this.notifyBehind(entry, originRef, behind)
      return { state: "deferred", behind }
    }
    try {
      await this.deps.git.run(["merge", "--no-edit", originRef], { cwd: entry.worktreePath, timeoutMs: MERGE_MS })
    } catch (error) {
      if (!(await this.isMerging(entry))) {
        const detail = error instanceof CliCommandError ? error.detail ?? error.message : String(error)
        this.deps.logger?.warn?.(
          `dsh-docker-sandbox: syncing session ${entry.sessionId} to ${originRef} failed: ${detail}; the worktree was left untouched`,
        )
        return { state: "failed", behind }
      }
      const conflicts = await conflictedFiles(this.deps.git, entry)
      this.deps.logger?.warn?.(
        `dsh-docker-sandbox: syncing session ${entry.sessionId} to ${originRef} conflicted in ${conflicts.length} file(s); `
        + "the session was asked to resolve them",
      )
      const notice = [
        `dsh-docker-sandbox: main moved ahead of this session's branch by ${behind} commit(s), and I merged ${originRef} into ${entry.branch}.`,
        ...(conflicts.length === 0 ? ["The merge left conflicts; `git status` shows which files."] : ["These files conflict:", ...conflicts.map((file) => `  ${file}`)]),
        `The worktree is mid-merge. Resolve the conflict markers under ${this.deps.config.containerWorkspace} and finish with \`git commit\``,
        "(or `git merge --abort` to back the merge out). Do not open a merge request while it is unresolved.",
        "The *resolve conflicts* button in the session header hands the same job to a fresh resolver session.",
      ].join("\n")
      if (this.deps.notify?.(entry.sessionId, notice) === true) {
        entry.notifiedMerging = true
        this.saveRegistry(entry.repoRoot)
      }
      return { state: "conflict", behind, conflicts }
    }
    entry.notifiedBehind = undefined
    entry.baseRef = originRef
    this.saveRegistry(entry.repoRoot)
    this.deps.logger?.info?.(
      `dsh-docker-sandbox: session ${entry.sessionId} branch ${entry.branch} merged ${behind} commit(s) from ${originRef}`,
    )
    this.reinstallIfStale(entry)
    return { state: "merged", behind }
  }

  private async notifyMidMerge(entry: WorktreeEntry): Promise<void> {
    if (entry.notifiedMerging === true) return
    const conflicts = await conflictedFiles(this.deps.git, entry)
    const notice = [
      "dsh-docker-sandbox: this session's worktree is mid-merge with unresolved conflicts.",
      ...(conflicts.length === 0 ? ["Run `git status` to see which files conflict."] : ["These files conflict:", ...conflicts.map((file) => `  ${file}`)]),
      `Resolve the conflict markers under ${this.deps.config.containerWorkspace} and finish with \`git commit\``,
      "(or `git merge --abort` to back the merge out). Do not open a merge request while it is unresolved.",
      "The *resolve conflicts* button in the session header hands the same job to a fresh resolver session.",
    ].join("\n")
    if (this.deps.notify?.(entry.sessionId, notice) === true) {
      entry.notifiedMerging = true
      this.saveRegistry(entry.repoRoot)
    }
  }

  private notifyBehind(entry: WorktreeEntry, originRef: string, behind: number): void {
    const sha = this.revParse(entry.repoRoot, originRef)
    if (sha === undefined || entry.notifiedBehind === sha) return
    entry.notifiedBehind = sha
    this.saveRegistry(entry.repoRoot)
    this.deps.notify?.(entry.sessionId, [
      `dsh-docker-sandbox: main moved ahead of this session's branch by ${behind} commit(s).`,
      "The worktree has uncommitted changes, so nothing was merged. Commit your work;",
      `the next sync will merge ${originRef} into ${entry.branch} (and tell you if it conflicts).`,
    ].join("\n"))
  }

  private reinstallIfStale(entry: WorktreeEntry): void {
    const hash = lockfileHash(entry.worktreePath)
    if (hash === undefined) return
    if (entry.lockHash === undefined) {
      entry.lockHash = hash
      this.saveRegistry(entry.repoRoot)
      return
    }
    // lockHash stays at the installed lockfile until the install succeeds
    // (markInstalled records it), so a failed reinstall retries on the next sync.
    if (entry.lockHash !== hash) this.deps.onTreeChanged?.(entry)
  }

  private originRefForSync(repoRoot: string): string | undefined {
    if (!this.fetchOriginSync(repoRoot)) return undefined
    return this.resolvedOriginRef(repoRoot)
  }

  private async originRefFor(repoRoot: string): Promise<string | undefined> {
    if (!await this.fetchOrigin(repoRoot)) return undefined
    return this.resolvedOriginRef(repoRoot)
  }

  private resolvedOriginRef(repoRoot: string): string | undefined {
    const branch = this.mainBranchFor(repoRoot)
    if (branch === undefined || !this.hasOriginRef(repoRoot, branch)) return undefined
    return `origin/${branch}`
  }

  private fetchBudget(repoRoot: string): boolean | undefined {
    const seen = this.lastFetch.get(repoRoot)
    if (seen !== undefined && Date.now() - seen.at < this.deps.config.worktreeSyncIntervalMs) return seen.ok
    return undefined
  }

  private recordFetch(repoRoot: string, ok: boolean, error?: unknown): boolean {
    if (!ok) {
      this.warnOnce(`${repoRoot}\u0000fetch`, `could not fetch origin in ${repoRoot}: ${error instanceof CliCommandError ? error.detail ?? error.message : String(error)}; worktrees keep their current base`)
    }
    this.lastFetch.set(repoRoot, { at: Date.now(), ok })
    return ok
  }

  private fetchOriginSync(repoRoot: string): boolean {
    const budget = this.fetchBudget(repoRoot)
    if (budget !== undefined) return budget
    try {
      this.deps.git.runSync(["fetch", "origin"], { cwd: repoRoot, timeoutMs: FETCH_MS })
      return this.recordFetch(repoRoot, true)
    } catch (error) {
      return this.recordFetch(repoRoot, false, error)
    }
  }

  // The turn-start and GC sync paths must not block the host event loop on a
  // network fetch; only worktree creation (already synchronous) uses the sync one.
  private fetchOrigin(repoRoot: string): Promise<boolean> {
    const running = this.fetchInflight.get(repoRoot)
    if (running !== undefined) return running
    const budget = this.fetchBudget(repoRoot)
    if (budget !== undefined) return Promise.resolve(budget)
    const run = this.deps.git
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

  private mainBranchFor(repoRoot: string): string | undefined {
    try {
      const out = this.deps.git.runSync(["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot, timeoutMs: QUICK_MS }).stdout.trim()
      return out === "" ? undefined : out
    } catch {
      return undefined
    }
  }

  private hasOriginRef(repoRoot: string, branch: string): boolean {
    try {
      const refs = this.deps.git.runSync(["for-each-ref", "--count=1", `refs/remotes/origin/${branch}`], {
        cwd: repoRoot,
        timeoutMs: QUICK_MS,
      })
      return refs.stdout.trim() !== ""
    } catch {
      return false
    }
  }

  private async countBehind(entry: WorktreeEntry, originRef: string): Promise<number | undefined> {
    const count = await this.tryGit(["rev-list", "--count", `HEAD..${originRef}`], entry.worktreePath)
    if (count === undefined) return undefined
    const n = Number.parseInt(count.stdout.trim(), 10)
    return Number.isNaN(n) ? undefined : n
  }

  private async isMerging(entry: WorktreeEntry): Promise<boolean> {
    try {
      const head = await this.deps.git.run(["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
        cwd: entry.worktreePath,
        timeoutMs: QUICK_MS,
      })
      return head.stdout.trim() !== ""
    } catch {
      return false
    }
  }

  private revParse(repoRoot: string, ref: string): string | undefined {
    try {
      const out = this.deps.git.runSync(["rev-parse", ref], { cwd: repoRoot, timeoutMs: QUICK_MS }).stdout.trim()
      return out === "" ? undefined : out
    } catch {
      return undefined
    }
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

    if (await this.isMerging(entry)) {
      throw new CliCommandError(
        `session ${sessionId} is mid-merge with main: resolve the conflict markers in the conversation and commit before opening a merge request`,
        "GIT_FAILED",
      )
    }

    const title = this.deps.titleFor?.(sessionId)
    await this.deps.git.run(["add", "-A"], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    const staged = await this.prFacts(entry, title)
    const answered = await this.briefFor(sessionId, staged)
    const brief = answered.brief

    await this.deps.git.run(["add", "-A"], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    const dirty = await this.isDirty(entry)
    const committed = dirty
    if (dirty) await this.commitWorktree(entry, this.commitSubject(sessionId, title, brief?.title))

    const renamed = this.applyBriefName(sessionId, entry, brief?.branchSlug)
    const log = await this.branchLog(entry, staged.base)
    const remote = await this.pushOrigin(entry)
    const pr = remote === undefined ? {} : await this.openPullRequest(entry, remote, {
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
      this.saveRegistry(entry.repoRoot)
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

  private async isDirty(entry: WorktreeEntry): Promise<boolean> {
    const status = await this.deps.git.run(["status", "--porcelain"], { cwd: entry.worktreePath, timeoutMs: QUICK_MS })
    return status.stdout.trim() !== ""
  }

  private async commitWorktree(entry: WorktreeEntry, subject: string): Promise<void> {
    await this.deps.git.run(["commit", "-m", subject], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
  }

  private async pushOrigin(entry: WorktreeEntry): Promise<string | undefined> {
    const remoteResult = await this.tryGit(["remote", "get-url", "origin"], entry.repoRoot)
    const remote = remoteResult?.stdout.trim()
    if (remote === undefined || remote === "") return undefined
    await this.deps.git.run(["push", "-u", "origin", entry.branch], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    return remote
  }

  private async openPullRequest(
    entry: WorktreeEntry,
    remote: string,
    described: PullRequestFacts,
  ): Promise<Pick<MergeRequestResult, "prUrl" | "compareUrl" | "prError">> {
    const gh = this.deps.gh
    if (gh === undefined) {
      return {
        prError: "the GitHub CLI is not configured (ghArgv), so the branch was pushed without a pull request",
        compareUrl: compareUrlFor(remote, entry.branch),
      }
    }
    try {
      const opened = await gh.run([
        "pr", "create",
        "--head", entry.branch,
        "--title", prTitleFor(described),
        "--body", prBodyFor(described),
      ], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
      const prUrl = /https?:\/\/\S+/.exec(opened.stdout)?.[0]
      if (prUrl !== undefined) return { prUrl }
      const recorded = await this.openPullRequestUrl(entry)
      return recorded === undefined ? {} : { prUrl: recorded }
    } catch (error) {
      // A second click after the request exists fails `pr create`; the link of
      // the still-open request is what the button should show, so read it back.
      const existing = await this.openPullRequestUrl(entry)
      if (existing !== undefined) return { prUrl: existing }
      return {
        prError: error instanceof CliCommandError ? error.detail ?? error.message : String(error),
        compareUrl: compareUrlFor(remote, entry.branch),
      }
    }
  }

  private async openPullRequestUrl(entry: WorktreeEntry): Promise<string | undefined> {
    const gh = this.deps.gh
    if (gh === undefined) return undefined
    try {
      // open-only: a merged or closed request must not be reported as the
      // answer to this push — the new commits need a fresh request of their own.
      const found = await gh.run(
        ["pr", "list", "--state", "open", "--head", entry.branch, "--json", "url", "-q", ".[0].url"],
        { cwd: entry.worktreePath, timeoutMs: PUSH_MS },
      )
      return /https?:\/\/\S+/.exec(found.stdout)?.[0]
    } catch {
      return undefined
    }
  }

  private commitSubject(sessionId: string, title: string | undefined, briefTitle: string | undefined): string {
    const named = [briefTitle, title]
      .map((text) => (text ?? "").trim())
      .find((text) => text !== "") ?? sessionSlugFor(sessionId)
    return `dsh-sbx: ${named}`.slice(0, 72)
  }

  private async briefFor(
    sessionId: string,
    facts: PullRequestFacts,
  ): Promise<{ brief?: PullRequestBrief; error?: string }> {
    const brief = this.deps.brief
    if (brief === undefined || !this.deps.config.prBrief.get()) return {}
    try {
      const outcome = await brief(sessionId, facts)
      return "brief" in outcome ? { brief: outcome.brief } : { error: outcome.error }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { error: `the naming subagent failed: ${detail}` }
    }
  }

  private applyBriefName(
    sessionId: string,
    entry: WorktreeEntry,
    slug: string | undefined,
  ): { from?: string; note?: string } {
    if (slug === undefined) return {}
    const wanted = `${this.deps.config.worktreeBranchPrefix}${slug}-${slugDigest(sessionId).slice(0, 6)}`
    if (wanted === entry.branch) return {}
    if (this.isPushed(entry)) {
      return { note: `the branch had already been pushed as "${entry.branch}", so it keeps that name` }
    }
    try {
      this.deps.git.runSync(["branch", "-m", entry.branch, wanted], { cwd: entry.worktreePath, timeoutMs: QUICK_MS })
    } catch (error) {
      const detail = error instanceof CliCommandError ? error.detail ?? error.message : String(error)
      return { note: `could not rename the branch to "${wanted}": ${detail}` }
    }
    const from = entry.branch
    entry.branch = wanted
    entry.renamedFrom = from
    this.saveRegistry(entry.repoRoot)
    this.deps.logger?.info?.(
      `dsh-docker-sandbox: session ${sessionId} branch renamed "${from}" → "${wanted}" (named after the change)`,
    )
    return { from }
  }

  private isPushed(entry: WorktreeEntry): boolean {
    try {
      const refs = this.deps.git.runSync(
        ["for-each-ref", "--count=1", `refs/remotes/origin/${entry.branch}`],
        { cwd: entry.repoRoot, timeoutMs: QUICK_MS },
      )
      return refs.stdout.trim() !== ""
    } catch {
      return true 
    }
  }

  private async branchLog(entry: WorktreeEntry, base: string | undefined): Promise<string> {
    const log = await this.tryGit(
      base === undefined ? ["log", "--oneline", "HEAD", "--not", "--remotes"] : ["log", "--oneline", `${base}..HEAD`],
      entry.worktreePath,
    )
    return log?.stdout.trim() ?? ""
  }

  private async prFacts(
    entry: WorktreeEntry,
    title: string | undefined,
  ): Promise<PullRequestFacts> {
    const base = await forkPointFor(this.deps.git, entry)
    const log = await this.branchLog(entry, base ?? undefined)
    const stat = await this.tryGit(
      base === undefined ? ["diff", "--stat", "HEAD"] : ["diff", "--stat", base],
      entry.worktreePath,
    )
    const named = (title ?? "").trim()
    return {
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      mainWorkspace: entry.mainWorkspace,
      ...(base === undefined ? {} : { base: base.slice(0, 12) }),
      log,
      stat: stat?.stdout.trim() ?? "",
      ...(named === "" ? {} : { title: named }),
    }
  }

  async pruneForArchived(archived: ReadonlySet<string>): Promise<string[]> {
    if (!this.enabled || archived.size === 0) return []
    for (const repoRoot of [...this.repoRoots]) this.loadRegistry(repoRoot)
    const removed: string[] = []
    for (const [sessionId, entry] of [...this.entries]) {
      if (!archived.has(sessionId)) continue
      if (!existsSync(entry.worktreePath)) {
        this.entries.delete(sessionId)
        this.saveRegistry(entry.repoRoot)
        continue
      }
      const status = await this.tryGit(["status", "--porcelain"], entry.worktreePath)
      if (status === undefined || status.stdout.trim() !== "") continue
      if (await this.isMerging(entry)) continue
      const merged = await this.tryGit(["merge-base", "--is-ancestor", entry.branch, "HEAD"], entry.repoRoot)
      const originRef = this.cachedOriginRef(entry.repoRoot)
      const mergedUpstream = merged === undefined && originRef !== undefined
        ? await this.tryGit(["merge-base", "--is-ancestor", entry.branch, originRef], entry.repoRoot)
        : undefined
      if (merged === undefined && mergedUpstream === undefined) continue
      await this.tryGit(["worktree", "remove", entry.worktreePath], entry.repoRoot)
      await this.tryGit(["branch", "-D", entry.branch], entry.repoRoot)
      this.entries.delete(sessionId)
      this.saveRegistry(entry.repoRoot)
      removed.push(entry.worktreePath)
    }
    return removed
  }

  private repoRootFor(workspace: string): string | undefined {
    try {
      const out = this.deps.git.runSync(["rev-parse", "--show-toplevel"], { cwd: workspace, timeoutMs: QUICK_MS }).stdout.trim()
      if (out === "") return undefined
      this.repoRoots.add(out)
      return out
    } catch (error) {
      if (error instanceof CliCommandError && error.code === "GIT_MISSING") throw error
      return undefined
    }
  }

  private treesRootFor(repoRoot: string): string {
    const trimmed = repoRoot.replace(/[\\/]+$/, "")
    const configured = this.deps.config.worktreeRoot.get()
    if (configured !== "") {
      const leaf = trimmed.split(/[\\/]+/).pop() ?? "repo"
      return join(configured, `${leaf}-${slugDigest(trimmed.toLowerCase())}`)
    }
    return `${trimmed}.worktrees`
  }

  private create(sessionId: string, workspace: string, repoRoot: string): WorktreeEntry {
    const slug = branchSlugFor(this.deps.titleFor?.(sessionId), sessionId)
    const worktreePath = join(this.treesRootFor(repoRoot), slug)
    const baseRef = this.deps.config.worktreeSync.get() ? this.originRefForSync(repoRoot) : undefined
    const entry: WorktreeEntry = {
      sessionId,
      mainWorkspace: workspace,
      repoRoot,
      worktreePath,
      branch: `${this.deps.config.worktreeBranchPrefix}${slug}`,
      createdAt: Date.now(),
      hostGitDir: this.gitDirFor({ worktreePath, repoRoot }),
      gitConfig: this.hostGitConfig(repoRoot),
      ...(baseRef === undefined ? {} : { baseRef }),
    }
    this.addWorktree(entry, baseRef)
    entry.hostGitDir = this.gitDirFor(entry)
    this.entries.set(sessionId, entry)
    this.registerMount(entry)
    this.saveRegistry(repoRoot)
    this.deps.logger?.info?.(
      `dsh-docker-sandbox: session ${sessionId} now works in git worktree "${entry.worktreePath}" (branch ${entry.branch})`,
    )
    return entry
  }

  private gitDirFor(entry: Pick<WorktreeEntry, "worktreePath" | "repoRoot">): string {
    try {
      const out = this.deps.git.runSync(["rev-parse", "--absolute-git-dir"], { cwd: entry.worktreePath, timeoutMs: QUICK_MS }).stdout.trim()
      if (out !== "") return out
    } catch {
    }
    const leaf = entry.worktreePath.replace(/[\\/]+$/, "").split(/[\\/]+/).pop() ?? "worktree"
    return `${entry.repoRoot.replace(/[\\/]+$/, "")}/.git/worktrees/${leaf}`
  }

  private registerMount(entry: WorktreeEntry): void {
    const gitHost = `${entry.repoRoot.replace(/[\\/]+$/, "")}/.git`
    this.deps.paths.registerExtraMount(entry.worktreePath, {
      mount: { hostPath: gitHost, containerPath: PathMapper.windowsToDrive(gitHost) },
      containerGitDir: PathMapper.windowsToDrive(entry.hostGitDir),
      gitConfig: entry.gitConfig,
      aliasHost: entry.mainWorkspace,
    })
  }

  private hostGitConfig(cwd: string): Record<string, string> {
    const config: Record<string, string> = {}
    for (const key of ["core.autocrlf", "user.name", "user.email"]) {
      try {
        const value = this.deps.git.runSync(["config", "--get", key], { cwd, timeoutMs: QUICK_MS }).stdout.trim()
        if (value !== "") config[key] = value
      } catch {
      }
    }
    return config
  }

  private verify(entry: WorktreeEntry): WorktreeEntry {
    if (!existsSync(entry.worktreePath)) this.addWorktree(entry)
    if (entry.hostGitDir === "") entry.hostGitDir = this.gitDirFor(entry)
    this.registerMount(entry)
    return entry
  }

  private addWorktree(entry: WorktreeEntry, base?: string): void {
    let branchExists = false
    try {
      branchExists = this.deps.git.runSync(["rev-parse", "--verify", "--quiet", `refs/heads/${entry.branch}`], {
        cwd: entry.repoRoot,
        timeoutMs: QUICK_MS,
      }).code === 0
    } catch {
      branchExists = false
    }
    const add = (): void => {
      if (branchExists) this.deps.git.runSync(["worktree", "add", entry.worktreePath, entry.branch], { cwd: entry.repoRoot, timeoutMs: ADD_MS })
      else this.deps.git.runSync(["worktree", "add", "-B", entry.branch, entry.worktreePath, base ?? "HEAD"], { cwd: entry.repoRoot, timeoutMs: ADD_MS })
    }
    try {
      add()
    } catch (first) {
      try {
        this.deps.git.runSync(["worktree", "prune"], { cwd: entry.repoRoot, timeoutMs: QUICK_MS })
        add()
      } catch {
        throw first
      }
    }
  }

  private loadRegistry(repoRoot: string): void {
    if (this.loadedRoots.has(repoRoot)) return
    this.loadedRoots.add(repoRoot)
    this.repoRoots.add(repoRoot)
    try {
      const raw = JSON.parse(readFileSync(join(this.treesRootFor(repoRoot), REGISTRY_FILE), "utf8")) as {
        entries?: Record<string, WorktreeEntry>
      }
      for (const [sessionId, entry] of Object.entries(raw.entries ?? {})) {
        if (!this.entries.has(sessionId)) {
          if (typeof entry.hostGitDir !== "string" || entry.hostGitDir === "") {
            entry.hostGitDir = this.gitDirFor(entry)
          }
          if (typeof entry.gitConfig !== "object" || entry.gitConfig === null) {
            entry.gitConfig = this.hostGitConfig(entry.repoRoot)
          }
          if (typeof entry.prUrl !== "string") entry.prUrl = undefined
          this.entries.set(sessionId, entry)
        }
      }
    } catch {
    }
  }

  private saveRegistry(repoRoot: string): void {
    const root = this.treesRootFor(repoRoot)
    try {
      mkdirSync(root, { recursive: true })
      const entries: Record<string, WorktreeEntry> = {}
      for (const [sessionId, entry] of this.entries) {
        if (entry.repoRoot === repoRoot) entries[sessionId] = entry
      }
      writeFileSync(join(root, REGISTRY_FILE), JSON.stringify({ version: 1, entries }, null, 2))
    } catch (error) {
      this.warnOnce(repoRoot, `could not write the worktree registry: ${(error as Error).message}`)
    }
  }

  private async tryGit(args: string[], cwd: string): Promise<CliResult | undefined> {
    try {
      return await this.deps.git.run(args, { cwd, timeoutMs: QUICK_MS })
    } catch {
      return undefined
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.deps.logger?.warn?.(`dsh-docker-sandbox: ${message}`)
  }
}

export function lockfileHash(worktreePath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(join(worktreePath, "package-lock.json"))).digest("hex")
  } catch {
    return undefined
  }
}
