import type { LiveAgent, SandboxContext, SubagentRun, SubagentService } from "../context.ts"
import type { SandboxConfig } from "../config.ts"
import { PathMapper } from "../container/paths.ts"
import { Provisioner } from "../container/provisioner.ts"
import { buildConflictPrompt } from "../container/conflicts.ts"
import { buildReviewPrompt, changesAreEmpty } from "../container/review.ts"
import type { WorktreeManager } from "../container/worktrees.ts"
import { failure, requirePost, type Respond } from "./respond.ts"
import { CONFLICT_SETTLEMENT, REVIEW_SETTLEMENT, settleSubagentRun, type SettlementKind } from "./settlement.ts"
import type { ResolverGuard, ResolverSlot } from "./resolver-guard.ts"
import type { SubagentKind, SubagentRunRegistry } from "./run-registry.ts"

export interface StatusDeps {
  provisioner: Provisioner
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
  subagents?: () => SubagentService | undefined
  resolvers: ResolverGuard
  runs: SubagentRunRegistry
}

export async function handleMergeRequest(
  respond: Respond,
  deps: StatusDeps,
  sessionId: string,
  workspace: string,
  isPost: boolean,
): Promise<void> {
  if (!requirePost(respond, "merge-request", isPost)) return
  const worktrees = deps.worktrees
  if (worktrees === undefined) {
    respond(409, failure("worktree-off", "worktree mode is disabled, so this session has no branch to merge"))
    return
  }
  respond(200, { ok: true, data: await worktrees.mergeRequest(sessionId, workspace) })
}

interface SubagentLaunch {
  subagents: SubagentService
  provider: string
  parent: LiveAgent
}

function subagentLaunch(
  respond: Respond,
  ctx: SandboxContext,
  deps: StatusDeps,
  sessionId: string,
): SubagentLaunch | undefined {
  const subagents = deps.subagents?.()
  const provider = subagents?.list()[0]
  if (subagents === undefined || provider === undefined) {
    respond(503, failure(
      "no-subagents",
      subagents === undefined ? "the subagent service is not available" : "no subagent provider is registered",
    ))
    return undefined
  }
  const parent = ctx.agents?.get?.(sessionId)
  if (parent === undefined) {
    respond(409, failure("no-agent", "this session has no live agent to delegate from"))
    return undefined
  }
  return { subagents, provider, parent }
}

const SETTLEMENT_BY_KIND: Record<SubagentKind, SettlementKind> = {
  review: REVIEW_SETTLEMENT,
  resolve: CONFLICT_SETTLEMENT,
}

interface SubagentStart {
  ctx: SandboxContext
  deps: StatusDeps
  launch: SubagentLaunch
  sessionId: string
  kind: SubagentKind
  label: string
  prompt: string
  slot?: ResolverSlot
}

async function startSubagentRun(start: SubagentStart): Promise<string> {
  const { ctx, deps, launch, sessionId, kind, label, prompt, slot } = start
  const controller = new AbortController()
  let run: SubagentRun
  try {
    run = await launch.subagents.start(launch.provider, {
      prompt: [{ type: "text", text: prompt }],
      parent: launch.parent,
      signal: controller.signal,
      label,
    })
  } catch (error) {
    slot?.release()
    throw error
  }
  const childSessionId = run.localAgent?.session?.id ?? ""
  const handle = deps.runs.track(sessionId, kind, controller, childSessionId)
  void settleSubagentRun(ctx, run, sessionId, childSessionId, SETTLEMENT_BY_KIND[kind])
    .finally(() => {
      deps.runs.release(sessionId, handle)
      slot?.release()
    })
  return childSessionId
}

export async function handleReview(
  respond: Respond,
  ctx: SandboxContext,
  deps: StatusDeps,
  sessionId: string,
  workspace: string,
  isPost: boolean,
): Promise<void> {
  if (!requirePost(respond, "review", isPost)) return
  const bundle = deps.worktrees === undefined
    ? undefined
    : await deps.worktrees.reviewFor(sessionId, workspace)
  if (bundle === undefined) {
    respond(409, failure("no-worktree", "this session has no git worktree to review yet (worktree mode is off, or no tool call has created one)"))
    return
  }
  if (changesAreEmpty(bundle.changes)) {
    respond(409, failure("no-changes", "this session has made no changes to review"))
    return
  }
  const launch = subagentLaunch(respond, ctx, deps, sessionId)
  if (launch === undefined) return
  const childSessionId = await startSubagentRun({
    ctx,
    deps,
    launch,
    sessionId,
    kind: "review",
    label: "code review",
    prompt: buildReviewPrompt(bundle.entry, bundle.changes),
  })
  respond(200, { ok: true, data: { provider: launch.provider, childSessionId } })
}

export async function handleResolveConflicts(
  respond: Respond,
  ctx: SandboxContext,
  deps: StatusDeps,
  sessionId: string,
  workspace: string,
  isPost: boolean,
): Promise<void> {
  if (!requirePost(respond, "resolve-conflicts", isPost)) return
  const worktrees = deps.worktrees
  if (worktrees === undefined) {
    respond(409, failure("worktree-off", "worktree mode is disabled, so this session has no merge to resolve"))
    return
  }
  const bundle = await worktrees.conflictsFor(sessionId, workspace)
  if (bundle === undefined) {
    respond(409, failure("no-worktree", "this session has no git worktree to resolve conflicts in (worktree mode is off, or no tool call has created one)"))
    return
  }
  if (!bundle.facts.merging) {
    respond(409, failure("no-conflicts", "this session's worktree is not mid-merge, so there is nothing to resolve"))
    return
  }
  const launch = subagentLaunch(respond, ctx, deps, sessionId)
  if (launch === undefined) return
  if (launch.parent.status === "running") {
    respond(409, failure(
      "agent-busy",
      "the conversation's agent is mid-turn and may already be resolving these markers; wait for its turn to end, then click again",
    ))
    return
  }
  const slot = deps.resolvers.tryStart(sessionId)
  if (slot === undefined) {
    respond(409, failure("resolver-running", "a resolver is already working on this worktree; its report lands in the chat when it finishes"))
    return
  }
  const childSessionId = await startSubagentRun({
    ctx,
    deps,
    launch,
    sessionId,
    kind: "resolve",
    label: "conflict resolution",
    prompt: buildConflictPrompt(bundle.entry, bundle.facts),
    slot,
  })
  respond(200, {
    ok: true,
    data: { provider: launch.provider, childSessionId, conflicts: bundle.facts.conflicts.length },
  })
}

const CANCEL_LABEL: Record<SubagentKind, string> = {
  review: "review",
  resolve: "resolver",
}

export function subagentKindOf(value: string | null): SubagentKind | undefined {
  return value === "review" || value === "resolve" ? value : undefined
}

export async function handleCancelSubagent(
  respond: Respond,
  deps: StatusDeps,
  sessionId: string,
  kind: SubagentKind | undefined,
  isPost: boolean,
): Promise<void> {
  if (!requirePost(respond, "cancel-subagent", isPost)) return
  if (kind === undefined) {
    respond(400, failure("bad-request", "kind must be review or resolve"))
    return
  }
  const handles = deps.runs.cancel(sessionId, kind)
  if (handles.length === 0) {
    respond(409, failure("no-run", `no ${CANCEL_LABEL[kind]} is running for this session`))
    return
  }
  respond(200, {
    ok: true,
    data: { cancelled: handles.length, childSessionIds: handles.map((handle) => handle.childSessionId) },
  })
}
