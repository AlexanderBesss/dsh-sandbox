import type { CliRunner } from "./runner.ts"

export async function tryStdout(
  cli: CliRunner,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    return (await cli.run(args, { cwd, timeoutMs })).stdout
  } catch {
    return undefined
  }
}
