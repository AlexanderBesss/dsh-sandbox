import { createElement } from "react"
import { ContainerChip } from "./chip.tsx"
import { SandboxConfigForm, type RowConfigForm } from "./config-form.tsx"
import { MergeRequestButton } from "./merge-button.tsx"
import { ReviewButton } from "./review-button.tsx"

interface SlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  registrant?: string
}

export interface ClientContext {
  slots: {
    inject: (key: string, callback: () => (() => void) | void) => () => void
    register: (registration: SlotRegistration, render: (props: any) => unknown) => () => void
  }
}

export const inject = ["slots"]

export function apply(ctx: ClientContext): void {
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: "dsh-docker-sandbox:container",
    order: 20,
    label: "Sandbox container",
    registrant: "dsh-docker-sandbox",
  }, (props) => createElement(ContainerChip, { sessionId: props.sessionId })))

  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: "dsh-docker-sandbox:merge",
    order: 21,
    label: "Merge request",
    registrant: "dsh-docker-sandbox",
  }, (props) => createElement(MergeRequestButton, { sessionId: props.sessionId })))

  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: "dsh-docker-sandbox:review",
    order: 22,
    label: "Review changes",
    registrant: "dsh-docker-sandbox",
  }, (props) => createElement(ReviewButton, { sessionId: props.sessionId })))

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
