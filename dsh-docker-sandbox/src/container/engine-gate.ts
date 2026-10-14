/**
 * The turn gate: a worktree-mode conversation must not run while the Docker
 * engine is unreachable.
 *
 * Worktree mode promises the conversation works in its own container-mounted
 * worktree. With the engine down that promise is void — the file tools are
 * host-backed, so the chat would quietly edit the main checkout while the
 * model announces full access to it, and no tool call ever surfaces the
 * broken sandbox. The turn must therefore not run at all.
 *
 * The gate hangs on `agent/pre-step`, the boundary the app's own
 * archived-session gate uses: a listener that *throws* ends the turn as an
 * error the app renders in the conversation (a `{ kind: "reject" }` decision
 * would end it silently, which is exactly the failure mode being fixed). The
 * thrown message carries the one instruction that resolves it: start the
 * Docker engine.
 *
 * @module dsh-docker-sandbox/container/engine-gate
 */

import type { Events } from "@deepseek-ai/cordis"
import type { SandboxConfig } from "../config.ts"
import type { Provisioner } from "./provisioner.ts"

/**
 * Build the `agent/pre-step` listener gating worktree-mode turns on engine
 * reachability. While worktree mode is off the gate is inert: the documented
 * contract there is that container-backed *tools* fail with named errors, and
 * a tool-free chat never touches the engine.
 *
 * @param provisioner - asked whether the engine answers (probe cached).
 * @param config - the live `worktree` toggle, read per step.
 * @returns a waterfall listener to register on the plugin context.
 */
export function createEngineGate(
  provisioner: Provisioner,
  config: SandboxConfig,
): Events["agent/pre-step"] {
  return async (_payload, next) => {
    if (!config.worktree.get()) return await next()
    const engine = await provisioner.engineReachable()
    if (engine.reachable) return await next()
    throw new Error(
      "dsh-docker-sandbox: this conversation runs in a Docker sandbox, but the Docker engine is not reachable"
      + ` (${engine.error ?? "no detail"}). Start Docker Desktop (or your Docker engine) and send the message again.`,
    )
  }
}
