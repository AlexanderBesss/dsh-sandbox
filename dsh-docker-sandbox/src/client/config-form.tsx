/**
 * The Plugins page configuration form for the `docker-sandbox` row.
 *
 * The page hands the registered component a `form` face: `state` is the
 * host-synced snapshot of the row's volatile Config fields (the host derives
 * it from the exported `Config` schema), and `mutate(ops)` writes path-
 * addressed edits back through `remote.settings`, which persists them to the
 * profile patch and hot-commits them into the running plugin.
 *
 * The field list mirrors the `volatile()` leaves of `src/config.ts`; ordinary
 * (restart-required) fields are deliberately absent because the host would
 * reject writes to them.
 *
 * @module dsh-docker-sandbox/client/config-form
 */

import { createElement, useState } from "react"

/** One host-synced form snapshot for the row's namespace. */
interface FormState {
  status: "loading" | "ready" | "unavailable"
  value?: Record<string, unknown>
  writable?: boolean
  revision?: number
}

/** The face the Plugins page passes to a row's configuration slot. */
export interface RowConfigForm {
  state?: FormState
  mutate: (ops: unknown[], expectedRevision?: number) => Promise<boolean>
}

/** One editable volatile leaf of the sandbox Config schema. */
interface FieldSpec {
  path: string[]
  label: string
  kind: "string" | "number"
  hint: string
}

const FIELDS: FieldSpec[] = [
  { path: ["image"], label: "Container image", kind: "string", hint: "Applied to the next container the chat provisions." },
  { path: ["resourceLimits", "memory"], label: "Memory limit", kind: "string", hint: "Docker size syntax, e.g. 4g or 512m. Empty leaves it unbounded." },
  { path: ["resourceLimits", "memorySwap"], label: "Memory + swap cap", kind: "string", hint: "Set equal to the memory limit to forbid swap spillover (hard cap)." },
  { path: ["resourceLimits", "cpu"], label: "CPU cores", kind: "string", hint: "Docker --cpus value, e.g. 2. Empty leaves it unbounded." },
  { path: ["timeoutMs"], label: "Default command timeout (ms)", kind: "number", hint: "Applies immediately to new commands." },
  { path: ["maxTimeoutMs"], label: "Maximum command timeout (ms)", kind: "number", hint: "Caller requests above this are clamped." },
  { path: ["maxOutputBytes"], label: "Max output bytes per stream", kind: "number", hint: "Beyond this the shell tools report truncated output." },
  { path: ["graceMs"], label: "Terminate grace (ms)", kind: "number", hint: "SIGTERM to SIGKILL escalation window." },
  { path: ["idleTtlMs"], label: "Idle container TTL (ms)", kind: "number", hint: "Containers unused this long are deleted by the GC loop." },
]

function readPath(value: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = value
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/** One labeled input that commits on blur or Enter. */
function FieldRow({ spec, current, writable, onCommit }: {
  spec: FieldSpec
  current: unknown
  writable: boolean
  onCommit: (path: string[], value: unknown) => Promise<boolean>
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
  return createElement("label", { style: { display: "grid", gap: 2, marginBlock: 8 } },
    createElement("span", { style: { fontSize: 13 } }, spec.label),
    createElement("input", {
      value: shown,
      disabled: !writable || busy,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
      onBlur: () => void commit(),
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") void commit() },
      style: { padding: "4px 8px" },
    }),
    createElement("span", { style: { fontSize: 12, opacity: 0.6 } }, failed ? "The host rejected this value." : spec.hint),
  )
}

/** The row's configuration page body. */
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
  return createElement("div", null,
    createElement("p", { style: { fontSize: 13, opacity: 0.7 } },
      "These values apply live to the running plugin; container limits bind when the next container is created."),
    ...FIELDS.map((spec) => createElement(FieldRow, {
      key: spec.path.join("."),
      spec,
      current: readPath(state.value as Record<string, unknown>, spec.path),
      writable,
      onCommit: (path, value) => form.mutate([{ op: "set", path, value }]),
    })),
  )
}
