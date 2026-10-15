import type { CliRunner } from "./git.ts"
import { tryStdout } from "./git/output.ts"
import type { WorktreeEntry } from "./worktrees.ts"

const REVIEW_MS = 30000

export const MAX_DIFF_CHARS = 120_000

export interface SessionChanges {
  base?: string
  log: string
  status: string
  diff: string
  truncated: boolean
}

const tryGit = (git: CliRunner, args: string[], cwd: string, timeoutMs = REVIEW_MS): Promise<string | undefined> =>
  tryStdout(git, args, cwd, timeoutMs)

const trimmedOutput = (output: string | undefined): string | undefined => {
  const trimmed = output?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

export async function forkPointFor(
  git: CliRunner,
  tree: Pick<WorktreeEntry, "worktreePath" | "mainWorkspace">,
  timeoutMs = REVIEW_MS,
): Promise<string | undefined> {
  const mainHead = trimmedOutput(await tryGit(git, ["symbolic-ref", "--short", "HEAD"], tree.mainWorkspace, timeoutMs))
  if (mainHead === undefined) return undefined
  return trimmedOutput(await tryGit(git, ["merge-base", "HEAD", mainHead], tree.worktreePath, timeoutMs))
}

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

export function changesAreEmpty(changes: SessionChanges): boolean {
  return changes.status === "" && changes.log === "" && changes.diff.trim() === ""
}

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
