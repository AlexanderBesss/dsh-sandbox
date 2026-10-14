/**
 * Session review: collect one conversation's changes and phrase them for a
 * fresh reviewer.
 *
 * The review button spawns a subagent with *no* memory of the conversation
 * that produced the changes — its only inputs are the diff collected here and
 * the tools it can run itself in the sandbox. Collecting on the host (rather
 * than asking the reviewer to diff) keeps the prompt complete even when the
 * session's work is uncommitted, where a plain `git log` would show nothing.
 *
 * The diff is taken against the branch's fork point (merge-base with the
 * branch the main checkout has checked out), so it covers both the session's
 * commits and its uncommitted edits — exactly "what this conversation
 * changed".
 *
 * @module dsh-docker-sandbox/container/review
 */

import type { CliRunner } from "./git.ts"
import type { WorktreeEntry } from "./worktrees.ts"

/** Budget for one review git call. */
const REVIEW_MS = 30000

/** Cap on the diff embedded in the prompt; the reviewer can always re-run git. */
export const MAX_DIFF_CHARS = 120_000

/** One conversation's changes, as the reviewer sees them. */
export interface SessionChanges {
  /** Short sha of the fork point the branch started from, when it is known. */
  base?: string
  /** `git log --oneline` of the session's own commits ("" when none). */
  log: string
  /** `git status --porcelain` of the worktree ("" when clean). */
  status: string
  /** Unified diff of tracked changes against the fork point. */
  diff: string
  /** True when {@link SessionChanges.diff} was cut to the size cap. */
  truncated: boolean
}

/** Run one git call, swallowing failure (an absent answer, not an error). */
async function tryGit(git: CliRunner, args: string[], cwd: string, timeoutMs = REVIEW_MS): Promise<string | undefined> {
  try {
    const out = await git.run(args, { cwd, timeoutMs })
    return out.stdout
  } catch {
    return undefined
  }
}

/**
 * The commit a session branch forked from: merge-base of the session branch
 * with whatever the main checkout has checked out.
 *
 * Shared by the review prompt and the pull-request description — both need to
 * describe "what this conversation changed", and both are wrong without the
 * same fork point. A detached main checkout yields `undefined`, and callers
 * fall back to describing the branch against `HEAD`.
 *
 * @param git - the host git CLI runner.
 * @param tree - the session worktree and the checkout it was carved from.
 * @param timeoutMs - budget for each probe; the pull-request pass shrinks it to
 *   the time its own deadline leaves.
 * @returns the fork point sha, or undefined when it cannot be computed.
 */
export async function forkPointFor(
  git: CliRunner,
  tree: Pick<WorktreeEntry, "worktreePath" | "mainWorkspace">,
  timeoutMs = REVIEW_MS,
): Promise<string | undefined> {
  const mainHead = await tryGit(git, ["symbolic-ref", "--short", "HEAD"], tree.mainWorkspace, timeoutMs)
  if (mainHead === undefined || mainHead.trim() === "") return undefined
  const merged = await tryGit(git, ["merge-base", "HEAD", mainHead.trim()], tree.worktreePath, timeoutMs)
  return merged === undefined || merged.trim() === "" ? undefined : merged.trim()
}

/**
 * Collect everything one worktree changed since its branch forked.
 *
 * @param git - the host git CLI runner.
 * @param entry - the session's worktree record.
 * @returns the changes, empty-string fields when there are none.
 */
export async function collectChanges(git: CliRunner, entry: WorktreeEntry): Promise<SessionChanges> {
  const cwd = entry.worktreePath
  const base = await forkPointFor(git, entry)

  const diffOut = await tryGit(git, base !== undefined ? ["diff", base] : ["diff", "HEAD"], cwd) ?? ""
  const logOut = await tryGit(
    git,
    base !== undefined ? ["log", "--oneline", `${base}..HEAD`] : ["log", "--oneline", "HEAD", "--not", "--remotes"],
    cwd,
  ) ?? ""
  const statusOut = await tryGit(git, ["status", "--porcelain"], cwd) ?? ""

  const truncated = diffOut.length > MAX_DIFF_CHARS
  return {
    ...(base !== undefined ? { base: base.slice(0, 12) } : {}),
    log: logOut.trim(),
    status: statusOut.trim(),
    diff: truncated ? diffOut.slice(0, MAX_DIFF_CHARS) : diffOut,
    truncated,
  }
}

/** Whether there is nothing at all to review. */
export function changesAreEmpty(changes: SessionChanges): boolean {
  return changes.status === "" && changes.log === "" && changes.diff.trim() === ""
}

/**
 * The reviewer's prompt: a fresh agent that knows nothing about how the
 * changes came to be, told what to look at and how to report.
 *
 * @param entry - the session's worktree record.
 * @param changes - the collected changes.
 * @returns the prompt text for the review subagent.
 */
export function buildReviewPrompt(entry: WorktreeEntry, changes: SessionChanges): string {
  return [
    "You are a fresh code reviewer. You carry no memory of the conversation that produced these changes;",
    "everything you know comes from this message and from tools you run yourself. Review the work critically.",
    "",
    `A conversation worked in its own git worktree: /workspace (host: ${entry.worktreePath}), branch ${entry.branch}.`,
    `Fork point: ${changes.base ?? "unknown (main checkout detached; diff is against HEAD)"}.`,
    "",
    "SESSION COMMITS (git log --oneline):",
    changes.log === "" ? "(none — the work is uncommitted)" : changes.log,
    "",
    "WORKING TREE (git status --porcelain):",
    changes.status === "" ? "(clean)" : changes.status,
    "",
    `DIFF (tracked changes${changes.base !== undefined ? " vs the fork point" : " vs HEAD"}${changes.truncated ? `, truncated to ${MAX_DIFF_CHARS} chars` : ""}):`,
    changes.diff.trim() === "" ? "(empty)" : changes.diff,
    "",
    "Untracked files appear in the status but not in the diff; read them under /workspace when they matter.",
    "",
    "Review the changes for:",
    "- correctness: bugs, broken edge cases, wrong assumptions",
    "- security: injection, secrets, unsafe deserialization, path traversal",
    "- contract drift: callers or tests not updated, API misuse",
    "- consistency with the surrounding codebase's style",
    "- missing or weak tests",
    "",
    "You have tools in this container: `git status`, `git diff`, `git log`, and file reads under /workspace all",
    "work. Do not modify anything — this is review only.",
    "",
    "Report findings grouped by severity (blocker / major / minor / nit). For each: file:line, what is wrong, and a",
    "one-line fix. If the changes are sound, say so plainly; do not invent problems. End with a one-paragraph verdict.",
  ].join("\n")
}
