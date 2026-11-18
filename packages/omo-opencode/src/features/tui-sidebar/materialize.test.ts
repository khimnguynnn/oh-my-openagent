import { describe, expect, it } from "bun:test"

import { box, text } from "./element-helpers"
import type { ViewNode } from "./element-helpers"
import { materialize } from "./materialize"

type FakeNode = {
  readonly tag: string
  readonly props: Array<[string, unknown]>
  readonly children: Array<FakeNode | string>
}

function fakeSolid(): {
  readonly roots: FakeNode[]
  readonly solid: {
    createElement: (tag: string) => FakeNode
    insert: (parent: FakeNode, child: FakeNode | string) => void
    setProp: (node: FakeNode, name: string, value: unknown) => void
  }
} {
  const roots: FakeNode[] = []
  return {
    roots,
    solid: {
      createElement: (tag) => {
        const node: FakeNode = { tag, props: [], children: [] }
        roots.push(node)
        return node
      },
      insert: (parent, child) => {
        parent.children.push(child)
      },
      setProp: (node, name, value) => {
        node.props.push([name, value])
      },
    },
  }
}

describe("materialize", () => {
  it("#given a nested ViewNode tree #when materializing #then every node becomes an element with its props and children", () => {
    // given
    const nodes: ViewNode[] = [
      box({ id: "outer", gap: 1 }, [
        text({ fg: "#fff" }, "Agents"),
        box({ id: "inner" }, [text({ fg: "#888" }, "oracle running")]),
      ]),
    ]
    const { solid } = fakeSolid()

    // when
    const root = materialize(nodes, solid)

    // then
    expect(root.tag).toBe("box")
    expect(root.props).toEqual([["flexDirection", "column"]])
    expect(root.children).toHaveLength(1)

    const outer = root.children[0] as FakeNode
    expect(outer.tag).toBe("box")
    expect(outer.props).toEqual([
      ["id", "outer"],
      ["gap", 1],
    ])

    const [heading, inner] = outer.children as FakeNode[]
    expect(heading?.tag).toBe("text")
    expect(heading?.props).toEqual([["fg", "#fff"]])
    expect(heading?.children).toEqual(["Agents"])

    const innerText = (inner as FakeNode).children[0] as FakeNode
    expect(innerText.children).toEqual(["oracle running"])
  })

  it("#given an empty node list #when materializing #then only the column root is created", () => {
    // given
    const { solid, roots } = fakeSolid()

    // when
    const root = materialize([], solid)

    // then
    expect(roots).toEqual([root])
    expect(root.children).toEqual([])
  })

  it("#given a text node with no text value #when materializing #then it inserts an empty string rather than skipping the child", () => {
    // given
    const nodes: ViewNode[] = [{ kind: "text", props: {} }]
    const { solid } = fakeSolid()

    // when
    const root = materialize(nodes, solid)

    // then
    const only = root.children[0] as FakeNode
    expect(only.children).toEqual([""])
  })
})
