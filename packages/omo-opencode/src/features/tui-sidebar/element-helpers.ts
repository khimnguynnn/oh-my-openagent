export type ViewNodeKind = "box" | "text"

export type ViewNode = {
  readonly kind: ViewNodeKind
  readonly props: Readonly<Record<string, unknown>>
  readonly text?: string
  readonly children?: readonly ViewNode[]
  /**
   * Stable handle for a node the renderer must be able to find again after mounting. The HUD
   * uses it to rewrite a spinner frame in place instead of re-claiming the slot.
   */
  readonly ref?: string
}

export type ViewNodeOptions = {
  readonly ref?: string
}

export function box(
  props: Readonly<Record<string, unknown>>,
  children: readonly ViewNode[] = [],
  options: ViewNodeOptions = {},
): ViewNode {
  return { kind: "box", props, children, ...(options.ref === undefined ? {} : { ref: options.ref }) }
}

export function text(
  props: Readonly<Record<string, unknown>>,
  value: string,
  options: ViewNodeOptions = {},
): ViewNode {
  return { kind: "text", props, text: value, ...(options.ref === undefined ? {} : { ref: options.ref }) }
}
