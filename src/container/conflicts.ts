import type { CliRunner } from "./git.ts"
import { tryStdout } from "./git/output.ts"
import type { WorktreeEntry } from "./worktrees.ts"

const QUICK_MS = 15000
const DIFF_MS = 30000

export const MAX_CONFLICT_DIFF_CHARS = 120_000

// Windows caps a command line, so the diff is taken for a bounded prefix of the
// conflicted files; the rest are read by the resolver itself. `:(literal)` keeps
// a path holding glob magic from matching something other than itself.
export const MAX_DIFF_PATHS = 50

export interface ConflictFacts {
  merging: boolean
  conflicts: string[]
  mergingRef?: string
  mergingSubject?: string
  status: string
  diff: string
  truncated: boolean
  diffPathsTruncated: boolean
}

const gitText = (git: CliRunner, args: string[], cwd: string, timeoutMs = QUICK_MS): Promise<string> =>
  tryStdout(git, args, cwd, timeoutMs).then((stdout) => stdout ?? "")

// -z keeps paths byte-exact: the default output C-quotes anything outside ASCII,
// which would hand the resolver a filename that does not exist.
export async function conflictedFiles(git: CliRunner, entry: Pick<WorktreeEntry, "worktreePath">): Promise<string[]> {
  const names = await gitText(git, ["diff", "-z", "--name-only", "--diff-filter=U"], entry.worktreePath)
  return names.split("\0").filter((name) => name !== "")
}

export async function collectConflicts(git: CliRunner, entry: WorktreeEntry): Promise<ConflictFacts> {
  const mergeHead = (await gitText(git, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], entry.worktreePath)).trim()
  const conflicts = await conflictedFiles(git, entry)
  if (mergeHead === "") return { merging: false, conflicts, status: "", diff: "", truncated: false, diffPathsTruncated: false }
  const subject = (await gitText(git, ["log", "-1", "--format=%s", mergeHead], entry.worktreePath)).trim()
  const status = (await gitText(git, ["status", "--porcelain"], entry.worktreePath)).trim()
  const diffPathsTruncated = conflicts.length > MAX_DIFF_PATHS
  const raw = conflicts.length === 0
    ? ""
    : await gitText(git, ["diff", "--", ...conflicts.slice(0, MAX_DIFF_PATHS).map((file) => `:(literal)${file}`)], entry.worktreePath, DIFF_MS)
  const truncated = raw.length > MAX_CONFLICT_DIFF_CHARS
  return {
    merging: true,
    conflicts,
    mergingRef: mergeHead.slice(0, 12),
    ...(subject === "" ? {} : { mergingSubject: subject }),
    status,
    diff: truncated ? raw.slice(0, MAX_CONFLICT_DIFF_CHARS) : raw,
    truncated,
    diffPathsTruncated,
  }
}

export function buildConflictPrompt(entry: WorktreeEntry, facts: ConflictFacts): string {
  const incoming = facts.mergingRef ?? "an unknown commit"
  const diffScope = [
    facts.truncated ? `truncated to ${MAX_CONFLICT_DIFF_CHARS} chars` : "",
    facts.diffPathsTruncated ? `covering the first ${MAX_DIFF_PATHS} of ${facts.conflicts.length} files` : "",
  ].filter((note) => note !== "").join(", ")
  return [
    "You are resolving a merge conflict. You carry no memory of the conversation that wrote this branch;",
    "everything you know comes from this message and from the tools you run yourself.",
    "",
    `A conversation works in its own git worktree: /workspace (host: ${entry.worktreePath}), branch ${entry.branch}.`,
    `The worktree is mid-merge: HEAD is the conversation's work, MERGE_HEAD (${incoming}${facts.mergingSubject === undefined ? "" : `, "${facts.mergingSubject}"`})`,
    "is what was merged into it, and the merge stopped on conflicts.",
    "",
    "CONFLICTED FILES (git diff --name-only --diff-filter=U):",
    facts.conflicts.length === 0
      ? "(none — the markers are already resolved and only the merge commit is pending)"
      : facts.conflicts.map((file) => `- ${file}`).join("\n"),
    "",
    "WORKING TREE (git status --porcelain):",
    facts.status === "" ? "(clean)" : facts.status,
    "",
    `CONFLICTED FILES (git diff${diffScope === "" ? "" : `, ${diffScope}`}):`,
    facts.diff.trim() === "" ? "(empty — run `git diff` for it)" : facts.diff,
    "",
    "For each conflicted file:",
    "- Read the whole file, not only the hunk holding the markers, and work out what each side changed and why.",
    "- `git show :1:<file>` is the common ancestor, `:2:<file>` is this branch's side (ours), `:3:<file>` is the incoming side (theirs).",
    "- Keep both intents. Dropping a change either side made is a bug you introduced. Take one side only when the",
    "  other is genuinely redundant, and say so in your report.",
    "- Check the contract around the merged lines: callers, types, and tests that touch them.",
    "",
    "Then finish the merge yourself — `git add <resolved files>` and `git commit --no-edit`. Run the project's build",
    "and tests first when they exist; a green run is what makes the merge commit worth keeping.",
    "",
    "Do not `git merge --abort`, do not push, do not open a merge request, and add no commits beyond the merge commit.",
    "Do not touch files outside the conflict unless a merged line forces it (an import, a rename), and list any such edit.",
    "",
    "Report per file: what each side wanted, what the resolution keeps, and anything you could not settle.",
    "End with one line: MERGE COMMITTED <sha>, or NOT COMMITTED and why.",
  ].join("\n")
}
