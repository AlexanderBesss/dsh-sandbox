import type { CliResult, CliRunner } from "../git.ts"
import { QUICK_MS } from "./constants.ts"

export function tryGitSync(git: CliRunner, args: string[], cwd: string): CliResult | undefined {
  try {
    return git.runSync(args, { cwd, timeoutMs: QUICK_MS })
  } catch {
    return undefined
  }
}

export async function tryGit(git: CliRunner, args: string[], cwd: string): Promise<CliResult | undefined> {
  try {
    return await git.run(args, { cwd, timeoutMs: QUICK_MS })
  } catch {
    return undefined
  }
}

export function revParse(git: CliRunner, cwd: string, ref: string): string | undefined {
  const out = tryGitSync(git, ["rev-parse", ref], cwd)?.stdout.trim()
  return out === undefined || out === "" ? undefined : out
}

export function remoteBranchExists(git: CliRunner, cwd: string, branch: string): boolean | undefined {
  const refs = tryGitSync(git, ["for-each-ref", "--count=1", `refs/remotes/origin/${branch}`], cwd)
  return refs === undefined ? undefined : refs.stdout.trim() !== ""
}

export async function isMerging(git: CliRunner, worktreePath: string): Promise<boolean> {
  const head = await tryGit(git, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktreePath)
  return head !== undefined && head.stdout.trim() !== ""
}

export async function countBehind(git: CliRunner, worktreePath: string, originRef: string): Promise<number | undefined> {
  const count = await tryGit(git, ["rev-list", "--count", `HEAD..${originRef}`], worktreePath)
  if (count === undefined) return undefined
  const n = Number.parseInt(count.stdout.trim(), 10)
  return Number.isNaN(n) ? undefined : n
}
