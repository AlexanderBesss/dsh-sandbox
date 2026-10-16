import { readFile } from "node:fs/promises"
import type { SandboxTarget } from "./session.ts"
import type { DockerTransport } from "./transport.ts"

export type BootstrapLogger = {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
}

export interface BootstrapFacts {
  agentsMissing: boolean
  rgMissing: boolean
  playwrightMissing: boolean
}

// PW=yes requires the CLI and a non-empty browser registry together; the registry
// path honors PLAYWRIGHT_BROWSERS_PATH so images that relocate it are read where
// they are. Non-root images report PW=skip: the install needs root for global npm
// and for the apt system deps.
const PROBE_SCRIPT = "test -f /tmp/.dsh-run.sh && echo AGENTS=yes || echo AGENTS=no; "
  + "command -v rg >/dev/null 2>&1 && echo RG=yes || echo RG=no; "
  + 'pwdir="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"; '
  + 'if ! command -v npm >/dev/null 2>&1 || [ "$(id -u)" != 0 ]; then echo PW=skip; '
  + 'elif command -v playwright >/dev/null 2>&1 && [ -n "$(ls -A "$pwdir" 2>/dev/null)" ]; then echo PW=yes; '
  + "else echo PW=no; fi"

export async function probeBootstrap(transport: DockerTransport, target: SandboxTarget): Promise<BootstrapFacts> {
  const probe = await transport
    .execInContainer(target, ["sh", "-c", PROBE_SCRIPT], { timeoutMs: 30000 })
    .catch(() => undefined)
  // PW=no on probe failure, not skip: the install is idempotent, and a failed
  // probe exec means the install exec fails fast too.
  const facts = probe === undefined ? "AGENTS=no\nRG=no\nPW=no" : probe.stdout.toString("utf8")
  return {
    agentsMissing: facts.includes("AGENTS=no"),
    rgMissing: facts.includes("RG=no"),
    playwrightMissing: facts.includes("PW=no"),
  }
}

export type RipgrepSource = "package" | "url" | "none"

// GitHub release assets are mutable, so the url branch verifies the tarball
// against the upstream sha256 before extracting into /usr/local/bin as root.
export function ripgrepInstallCommand(source: RipgrepSource): string {
  return source === "url"
    ? "wget -qO /tmp/dsh-rg.tgz https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz "
      + "&& echo '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e  /tmp/dsh-rg.tgz' | sha256sum -c - >/dev/null "
      + "&& tar xzf /tmp/dsh-rg.tgz -C /usr/local/bin --strip-components=1 && rm -f /tmp/dsh-rg.tgz"
    : "if [ -f /etc/alpine-release ]; then apk add --no-cache ripgrep; "
      + "elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq ripgrep; "
      + "elif command -v dnf >/dev/null 2>&1; then dnf install -y -q ripgrep; "
      + "else echo 'no package manager found for ripgrep' >&2; exit 3; fi"
}

// execInContainer throws on any non-zero exit or timeout, so bootstrap failures
// must be caught here: an uncaught error would fail ensure() and leave the entry
// unbootstrapped, making every later command retry the whole install.
const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function runBootstrapInstall(
  transport: DockerTransport,
  target: SandboxTarget,
  label: string,
  command: string,
  timeoutMs: number,
  logger?: BootstrapLogger,
): Promise<void> {
  try {
    await transport.execInContainer(target, ["sh", "-c", command], { timeoutMs })
  } catch (error) {
    logger?.warn?.(`${label} bootstrap failed in ${target.container}: ${failureMessage(error).slice(0, 300)}`)
  }
}

export async function installRipgrep(
  transport: DockerTransport,
  target: SandboxTarget,
  source: RipgrepSource,
  logger?: BootstrapLogger,
): Promise<void> {
  await runBootstrapInstall(transport, target, "ripgrep", ripgrepInstallCommand(source), 180000, logger)
}

const SAFE_VERSION = /^[0-9][0-9A-Za-z.+-]{0,31}$/

export function playwrightInstallCommand(browsers: readonly string[], version: string): string {
  const list = browsers.length > 0 ? browsers.join(" ") : "chromium"
  const pkg = SAFE_VERSION.test(version) ? `playwright@${version}` : "playwright"
  return `npm install -g ${pkg} && playwright install --with-deps ${list}`
}

export async function installPlaywright(
  transport: DockerTransport,
  target: SandboxTarget,
  browsers: readonly string[],
  version: string,
  timeoutMs: number,
  logger?: BootstrapLogger,
): Promise<void> {
  await runBootstrapInstall(transport, target, "playwright", playwrightInstallCommand(browsers, version), timeoutMs, logger)
}

export async function uploadRunnerScript(transport: DockerTransport, target: SandboxTarget): Promise<void> {
  const content = await readFile(new URL("../../agent/run.sh", import.meta.url))
  const script = content.toString("utf8").replace(/\r\n/g, "\n")
  await transport.execInContainer(
    target,
    ["sh", "-c", "cat > /tmp/.dsh-run.sh"],
    { stdin: script, timeoutMs: 60000 },
  )
}
