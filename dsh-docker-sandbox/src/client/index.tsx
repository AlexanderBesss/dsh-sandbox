/**
 * Client plugin entry: put the container chip in the session header.
 *
 * The seat is `conversation.session.header.utilities`, a session-scoped list
 * slot whose entries get the standard session props (including `sessionId`).
 * Registering a fresh id adds a cell beside the shipped ones; nothing is
 * replaced.
 *
 * @module dsh-docker-sandbox/client
 */

import { createElement } from "react"
import { ContainerChip } from "./chip.tsx"
import { SandboxConfigForm, type RowConfigForm } from "./config-form.tsx"

/** One entry in a list or keyed slot. */
interface SlotRegistration {
  /** Slot this entry belongs to. */
  name: string
  /** Entry key; a fresh id is added beside the shipped entries. */
  id?: string
  /** Keyed-slot address, `<bundle package>#<row id>` for row configuration. */
  key?: string
  /** Position among the entries, ascending. */
  order?: number
  /** Display text where the owner projects one. */
  label?: string | (() => string)
  /** Plugin id, for diagnostics. */
  registrant?: string
}

/** The slice of the client context this plugin uses. */
export interface ClientContext {
  slots: {
    /** Run `callback` for each lifetime of the slot's declaration. */
    inject: (key: string, callback: () => (() => void) | void) => () => void
    /** Register one entry; disposed with the calling fiber. */
    register: (registration: SlotRegistration, render: (props: any) => unknown) => () => void
  }
}

/** Services the client half needs; Cordis rejects `ctx.slots` without this. */
export const inject = ["slots"]

export function apply(ctx: ClientContext): void {
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: "dsh-docker-sandbox:container",
    order: 20,
    label: "Sandbox container",
    registrant: "dsh-docker-sandbox",
  }, (props) => createElement(ContainerChip, { sessionId: props.sessionId })))

  // Give the `docker-sandbox` row a Configure page on the Plugins screen.
  // The key is `<bundle package>#<row id>`; the page hands the component the
  // host-synced volatile-config face, and writes persist to the profile patch.
  ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
    name: "plugins.row.config",
    key: "dsh-docker-sandbox#docker-sandbox",
    registrant: "dsh-docker-sandbox",
  }, (props: { view: string; form?: RowConfigForm }) =>
    props.view === "page" && props.form !== undefined
      ? createElement(SandboxConfigForm, { form: props.form })
      : props.view === "summary"
        ? createElement("span", null, "Container image, RAM/CPU limits, and command budgets.")
        : null))
}
