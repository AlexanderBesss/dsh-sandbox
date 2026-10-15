export type SandboxFailureCode =
  | "DOCKER_MISSING"
  | "DOCKER_UNREACHABLE"
  | "EXEC_TIMEOUT"
  | "EXEC_FAILED"
  | "NAME_CONFLICT"

export class SandboxUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: SandboxFailureCode,
    readonly detail?: string,
  ) {
    super(message)
    this.name = "SandboxUnavailableError"
  }
}

export function isMissingContainerError(error: unknown): boolean {
  return error instanceof SandboxUnavailableError
    && /no such (container|object)|does not exist/i.test(error.detail ?? error.message)
}

export function failureDetail(error: unknown): string {
  return error instanceof SandboxUnavailableError ? error.detail ?? error.message : String(error)
}

export function classify(argv: string[], code: number | null, stderr: Buffer): SandboxUnavailableError {
  const text = stderr.toString("utf8").trim()
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect|docker daemon is not running|connection refused|connection reset|npipe/i.test(text)) {
    return new SandboxUnavailableError(
      `the Docker daemon is not reachable from ${argv.join(" ")}: ${text.split("\n")[0]}`,
      "DOCKER_UNREACHABLE",
      text,
    )
  }
  if (/no such container|no such object|container "[^"]+" does not exist|is not running/i.test(text)) {
    return new SandboxUnavailableError(text.split("\n")[0] ?? "sandbox container is gone", "EXEC_FAILED", text)
  }
  if (/is already in use|conflict\. the container name/i.test(text)) {
    return new SandboxUnavailableError(text.split("\n")[0] ?? "container name conflict", "NAME_CONFLICT", text)
  }
  return new SandboxUnavailableError(
    `${argv.join(" ")} failed with exit code ${code ?? "(killed)"}`,
    "EXEC_FAILED",
    text,
  )
}
