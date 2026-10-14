import { CliCommandError } from "../git.ts"

export function errorDetail(error: unknown): string {
  return error instanceof CliCommandError ? error.detail ?? error.message : String(error)
}
