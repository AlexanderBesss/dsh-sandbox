import { OWNERSHIP_LABEL, SESSION_LABEL } from "../session.ts"
import { isMissingContainerError, type DockerTransport } from "../transport.ts"

export interface ContainerInspect {
  Name?: string
  Created?: string
  State?: { Status?: string }
  Config?: { Labels?: Record<string, string> }
}

export interface OwnedContainer {
  name: string
  phase: string
  createdAt?: string
  sessionId?: string
}

export function phaseOfState(state: string): string {
  if (state === "") return "unknown"
  return state[0]!.toUpperCase() + state.slice(1)
}

export async function inspectContainerState(
  transport: DockerTransport,
  container: string,
): Promise<{ state?: string; owned?: boolean }> {
  try {
    const result = await transport.docker(
      ["inspect", "--format", "{{.State.Status}}|{{.Config.Labels}}", container],
      { timeoutMs: 30000 },
    )
    const text = result.stdout.toString("utf8").trim()
    if (text === "") return {}
    const [state = "", labels = ""] = text.split("|")
    return { state: state === "" ? undefined : state, owned: /\bdsh\.sandbox:1\b/.test(labels) }
  } catch (error) {
    if (isMissingContainerError(error)) return {}
    throw error
  }
}

export async function listOwnedContainers(transport: DockerTransport): Promise<OwnedContainer[]> {
  const ids = await transport.docker(["ps", "-aq", "--filter", `label=${OWNERSHIP_LABEL}`], { timeoutMs: 30000 })
  const idList = ids.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  if (idList.length === 0) return []
  const inspected = await transport.dockerJson<ContainerInspect[]>(["inspect", ...idList], { timeoutMs: 30000 })
  return inspected.map((container) => ({
    name: (container.Name ?? "").replace(/^\//, ""),
    phase: phaseOfState(container.State?.Status ?? ""),
    createdAt: container.Created,
    sessionId: container.Config?.Labels?.[SESSION_LABEL],
  }))
}
