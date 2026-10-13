/**
 * Making a fresh container usable.
 *
 * A newly created (or recreated) sandbox container is bare: the command
 * runner has to be copied in, and `rg` installed so `glob` / `grep` work.
 * This module owns those steps and the probe that decides which are still
 * needed; the provisioner keeps the lifecycle and calls into it.
 *
 * @module dsh-docker-sandbox/container/bootstrap
 */

import { readFile } from "node:fs/promises"
import type { SandboxTarget } from "./session.ts"
import type { DockerTransport } from "./transport.ts"

/** The logger slice the bootstrap steps report through. */
export type BootstrapLogger = {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
}

/** What the probe reports about a container's bootstrap state. */
export interface BootstrapFacts {
  agentsMissing: boolean
  rgMissing: boolean
}

/** Ask the container whether the runner script and `rg` are already in place. */
export async function probeBootstrap(transport: DockerTransport, target: SandboxTarget): Promise<BootstrapFacts> {
  const probe = await transport
    .execInContainer(
      target,
      [
        "sh",
        "-c",
        "test -f /tmp/.dsh-run.sh && echo AGENTS=yes || echo AGENTS=no; "
        + "command -v rg >/dev/null 2>&1 && echo RG=yes || echo RG=no",
      ],
      { timeoutMs: 30000 },
    )
    .catch(() => undefined)
  const facts = probe === undefined ? "AGENTS=no\nRG=no" : probe.stdout.toString("utf8")
  return { agentsMissing: facts.includes("AGENTS=no"), rgMissing: facts.includes("RG=no") }
}

/** Where `rg` comes from; mirrors the `ripgrepSource` config union. */
export type RipgrepSource = "package" | "url" | "none"

/** The install command for `rg`, per the configured source. */
export function ripgrepInstallCommand(source: RipgrepSource): string {
  return source === "url"
    ? "wget -qO- https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz | tar xz -C /usr/local/bin --strip-components=1"
    : "if [ -f /etc/alpine-release ]; then apk add --no-cache ripgrep; "
      + "elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq ripgrep; "
      + "elif command -v dnf >/dev/null 2>&1; then dnf install -y -q ripgrep; "
      + "else echo 'no package manager found for ripgrep' >&2; exit 3; fi"
}

/** Install `rg`, warning (not failing) when the image resists. */
export async function installRipgrep(
  transport: DockerTransport,
  target: SandboxTarget,
  source: RipgrepSource,
  logger?: BootstrapLogger,
): Promise<void> {
  const result = await transport.execInContainer(
    target,
    ["sh", "-c", ripgrepInstallCommand(source)],
    { timeoutMs: 180000 },
  )
  if (result.code !== 0) {
    logger?.warn?.(
      `ripgrep bootstrap failed in ${target.container} (exit ${result.code}): ${result.stderr.toString("utf8").trim().slice(0, 300)}`,
    )
    // Search degrades to a clear tool error; shell and files still work.
  }
}

/**
 * Copy the in-container command runner to `/tmp`.
 *
 * It travels through stdin rather than the command line: a multi-line POSIX
 * shell script embedded in an argv element is exactly what Windows argument
 * quoting corrupts.
 */
export async function uploadRunnerScript(transport: DockerTransport, target: SandboxTarget): Promise<void> {
  const content = await readFile(new URL("../../agent/run.sh", import.meta.url))
  // A checkout with CRLF line endings would leave a `\r` at the end of every
  // line, which POSIX sh reports as a missing command. Normalising here
  // makes the upload independent of how the package was unpacked.
  const script = content.toString("utf8").replace(/\r\n/g, "\n")
  await transport.execInContainer(
    target,
    ["sh", "-c", "cat > /tmp/.dsh-run.sh"],
    { stdin: script, timeoutMs: 60000 },
  )
}
