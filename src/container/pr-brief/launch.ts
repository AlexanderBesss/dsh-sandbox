import type { SandboxConfig } from "../../config.ts"
import type { LiveAgent, SubagentResult, SubagentService } from "../../context.ts"
import type { BootstrapLogger } from "../bootstrap.ts"
import type { CliRunner } from "../git.ts"
import { tryStdout } from "../git/output.ts"
import type { PullRequestFacts } from "../pr-description.ts"
import { forkPointFor } from "../review.ts"
import { buildBriefPrompt } from "./prompt.ts"
import { parseBrief, type PullRequestBrief } from "./parse.ts"

const SETTLE_GRACE_MS = 15000

export type BriefOutcome = { brief: PullRequestBrief } | { error: string }

export type PrBrief = (sessionId: string, facts: PullRequestFacts) => Promise<BriefOutcome>

export interface PrBriefDeps {
  subagents: () => SubagentService | undefined
  parentFor: (sessionId: string) => LiveAgent | undefined
  git: CliRunner
  config: SandboxConfig
  logger?: BootstrapLogger
}

const gitText = async (git: CliRunner, args: string[], cwd: string, timeoutMs: number): Promise<string> =>
  (await tryStdout(git, args, cwd, timeoutMs))?.trim() ?? ""

function stopReasonText(reason: string): string {
  switch (reason) {
    case "aborted": return "was stopped before it finished"
    case "max-tokens": return "ran out of room before it finished"
    case "refusal": return "declined the task"
    case "error": return "failed before it finished"
    default: return `ended (${reason}) without an answer`
  }
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createPrBrief(deps: PrBriefDeps): PrBrief {
  const fallback = "the branch keeps its current name and the description lists its commits only"
  return async (sessionId, facts) => {
    const subagents = deps.subagents()
    if (subagents === undefined) return { error: `the subagent service is not available, so ${fallback}` }
    const provider = subagents.list()[0]
    if (provider === undefined) return { error: `no subagent provider is registered, so ${fallback}` }
    const parent = deps.parentFor(sessionId)
    if (parent === undefined) return { error: `this session has no live agent to delegate to, so ${fallback}` }

    const budgetMs = deps.config.prBriefTimeoutMs
    const deadline = Date.now() + budgetMs
    const left = () => Math.max(deadline - Date.now(), 1)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budgetMs)
    try {
      const base = facts.base ?? await forkPointFor(deps.git, facts, left())
      const diff = await gitText(
        deps.git,
        base === undefined ? ["diff", "HEAD"] : ["diff", base],
        facts.worktreePath,
        left(),
      )
      const prompt = buildBriefPrompt({ ...facts, ...(base === undefined ? {} : { base }) }, diff, budgetMs)

      const started = subagents.start(provider, {
        prompt: [{ type: "text", text: prompt }],
        parent,
        signal: controller.signal,
        label: "pull request brief",
      })
      const run = await within(started, left())
      if (run === undefined) {
        void started.then((late) => { void late.dispose?.() }, () => undefined)
        return { error: `the naming subagent could not be started within ${budgetMs} ms, so ${fallback}` }
      }
      let result: SubagentResult | undefined
      try {
        result = await within(run.result, left() + Math.min(SETTLE_GRACE_MS, budgetMs))
      } catch {
        result = undefined
      }
      try {
        await run.dispose?.()
      } catch {
      }
      if (result === undefined) {
        return { error: `the naming subagent did not answer within ${budgetMs} ms, so ${fallback}` }
      }
      if (result.stopReason === "refusal") {
        return { error: `the naming subagent ${stopReasonText(result.stopReason)}, so ${fallback}` }
      }
      const answer = result.output
        .filter((block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
      const brief = parseBrief(answer)
      // A child cut off by the deadline or its token cap may already have written
      // the whole shape; keep it rather than throwing the pass away.
      if (brief === undefined) {
        if (result.stopReason !== "completed") {
          return { error: `the naming subagent ${stopReasonText(result.stopReason)}, so ${fallback}` }
        }
        return { error: `the naming subagent answered in a shape that could not be read, so ${fallback}` }
      }
      deps.logger?.info?.(
        `dsh-docker-sandbox: pull request brief for session ${sessionId}: `
        + `branch ${brief.branchSlug ?? "(kept)"}, ${brief.bullets.length} bullet(s)`,
      )
      return { brief }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { error: `the naming subagent could not start: ${detail}, so ${fallback}` }
    } finally {
      clearTimeout(timer)
    }
  }
}
