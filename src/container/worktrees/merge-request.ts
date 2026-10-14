import type { CliRunner } from "../git.ts"
import type { PullRequestBrief } from "../pr-brief.ts"
import { prBodyFor, prTitleFor, type PullRequestFacts } from "../pr-description.ts"
import { forkPointFor } from "../review.ts"
import { sessionSlugFor, slugDigest } from "../session.ts"
import { PUSH_MS, QUICK_MS } from "./constants.ts"
import type { ManagerContext } from "./context.ts"
import { errorDetail } from "./errors.ts"
import { remoteBranchExists, tryGit } from "./probes.ts"
import type { MergeRequestResult, WorktreeEntry } from "./types.ts"

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

export async function prFacts(
  ctx: ManagerContext,
  entry: WorktreeEntry,
  title: string | undefined,
): Promise<PullRequestFacts> {
  const base = await forkPointFor(ctx.deps.git, entry)
  const log = await branchLog(ctx, entry, base ?? undefined)
  const stat = await tryGit(
    ctx.deps.git,
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

export async function branchLog(
  ctx: ManagerContext,
  entry: WorktreeEntry,
  base: string | undefined,
): Promise<string> {
  const log = await tryGit(
    ctx.deps.git,
    base === undefined ? ["log", "--oneline", "HEAD", "--not", "--remotes"] : ["log", "--oneline", `${base}..HEAD`],
    entry.worktreePath,
  )
  return log?.stdout.trim() ?? ""
}

export async function isDirty(git: CliRunner, entry: WorktreeEntry): Promise<boolean> {
  const status = await git.run(["status", "--porcelain"], { cwd: entry.worktreePath, timeoutMs: QUICK_MS })
  return status.stdout.trim() !== ""
}

export async function commitWorktree(git: CliRunner, entry: WorktreeEntry, subject: string): Promise<void> {
  await git.run(["commit", "-m", subject], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
}

export function commitSubject(sessionId: string, title: string | undefined, briefTitle: string | undefined): string {
  const named = [briefTitle, title]
    .map((text) => (text ?? "").trim())
    .find((text) => text !== "") ?? sessionSlugFor(sessionId)
  return `dsh-sbx: ${named}`.slice(0, 72)
}

export async function briefFor(
  ctx: ManagerContext,
  sessionId: string,
  facts: PullRequestFacts,
): Promise<{ brief?: PullRequestBrief; error?: string }> {
  const brief = ctx.deps.brief
  if (brief === undefined || !ctx.deps.config.prBrief.get()) return {}
  try {
    const outcome = await brief(sessionId, facts)
    return "brief" in outcome ? { brief: outcome.brief } : { error: outcome.error }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { error: `the naming subagent failed: ${detail}` }
  }
}

export function applyBriefName(
  ctx: ManagerContext,
  sessionId: string,
  entry: WorktreeEntry,
  slug: string | undefined,
): { from?: string; note?: string } {
  if (slug === undefined) return {}
  const wanted = `${ctx.deps.config.worktreeBranchPrefix}${slug}-${slugDigest(sessionId).slice(0, 6)}`
  if (wanted === entry.branch) return {}
  if (remoteBranchExists(ctx.deps.git, entry.repoRoot, entry.branch) ?? true) {
    return { note: `the branch had already been pushed as "${entry.branch}", so it keeps that name` }
  }
  try {
    ctx.deps.git.runSync(["branch", "-m", entry.branch, wanted], { cwd: entry.worktreePath, timeoutMs: QUICK_MS })
  } catch (error) {
    return { note: `could not rename the branch to "${wanted}": ${errorDetail(error)}` }
  }
  const from = entry.branch
  entry.branch = wanted
  entry.renamedFrom = from
  ctx.registry.save(entry.repoRoot)
  ctx.deps.logger?.info?.(
    `dsh-docker-sandbox: session ${sessionId} branch renamed "${from}" → "${wanted}" (named after the change)`,
  )
  return { from }
}

export async function pushOrigin(ctx: ManagerContext, entry: WorktreeEntry): Promise<string | undefined> {
  const remoteResult = await tryGit(ctx.deps.git, ["remote", "get-url", "origin"], entry.repoRoot)
  const remote = remoteResult?.stdout.trim()
  if (remote === undefined || remote === "") return undefined
  await ctx.deps.git.run(["push", "-u", "origin", entry.branch], { cwd: entry.worktreePath, timeoutMs: PUSH_MS })
  return remote
}

export async function openPullRequest(
  ctx: ManagerContext,
  entry: WorktreeEntry,
  remote: string,
  described: PullRequestFacts,
): Promise<Pick<MergeRequestResult, "prUrl" | "compareUrl" | "prError">> {
  const gh = ctx.deps.gh
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
    const recorded = await openPullRequestUrl(gh, entry)
    return recorded === undefined ? {} : { prUrl: recorded }
  } catch (error) {
    // A second click after the request exists fails `pr create`; the link of
    // the still-open request is what the button should show, so read it back.
    const existing = await openPullRequestUrl(gh, entry)
    if (existing !== undefined) return { prUrl: existing }
    return {
      prError: errorDetail(error),
      compareUrl: compareUrlFor(remote, entry.branch),
    }
  }
}

async function openPullRequestUrl(gh: CliRunner, entry: WorktreeEntry): Promise<string | undefined> {
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
