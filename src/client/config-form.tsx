import { createElement, useState, type ChangeEvent, type KeyboardEvent } from "react"

interface FormState {
  status: "loading" | "ready" | "unavailable"
  value?: Record<string, unknown>
  writable?: boolean
  revision?: number
}

export interface RowConfigForm {
  state?: FormState
  mutate: (ops: unknown[], expectedRevision?: number) => Promise<boolean>
}

interface FieldSpec {
  path: readonly string[]
  label: string
  kind: "string" | "number" | "boolean"
  hint: string
}

const FIELDS: FieldSpec[] = [
  { path: ["worktree"], label: "Per-session git worktrees", kind: "boolean", hint: "Each chat works in its own git worktree and branch, so chats cannot conflict; the session header gains a merge-request button. Applies to chats as they provision their next container." },
  { path: ["image"], label: "Container image", kind: "string", hint: "Applied to the next container the chat provisions." },
  { path: ["bootstrapPlaywright"], label: "Install Playwright on first use", kind: "boolean", hint: "Adds the Playwright CLI and Chromium to a container whose image carries npm and runs as root, so the agent can browse, screenshot, and diff images inside the sandbox. The first command then pays a few minutes of install; skipped when the image already carries Playwright or lacks npm/root." },
  { path: ["pwshGuard"], label: "Reject PowerShell commands", kind: "boolean", hint: "The app's Pwsh tool sends PowerShell text into the Linux container; the guard answers once with a redirect to the Bash tool instead of a 127 cmdlet-not-found. Turn off only for images that carry pwsh." },
  { path: ["resourceLimits", "memory"], label: "Memory limit", kind: "string", hint: "Docker size syntax, e.g. 4g or 512m. Empty leaves it unbounded." },
  { path: ["resourceLimits", "memorySwap"], label: "Memory + swap cap", kind: "string", hint: "Set equal to the memory limit to forbid swap spillover (hard cap)." },
  { path: ["resourceLimits", "cpu"], label: "CPU cores", kind: "string", hint: "Docker --cpus value, e.g. 2. Empty leaves it unbounded." },
  { path: ["timeoutMs"], label: "Default command timeout (ms)", kind: "number", hint: "Applies immediately to new commands." },
  { path: ["maxTimeoutMs"], label: "Maximum command timeout (ms)", kind: "number", hint: "Caller requests above this are clamped." },
  { path: ["maxOutputBytes"], label: "Max output bytes per stream", kind: "number", hint: "Beyond this the shell tools report truncated output." },
  { path: ["graceMs"], label: "Terminate grace (ms)", kind: "number", hint: "SIGTERM to SIGKILL escalation window." },
  { path: ["idleTtlMs"], label: "Idle container TTL (ms)", kind: "number", hint: "Containers unused this long are deleted by the GC loop." },
]

function readPath(value: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = value
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

function FieldRow({ spec, current, writable, onCommit }: {
  spec: FieldSpec
  current: unknown
  writable: boolean
  onCommit: (path: readonly string[], value: unknown) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const shown = draft ?? (current === undefined || current === null ? "" : String(current))
  const commit = async () => {
    if (draft === undefined || busy) return
    let next: unknown = draft.trim()
    if (spec.kind === "number") {
      const parsed = Number(next)
      if (!Number.isFinite(parsed) || parsed < 0) { setFailed(true); setDraft(undefined); return }
      next = parsed
    }
    setBusy(true)
    const ok = await onCommit(spec.path, next)
    setBusy(false)
    setDraft(undefined)
    setFailed(!ok)
  }
  if (spec.kind === "boolean") {
    return createElement("label", { style: { display: "grid", gap: 2, marginBlock: 8 } },
      createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 } },
        createElement("input", {
          type: "checkbox",
          checked: current === true,
          disabled: !writable || busy,
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            void onCommit(spec.path, event.target.checked)
          },
        }),
        spec.label,
      ),
      createElement("span", { style: { fontSize: 12, opacity: 0.6 } }, spec.hint),
    )
  }
  return createElement("label", { style: { display: "grid", gap: 2, marginBlock: 8 } },
    createElement("span", { style: { fontSize: 13 } }, spec.label),
    createElement("input", {
      value: shown,
      disabled: !writable || busy,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
      onBlur: () => void commit(),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") void commit() },
      style: { padding: "4px 8px" },
    }),
    createElement("span", { style: { fontSize: 12, opacity: 0.6 } }, failed ? "The host rejected this value." : spec.hint),
  )
}

export function SandboxConfigForm({ form }: { form: RowConfigForm }) {
  const state = form.state
  if (state === undefined || state.status === "loading") {
    return createElement("p", { style: { opacity: 0.7 } }, "Loading sandbox configuration…")
  }
  if (state.status !== "ready" || state.value === undefined) {
    return createElement("p", { style: { opacity: 0.7 } },
      "This build of the plugin exposes no live-editable fields, or the host settings service is not serving this row.")
  }
  const writable = state.writable === true
  const values = state.value
  return createElement("div", null,
    createElement("p", { style: { fontSize: 13, opacity: 0.7 } },
      "These values apply live to the running plugin; container limits bind when the next container is created."),
    ...FIELDS.map((spec) => createElement(FieldRow, {
      key: spec.path.join("."),
      spec,
      current: readPath(values, spec.path),
      writable,
      onCommit: (path, value) => form.mutate([{ op: "set", path, value }]),
    })),
  )
}
