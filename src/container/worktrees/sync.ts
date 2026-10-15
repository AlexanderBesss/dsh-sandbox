import { conflictedFiles } from "../conflicts.ts"
import { lockfileHash } from "./checkout.ts"
import { MERGE_MS } from "./constants.ts"
import type { ManagerContext } from "./context.ts"
import { errorDetail } from "./errors.ts"
import { countBehind, isMerging, revParse, tryGit } from "./probes.ts"
import type { SyncOutcome, WorktreeEntry } from "./types.ts"

const RESOLVE_RULES = [
  "(or `git merge --abort` to back the merge out). Do not open a merge request while it is unresolved.",
  "The *resolve conflicts* button in the session header hands the same job to a fresh resolver session.",
]

export async function syncEntry(ctx: ManagerContext, entry: WorktreeEntry): Promise<SyncOutcome> {
  const { git, logger } = ctx.deps
  if (await isMerging(git, entry.worktreePath)) {
    await notifyMidMerge(ctx, entry)
    return { state: "conflict" }
  }
  if (entry.notifiedMerging === true) {
    entry.notifiedMerging = undefined
    ctx.registry.save(entry.repoRoot)
  }
  const originRef = await ctx.origin.refFor(entry.repoRoot)
  if (originRef === undefined) return { state: "unavailable" }
  const behind = await countBehind(git, entry.worktreePath, originRef)
  if (behind === undefined) return { state: "unavailable" }
  if (behind === 0) {
    if (entry.notifiedBehind !== undefined) {
      entry.notifiedBehind = undefined
      ctx.registry.save(entry.repoRoot)
    }
    reinstallIfStale(ctx, entry)
    return { state: "up-to-date" }
  }
  const status = await tryGit(git, ["status", "--porcelain"], entry.worktreePath)
  if (status === undefined) return { state: "unavailable" }
  if (status.stdout.trim() !== "") {
    notifyBehind(ctx, entry, originRef, behind)
    return { state: "deferred", behind }
  }
  try {
    await git.run(["merge", "--no-edit", originRef], { cwd: entry.worktreePath, timeoutMs: MERGE_MS })
  } catch (error) {
    if (!await isMerging(git, entry.worktreePath)) {
      logger?.warn?.(
        `dsh-docker-sandbox: syncing session ${entry.sessionId} to ${originRef} failed: ${errorDetail(error)}; the worktree was left untouched`,
      )
      return { state: "failed", behind }
    }
    const conflicts = await conflictedFiles(git, entry)
    logger?.warn?.(
      `dsh-docker-sandbox: syncing session ${entry.sessionId} to ${originRef} conflicted in ${conflicts.length} file(s); `
      + "the session was asked to resolve them",
    )
    const notice = [
      `dsh-docker-sandbox: main moved ahead of this session's branch by ${behind} commit(s), and I merged ${originRef} into ${entry.branch}.`,
      ...conflictLines(conflicts, "The merge left conflicts; `git status` shows which files."),
      `The worktree is mid-merge. ${resolveLine(ctx.deps.config.containerWorkspace)}`,
      ...RESOLVE_RULES,
    ].join("\n")
    recordMergeNotice(ctx, entry, notice)
    return { state: "conflict", behind, conflicts }
  }
  entry.notifiedBehind = undefined
  entry.baseRef = originRef
  ctx.registry.save(entry.repoRoot)
  logger?.info?.(
    `dsh-docker-sandbox: session ${entry.sessionId} branch ${entry.branch} merged ${behind} commit(s) from ${originRef}`,
  )
  reinstallIfStale(ctx, entry)
  return { state: "merged", behind }
}

async function notifyMidMerge(ctx: ManagerContext, entry: WorktreeEntry): Promise<void> {
  if (entry.notifiedMerging === true) return
  const conflicts = await conflictedFiles(ctx.deps.git, entry)
  const notice = [
    "dsh-docker-sandbox: this session's worktree is mid-merge with unresolved conflicts.",
    ...conflictLines(conflicts, "Run `git status` to see which files conflict."),
    resolveLine(ctx.deps.config.containerWorkspace),
    ...RESOLVE_RULES,
  ].join("\n")
  recordMergeNotice(ctx, entry, notice)
}

function recordMergeNotice(ctx: ManagerContext, entry: WorktreeEntry, notice: string): void {
  if (ctx.deps.notify?.(entry.sessionId, notice) !== true) return
  entry.notifiedMerging = true
  ctx.registry.save(entry.repoRoot)
}

function conflictLines(conflicts: string[], whenUnlisted: string): string[] {
  return conflicts.length === 0
    ? [whenUnlisted]
    : ["These files conflict:", ...conflicts.map((file) => `  ${file}`)]
}

function resolveLine(containerWorkspace: string): string {
  return `Resolve the conflict markers under ${containerWorkspace} and finish with \`git commit\``
}

function notifyBehind(ctx: ManagerContext, entry: WorktreeEntry, originRef: string, behind: number): void {
  const sha = revParse(ctx.deps.git, entry.repoRoot, originRef)
  if (sha === undefined || entry.notifiedBehind === sha) return
  entry.notifiedBehind = sha
  ctx.registry.save(entry.repoRoot)
  ctx.deps.notify?.(entry.sessionId, [
    `dsh-docker-sandbox: main moved ahead of this session's branch by ${behind} commit(s).`,
    "The worktree has uncommitted changes, so nothing was merged. Commit your work;",
    `the next sync will merge ${originRef} into ${entry.branch} (and tell you if it conflicts).`,
  ].join("\n"))
}

function reinstallIfStale(ctx: ManagerContext, entry: WorktreeEntry): void {
  const hash = lockfileHash(entry.worktreePath)
  if (hash === undefined) return
  if (entry.lockHash === undefined) {
    entry.lockHash = hash
    ctx.registry.save(entry.repoRoot)
    return
  }
  // lockHash stays at the installed lockfile until the install succeeds
  // (markInstalled records it), so a failed reinstall retries on the next sync.
  if (entry.lockHash !== hash) ctx.deps.onTreeChanged?.(entry)
}
