import { createElement } from "react"
import { ContainerChip } from "./chip.tsx"
import { SandboxConfigForm, type RowConfigForm } from "./config-form.tsx"
import { MergeRequestButton } from "./merge-button.tsx"
import { PullRequestLink } from "./pr-link.tsx"
import { ReviewButton } from "./review-button.tsx"
import { ResolveConflictsButton } from "./resolve-button.tsx"
import { SubagentStopButton } from "./subagent-stop-button.tsx"

interface SlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  registrant?: string
}

interface SessionHeaderProps {
  sessionId: string
}

interface PluginRowProps {
  view: string
  form?: RowConfigForm
}

export interface ClientContext {
  slots: {
    inject: (key: string, callback: () => (() => void) | void) => () => void
    register: <Props>(registration: SlotRegistration, render: (props: Props) => unknown) => () => void
  }
}

const REGISTRANT = "dsh-docker-sandbox"
const HEADER_SLOT = "conversation.session.header.utilities"

interface HeaderSlot {
  id: string
  order: number
  label: string
  render: (props: SessionHeaderProps) => unknown
}

const HEADER_SLOTS: HeaderSlot[] = [
  {
    id: "container",
    order: 20,
    label: "Sandbox container",
    render: (props) => createElement(ContainerChip, { sessionId: props.sessionId }),
  },
  {
    id: "merge",
    order: 21,
    label: "Merge request",
    render: (props) => createElement(MergeRequestButton, { sessionId: props.sessionId }),
  },
  {
    id: "pr-link",
    order: 22,
    label: "Pull request link",
    render: (props) => createElement(PullRequestLink, { sessionId: props.sessionId }),
  },
  {
    id: "resolve",
    order: 23,
    label: "Resolve conflicts",
    render: (props) => createElement(ResolveConflictsButton, { sessionId: props.sessionId }),
  },
  {
    id: "review",
    order: 24,
    label: "Review changes",
    render: (props) => createElement(ReviewButton, { sessionId: props.sessionId }),
  },
  {
    id: "subagent-stop",
    order: 25,
    label: "Stop subagent",
    render: (props) => createElement(SubagentStopButton, { sessionId: props.sessionId }),
  },
]

export const inject = ["slots"]

export function apply(ctx: ClientContext): void {
  for (const slot of HEADER_SLOTS) {
    ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
      name: HEADER_SLOT,
      id: `${REGISTRANT}:${slot.id}`,
      order: slot.order,
      label: slot.label,
      registrant: REGISTRANT,
    }, slot.render))
  }

  ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
    name: "plugins.row.config",
    key: "dsh-docker-sandbox#docker-sandbox",
    registrant: REGISTRANT,
  }, (props: PluginRowProps) =>
    props.view === "page" && props.form !== undefined
      ? createElement(SandboxConfigForm, { form: props.form })
      : props.view === "summary"
        ? createElement("span", null, "Container image, RAM/CPU limits, and command budgets.")
        : null))
}
