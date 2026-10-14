import { FsError, type FsEdit, type FsTarget } from "@deepseek-ai/dsh-fs"

export function endingsAdapted(text: string, oldText: string, newText: string): [string, string] {
  if (oldText === "" || text.includes(oldText)) return [oldText, newText]
  const fileHasCrlf = text.includes("\r\n")
  const oldHasCrlf = oldText.includes("\r\n")
  if (fileHasCrlf && !oldHasCrlf) {
    const crlfOld = oldText.replace(/\r?\n/g, "\r\n")
    if (text.includes(crlfOld)) return [crlfOld, newText.replace(/\r?\n/g, "\r\n")]
  }
  if (!fileHasCrlf && oldHasCrlf) {
    const lfOld = oldText.replace(/\r\n/g, "\n")
    if (text.includes(lfOld)) return [lfOld, newText.replace(/\r\n/g, "\n")]
  }
  return [oldText, newText]
}

export function applyEdit(text: string, edit: FsEdit, target: FsTarget): { next: string; replacements: number } {
  const rawOld = edit.oldString ?? edit.oldText ?? ""
  const rawNew = edit.newString ?? edit.newText ?? ""
  const [oldText, newText] = endingsAdapted(text, rawOld, rawNew)
  const matches = text.split(oldText).length - 1
  if (matches === 0) {
    throw new FsError(`the text to replace was not found in "${target.displayPath}"`, "FS_AMBIGUOUS_EDIT")
  }
  if (matches > 1 && edit.replaceAll !== true) {
    throw new FsError(
      `"${oldText.slice(0, 60)}" appears ${matches} times in "${target.displayPath}"; give more context or set replaceAll`,
      "FS_AMBIGUOUS_EDIT",
    )
  }
  const next = edit.replaceAll === true
    ? text.split(oldText).join(newText)
    : text.replace(oldText, () => newText)
  return { next, replacements: edit.replaceAll === true ? matches : 1 }
}
