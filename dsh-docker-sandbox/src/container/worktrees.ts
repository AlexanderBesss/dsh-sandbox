import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SandboxConfig } from "../config.ts"
import type { BootstrapLogger } from "./bootstrap.ts"
import { CliCommandError, type CliResult, type CliRunner } from "./git.ts"
import { PathMapper } from "./paths.ts"
import type { PrBrief, PullRequestBrief } from "./pr-brief.ts"
import { prBodyFor, prTitleFor, type PullRequestFacts } from "./pr-description.ts"
import { collectChanges, forkPointFor, type SessionChanges } from "./review.ts"
import { branchSlugFor, containerNameFor, sessionSlugFor, slugDigest } from "./session.ts"

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
}

export interface WorktreeInfo {
  path: string
  branch: string
  mainWorkspace: string
  dirty: boolean
  unpushed: boolean
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
}

const REGISTRY_FILE = "registry.json"

const QUICK_MS = 15000
const ADD_MS = 120000
const PUSH_MS = 120000

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
    return {
      path: entry.worktreePath,
      branch: entry.branch,
      mainWorkspace: entry.mainWorkspace,
      dirty: status !== undefined && status.stdout.trim() !== "",
      unpushed: count !== undefined && Number.parseInt(count.stdout.trim(), 10) > 0,
    }
  }

  async reviewFor(sessionId: string, workspace: string): Promise<{ entry: WorktreeEntry; changes: SessionChanges } | undefined> {
    const entry = this.lookup(sessionId, workspace)
    if (entry === undefined) return undefined
    return { entry, changes: await collectChanges(this.deps.git, entry) }
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

    const title = this.deps.titleFor?.(sessionId)
    await this.deps.git.run(["add", "-A"], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    const staged = await this.prFacts(sessionId, entry, title)
    const answered = await this.briefFor(sessionId, staged)
    const brief = answered.brief

    await this.deps.git.run(["add", "-A"], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    const dirty = await this.isDirty(entry)
    const stat = await this.tryGit(
      staged.base === undefined ? ["diff", "--stat", "HEAD"] : ["diff", "--stat", staged.base],
      entry.worktreePath,
    )
    const committed = dirty
    if (dirty) await this.commitWorktree(entry, this.commitSubject(sessionId, title, brief?.title))

    const renamed = this.applyBriefName(sessionId, entry, brief?.branchSlug)
    const log = await this.branchLog(entry, staged.base)
    const remote = await this.pushOrigin(entry)
    const pr = remote === undefined ? {} : await this.openPullRequest(entry, remote, {
      ...staged,
      committed,
      branch: entry.branch,
      log,
      ...(stat === undefined ? {} : { stat: stat.stdout.trim() }),
      ...(brief === undefined
        ? {}
        : {
            summary: brief.bullets,
            ...(brief.title === undefined ? {} : { briefTitle: brief.title }),
          }),
    })

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
    const detail = `Session work from container ${containerNameFor(entry.sessionId)}, `
      + "committed by the dsh-docker-sandbox merge button."
    await this.deps.git.run(["commit", "-m", subject, "-m", detail], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
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
      return prUrl === undefined ? {} : { prUrl }
    } catch (error) {
      return {
        prError: error instanceof CliCommandError ? error.detail ?? error.message : String(error),
        compareUrl: compareUrlFor(remote, entry.branch),
      }
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
    sessionId: string,
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
      sessionId,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      mainWorkspace: entry.mainWorkspace,
      container: containerNameFor(sessionId),
      ...(base === undefined ? {} : { base: base.slice(0, 12) }),
      log,
      stat: stat?.stdout.trim() ?? "",
      committed: false,
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
      const merged = await this.tryGit(["merge-base", "--is-ancestor", entry.branch, "HEAD"], entry.repoRoot)
      if (merged === undefined) continue
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
    const entry: WorktreeEntry = {
      sessionId,
      mainWorkspace: workspace,
      repoRoot,
      worktreePath,
      branch: `${this.deps.config.worktreeBranchPrefix}${slug}`,
      createdAt: Date.now(),
      hostGitDir: this.gitDirFor({ worktreePath, repoRoot }),
      gitConfig: this.hostGitConfig(repoRoot),
    }
    this.addWorktree(entry)
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

  private addWorktree(entry: WorktreeEntry): void {
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
      else this.deps.git.runSync(["worktree", "add", "-B", entry.branch, entry.worktreePath, "HEAD"], { cwd: entry.repoRoot, timeoutMs: ADD_MS })
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
