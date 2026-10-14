/**
 * Per-conversation git worktrees.
 *
 * With `worktree` enabled, each conversation works in its own `git worktree`
 * carved from the session's checkout, on its own branch, named after the
 * conversation rather than its id. Two chats on one repository then cannot step
 * on each other: the container mounts the worktree, the host file tools read and
 * write the worktree, and the diff a merge request carries is exactly that
 * conversation's branch.
 *
 * The manager runs `git` on the host (the workspace is host files), keeps a
 * small JSON registry under the worktrees root so the session → worktree
 * mapping survives app restarts, and never deletes work that is dirty or
 * unmerged.
 *
 * Creation is synchronous and lazy: `FileSystem.resolve` is sync, so the
 * worktree must exist before the first `read`/`write` resolves rather than
 * being provisioned alongside the container. The first tool call of a session
 * pays one `git worktree add`; every later call is a map lookup.
 *
 * A failure to create (git missing, a corrupt checkout) is sticky, logged, and
 * surfaced to the UI; the session then shares the workspace exactly as it did
 * before worktree mode existed, rather than every tool call hard-failing.
 *
 * @module dsh-docker-sandbox/container/worktrees
 */

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

/** One session's worktree, as the registry records it. */
export interface WorktreeEntry {
  sessionId: string
  /** Windows path of the checkout the worktree was carved from. */
  mainWorkspace: string
  /** Windows path of the repository root (`git rev-parse --show-toplevel`). */
  repoRoot: string
  /** Windows path of this session's worktree directory. */
  worktreePath: string
  /** The branch the worktree checks out. */
  branch: string
  /**
   * The name this branch carried before the merge-request naming pass renamed
   * it. Recorded so the old name stays findable after the rename.
   */
  renamedFrom?: string
  /** Epoch millis of creation. */
  createdAt: number
  /**
   * Host path of the linked worktree's gitdir (`<mainRepo>/.git/worktrees/<name>`).
   * The worktree's `.git` file points here with a Windows path the container
   * cannot resolve on its own, so the provisioner mounts the main `.git` and
   * exports `GIT_DIR` from this value.
   */
  hostGitDir: string
  /**
   * Host-effective git settings mirrored into the container through
   * `GIT_CONFIG_*` env vars. Git for Windows keeps `core.autocrlf` in its
   * system config, which the container cannot see; without the mirror,
   * container git reads a CRLF checkout as phantom-modified and commits
   * lack the user's identity.
   */
  gitConfig: Record<string, string>
}

/** What the UI shows about a session's worktree. */
export interface WorktreeInfo {
  path: string
  branch: string
  mainWorkspace: string
  /** True when the worktree has uncommitted changes. */
  dirty: boolean
  /** True when the branch has commits no remote carries. */
  unpushed: boolean
}

/** What the merge-request route returns. */
export interface MergeRequestResult {
  branch: string
  worktreePath: string
  /** True when the button's click produced a commit. */
  committed: boolean
  /** True when the branch reached the remote. */
  pushed: boolean
  remote?: string
  /** Set when the GitHub CLI opened a pull request. */
  prUrl?: string
  /** Set when no PR could be opened and the remote can offer a compare page. */
  compareUrl?: string
  /**
   * Why no pull request was opened, when that happened: the GitHub CLI is
   * not configured, or it refused (missing, unauthenticated, a closed
   * compare base). The push still stands, so this reads as "branch is up
   * there, but here is what blocked the PR" — never a silent fallback.
   */
  prError?: string
  /** Set when the naming pass renamed the branch before pushing. */
  renamedFrom?: string
  /** Why the branch kept its name, when the naming pass proposed another. */
  nameNote?: string
  /**
   * Why there was no naming pass at all: no subagent service, a refused or
   * timed-out child, an answer that could not be read. The request still opens
   * with the branch name it had and the git sections of the description.
   */
  briefError?: string
}

export interface WorktreeDeps {
  git: CliRunner
  /** The GitHub CLI; absent means merge requests stop at a pushed branch. */
  gh?: CliRunner
  config: SandboxConfig
  logger?: BootstrapLogger
  /** Receives the extra `.git` mount each worktree session needs. */
  paths: PathMapper
  /**
   * The conversation's readable name (its chat title, or the first prompt when
   * the app has not titled it yet). Names the branch at creation and titles the
   * pull request; absent or unusable falls back to the session slug.
   */
  titleFor?: (sessionId: string) => string | undefined
  /**
   * The one AI pass a merge request runs: it names the branch, titles the
   * request, and writes the description bullets. Absent (or when `prBrief` is
   * off) leaves the branch on the name it was created with and the description at
   * its git sections.
   */
  brief?: PrBrief
}

/** Registry file name, kept inside the worktrees root. */
const REGISTRY_FILE = "registry.json"

/** Budgets for the host git calls this manager makes. */
const QUICK_MS = 15000
const ADD_MS = 120000
const PUSH_MS = 120000

/**
 * Build the URL a human opens to raise the merge request by hand, for the
 * remotes we recognize (GitHub, GitLab over https or ssh).
 */
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
  /** Session → worktree, loaded from disk once per repo root and kept hot. */
  private readonly entries = new Map<string, WorktreeEntry>()
  /** Sessions whose creation failed; sticky so every call does not retry git. */
  private readonly failures = new Map<string, string>()
  /** Repo roots whose registry file has been read into `entries`. */
  private readonly loadedRoots = new Set<string>()
  /** Repo roots seen this process; what the GC sweep scans. */
  private readonly repoRoots = new Set<string>()
  /** Workspaces already reported as non-git, so the warning prints once. */
  private readonly warned = new Set<string>()

  constructor(private readonly deps: WorktreeDeps) {}

  /** Live read of the toggle: the plugin manager can flip it without a restart. */
  get enabled(): boolean {
    return this.deps.config.worktree.get()
  }

  /**
   * The worktree for one session, creating it on first use.
   *
   * Synchronous by necessity — the fs seam resolves paths without awaiting.
   *
   * A subagent (a session with a `parentSessionId`) works in its **parent's**
   * tree: the parent's uncommitted changes are the work the child was asked
   * to look at, and a fresh worktree from HEAD would hide them. The child
   * aliases onto the parent's entry and never gets a registry entry of its
   * own, so GC prunes stay keyed to real conversations.
   *
   * @param sessionId - conversation identity.
   * @param workspace - the session's recorded Windows workspace.
   * @param parentSessionId - the delegating parent, when this is a subagent.
   * @returns the entry, or undefined when this session keeps the shared
   *   workspace (mode off, non-git checkout, or a sticky creation failure).
   */
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

  /**
   * Look up a session's worktree without creating one.
   *
   * The status route uses this so merely opening a chat never runs
   * `git worktree add`; it still finds worktrees created before an app
   * restart, because the registry file is read on demand.
   */
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

  /** Why worktree creation failed for a session, for the UI. */
  failureFor(sessionId: string): string | undefined {
    return this.failures.get(sessionId)
  }

  /** UI-facing state for one session's worktree, including dirty/unpushed. */
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

  /**
   * The review bundle for one session: its worktree entry plus everything
   * the conversation changed since its branch forked.
   *
   * @returns undefined when the session has no worktree yet (mode off, or no
   *   tool call has created one).
   */
  async reviewFor(sessionId: string, workspace: string): Promise<{ entry: WorktreeEntry; changes: SessionChanges } | undefined> {
    const entry = this.lookup(sessionId, workspace)
    if (entry === undefined) return undefined
    return { entry, changes: await collectChanges(this.deps.git, entry) }
  }

  /**
   * Turn one session's worktree into a merge request.
   *
   * Stages everything in the worktree, asks the naming pass what the change is
   * (branch name, title, description bullets — see `container/pr-brief`),
   * commits and renames with its answer, pushes to `origin`, and opens a GitHub
   * pull request through `gh`. The pass runs before anything is public, which is
   * what makes the rename safe; a branch that already reached a remote keeps its
   * name and says so.
   *
   * Without `gh` (or when `gh` refuses) the result carries the remote's compare
   * URL and the reason, so the human can raise the request in one click.
   */
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
    let briefError: string | undefined
    let nameNote: string | undefined
    let renamedFrom: string | undefined

    // Stage first: the diff the naming pass reads has to be the diff that ships.
    await this.deps.git.run(["add", "-A"], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    const staged = await this.prFacts(sessionId, entry, title)
    const answered = await this.briefFor(sessionId, staged)
    if (answered.error !== undefined) briefError = answered.error
    const brief = answered.brief

    // The pass can take the whole `prBriefTimeoutMs`, and the child works inside
    // this same worktree, so re-stage before committing: anything written during
    // the pass still belongs to the commit. The diffstat is re-read for the same
    // reason — the description has to match what actually ships.
    await this.deps.git.run(["add", "-A"], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
    const status = await this.deps.git.run(["status", "--porcelain"], { cwd: entry.worktreePath, timeoutMs: QUICK_MS })
    const stat = await this.tryGit(
      staged.base === undefined ? ["diff", "--stat", "HEAD"] : ["diff", "--stat", staged.base],
      entry.worktreePath,
    )

    let committed = false
    if (status.stdout.trim() !== "") {
      const subject = this.commitSubject(sessionId, title, brief?.title)
      const detail = `Session work from container ${containerNameFor(sessionId)}, `
        + "committed by the dsh-docker-sandbox merge button."
      await this.deps.git.run(["commit", "-m", subject, "-m", detail], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
      committed = true
    }

    const renamed = this.applyBriefName(sessionId, entry, brief?.branchSlug)
    if (renamed.from !== undefined) renamedFrom = renamed.from
    if (renamed.note !== undefined) nameNote = renamed.note

    // The description has to list the commit the button just wrote, and the
    // probe has to run before the push: with no known fork point the log is
    // `HEAD --not --remotes`, which a pushed branch would hide from itself.
    const log = await this.branchLog(entry, staged.base)

    const remoteResult = await this.tryGit(["remote", "get-url", "origin"], entry.repoRoot)
    const remote = remoteResult?.stdout.trim()
    let pushed = false
    if (remote !== undefined && remote !== "") {
      await this.deps.git.run(["push", "-u", "origin", entry.branch], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
      pushed = true
    }

    let prUrl: string | undefined
    let compareUrl: string | undefined
    let prError: string | undefined
    if (pushed && remote !== undefined) {
      const described: PullRequestFacts = {
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
      }
      const gh = this.deps.gh
      if (gh === undefined) {
        prError = "the GitHub CLI is not configured (ghArgv), so the branch was pushed without a pull request"
        compareUrl = compareUrlFor(remote, entry.branch)
      } else {
        try {
          const opened = await gh.run([
            "pr", "create",
            "--head", entry.branch,
            "--title", prTitleFor(described),
            "--body", prBodyFor(described),
          ], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
          prUrl = /https?:\/\/\S+/.exec(opened.stdout)?.[0]
        } catch (error) {
          // The branch is pushed either way; say what the CLI answered rather
          // than quietly handing back only a compare link.
          prError = error instanceof CliCommandError ? error.detail ?? error.message : String(error)
          compareUrl = compareUrlFor(remote, entry.branch)
        }
      }
    }

    return {
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      committed,
      pushed,
      ...(remote === undefined || remote === "" ? {} : { remote }),
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(compareUrl === undefined ? {} : { compareUrl }),
      ...(prError === undefined ? {} : { prError }),
      ...(renamedFrom === undefined ? {} : { renamedFrom }),
      ...(nameNote === undefined ? {} : { nameNote }),
      ...(briefError === undefined ? {} : { briefError }),
    }
  }

  /**
   * The commit subject for work nobody wrote a message for: what the naming pass
   * called the change, else what the app calls the chat, else the session slug.
   */
  private commitSubject(sessionId: string, title: string | undefined, briefTitle: string | undefined): string {
    const named = [briefTitle, title]
      .map((text) => (text ?? "").trim())
      .find((text) => text !== "") ?? sessionSlugFor(sessionId)
    return `dsh-sbx: ${named}`.slice(0, 72)
  }

  /**
   * The naming pass's answer, or the reason to show the user. Never throws: the
   * work is already staged by the time this runs, so a child that cannot answer
   * costs the naming and the summary, never the request.
   */
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

  /**
   * Rename the session's branch to what the naming pass proposed.
   *
   * This happens before the push, which is what makes it safe: a name that has
   * reached a remote is already public — a checkout, a comment, or an open
   * request can be referring to it — so the branch keeps its name and the reason
   * is reported instead. The worktree directory keeps its own name either way;
   * the container mounts it, and moving a mounted tree is not worth the churn.
   *
   * @returns `from` when the rename happened, `note` when it did not.
   */
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

  /** True when `origin` already carries this branch, making its name public. */
  private isPushed(entry: WorktreeEntry): boolean {
    try {
      // `for-each-ref` has no `--quiet`; an unsupported option exits 129 and
      // would read as "already public" forever.
      //
      // The local remote-tracking ref is the only evidence consulted: a branch
      // pushed from some other clone leaves no trace here, so its name would
      // still be renamed. Every push this plugin makes goes through the shared
      // `.git`, which updates that ref, so the gap is hand-pushed branches only.
      const refs = this.deps.git.runSync(
        ["for-each-ref", "--count=1", `refs/remotes/origin/${entry.branch}`],
        { cwd: entry.repoRoot, timeoutMs: QUICK_MS },
      )
      return refs.stdout.trim() !== ""
    } catch {
      return true // cannot tell: treat the name as public and leave it alone
    }
  }

  /** `git log --oneline` of what the branch carries beyond its fork point. */
  private async branchLog(entry: WorktreeEntry, base: string | undefined): Promise<string> {
    const log = await this.tryGit(
      base === undefined ? ["log", "--oneline", "HEAD", "--not", "--remotes"] : ["log", "--oneline", `${base}..HEAD`],
      entry.worktreePath,
    )
    return log?.stdout.trim() ?? ""
  }

  /**
   * The git facts behind the pull-request text: the branch's own commits and
   * its diffstat against the fork point. All probes — a branch with no computable
   * base, or a repository git cannot read, still gets a description of what the
   * plugin can see rather than a failed request.
   */
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
      // The pass reads these facts before the commit exists; the caller sets
      // this once it has actually happened.
      committed: false,
      ...(named === "" ? {} : { title: named }),
    }
  }

  /**
   * Delete worktrees belonging to archived conversations — but only ones that
   * are safe to lose: clean, and already merged into the main checkout's
   * branch. Dirty or unmerged work persists until it is merged or removed by
   * hand; that is the whole point of the feature.
   *
   * @param archived - the registry's current archive set.
   * @returns the worktree paths deleted.
   */
  async pruneForArchived(archived: ReadonlySet<string>): Promise<string[]> {
    if (!this.enabled || archived.size === 0) return []
    for (const repoRoot of [...this.repoRoots]) this.loadRegistry(repoRoot)
    const removed: string[] = []
    for (const [sessionId, entry] of [...this.entries]) {
      if (!archived.has(sessionId)) continue
      if (!existsSync(entry.worktreePath)) {
        // The directory is already gone (deleted by hand); drop the record.
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

  /** The repository root for a workspace, or undefined when it is not a checkout. */
  private repoRootFor(workspace: string): string | undefined {
    try {
      const out = this.deps.git.runSync(["rev-parse", "--show-toplevel"], { cwd: workspace, timeoutMs: QUICK_MS }).stdout.trim()
      if (out === "") return undefined
      this.repoRoots.add(out)
      return out
    } catch (error) {
      // A missing git binary is a named failure the caller must see; a plain
      // non-zero exit just means "not a git checkout".
      if (error instanceof CliCommandError && error.code === "GIT_MISSING") throw error
      return undefined
    }
  }

  /** Where one repo's worktrees (and its registry) live. */
  private treesRootFor(repoRoot: string): string {
    const trimmed = repoRoot.replace(/[\\/]+$/, "")
    const configured = this.deps.config.worktreeRoot.get()
    if (configured !== "") {
      const leaf = trimmed.split(/[\\/]+/).pop() ?? "repo"
      return join(configured, `${leaf}-${slugDigest(trimmed.toLowerCase())}`)
    }
    return `${trimmed}.worktrees`
  }

  /** Create the worktree and record it. */
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
      // Filled once `worktree add` has made the gitdir real.
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

  /**
   * The linked worktree's gitdir: `<mainRepo>/.git/worktrees/<worktree name>`.
   * Asked of git when the worktree exists, derived when it does not (a stale
   * record being re-attached, or an older registry entry).
   */
  private gitDirFor(entry: Pick<WorktreeEntry, "worktreePath" | "repoRoot">): string {
    try {
      const out = this.deps.git.runSync(["rev-parse", "--absolute-git-dir"], { cwd: entry.worktreePath, timeoutMs: QUICK_MS }).stdout.trim()
      if (out !== "") return out
    } catch {
      // fall through to the derived name
    }
    const leaf = entry.worktreePath.replace(/[\\/]+$/, "").split(/[\\/]+/).pop() ?? "worktree"
    return `${entry.repoRoot.replace(/[\\/]+$/, "")}/.git/worktrees/${leaf}`
  }

  /**
   * Mount the main repo's `.git` for this session, at its drive form, and
   * record the gitdir's container path so the provisioner can export
   * `GIT_DIR`. Without this, git inside the container cannot follow the
   * worktree's `.git` file (a Windows path), and any tool that probes the
   * gitdir hits the mount boundary.
   */
  private registerMount(entry: WorktreeEntry): void {
    const gitHost = `${entry.repoRoot.replace(/[\\/]+$/, "")}/.git`
    this.deps.paths.registerExtraMount(entry.worktreePath, {
      mount: { hostPath: gitHost, containerPath: PathMapper.windowsToDrive(gitHost) },
      containerGitDir: PathMapper.windowsToDrive(entry.hostGitDir),
      gitConfig: entry.gitConfig,
      aliasHost: entry.mainWorkspace,
    })
  }

  /**
   * The host-effective values of the git settings a container checkout needs
   * to see the same working tree the host sees. Unset keys are skipped.
   */
  private hostGitConfig(cwd: string): Record<string, string> {
    const config: Record<string, string> = {}
    for (const key of ["core.autocrlf", "user.name", "user.email"]) {
      try {
        const value = this.deps.git.runSync(["config", "--get", key], { cwd, timeoutMs: QUICK_MS }).stdout.trim()
        if (value !== "") config[key] = value
      } catch {
        // unset on the host: nothing to mirror
      }
    }
    return config
  }

  /**
   * Re-attach a recorded worktree whose directory vanished (deleted by hand).
   *
   * When the branch still exists it is checked out as-is — `add -B` would
   * reset the branch pointer to HEAD and quietly strand the session's
   * commits.
   */
  private verify(entry: WorktreeEntry): WorktreeEntry {
    if (!existsSync(entry.worktreePath)) this.addWorktree(entry)
    if (entry.hostGitDir === "") entry.hostGitDir = this.gitDirFor(entry)
    this.registerMount(entry)
    return entry
  }

  /** One `git worktree add`, branch-aware, with a `prune` retry for stale records. */
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
      // A stale registration (directory deleted by hand) blocks the add until
      // `prune` clears it; retry once, then report the original failure.
      try {
        this.deps.git.runSync(["worktree", "prune"], { cwd: entry.repoRoot, timeoutMs: QUICK_MS })
        add()
      } catch {
        throw first
      }
    }
  }

  /** Read one repo root's registry file into `entries`, once per process. */
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
          // Entries written before `hostGitDir` existed: derive the gitdir
          // name, which git derives from the worktree directory's leaf.
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
      // No registry yet: nothing to load.
    }
  }

  /** Write every entry belonging to one repo root back to its registry file. */
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

  /** Run one git call, reporting failure as `undefined` (a probe, not a request). */
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
