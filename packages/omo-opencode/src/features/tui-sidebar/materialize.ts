import type { ViewNode } from "./element-helpers"

export type SolidRuntime<Node> = {
  readonly createElement: (tag: string) => Node
  readonly insert: (parent: Node, child: Node | string) => unknown
  readonly setProp: (node: Node, name: string, value: unknown) => unknown
}

export type MaterializedTree<Node> = {
  readonly root: Node
  /** Nodes tagged with a `ref`, so the caller can update them after mounting. */
  readonly refs: ReadonlyMap<string, Node>
}

export function materialize<Node>(nodes: readonly ViewNode[], solid: SolidRuntime<Node>): Node {
  return materializeTree(nodes, solid).root
}

export function materializeTree<Node>(nodes: readonly ViewNode[], solid: SolidRuntime<Node>): MaterializedTree<Node> {
  const root = solid.createElement("box")
  solid.setProp(root, "flexDirection", "column")
  const refs = new Map<string, Node>()
  for (const node of nodes) {
    solid.insert(root, materializeInto(node, solid, refs))
  }
  return { root, refs }
}

export function materializeNode<Node>(node: ViewNode, solid: SolidRuntime<Node>): Node {
  return materializeInto(node, solid, new Map())
}

function materializeInto<Node>(node: ViewNode, solid: SolidRuntime<Node>, refs: Map<string, Node>): Node {
  const element = solid.createElement(node.kind)
  for (const [name, value] of Object.entries(node.props)) {
    solid.setProp(element, name, value)
  }
  if (node.kind === "text") {
    solid.insert(element, node.text ?? "")
  }
  if (node.ref !== undefined) {
    refs.set(node.ref, element)
  }
  for (const child of node.children ?? []) {
    solid.insert(element, materializeInto(child, solid, refs))
  }
  return element
}
