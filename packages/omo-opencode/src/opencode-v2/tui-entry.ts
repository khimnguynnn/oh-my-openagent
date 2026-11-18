import * as Plugin from "@opencode/plugin/tui/plugin"

import { log } from "../shared/logger"
import { startSidebarHud } from "./sidebar-hud"
import type { SidebarSlotHost } from "./sidebar-hud"
import { OPENCODE_V2_NOTICE_DURATION_MS, OPENCODE_V2_NOTICE_MESSAGE, OPENCODE_V2_NOTICE_TITLE } from "./startup-notice"

type NoticeToast = {
  readonly ui: {
    readonly toast: {
      readonly show: (options: {
        readonly title: string
        readonly message: string
        readonly variant: "info" | "warning" | "success" | "error"
        readonly duration: number
      }) => void
    }
  }
}

export function showOpenCodeV2Notice(context: NoticeToast): void {
  context.ui.toast.show({
    title: OPENCODE_V2_NOTICE_TITLE,
    message: OPENCODE_V2_NOTICE_MESSAGE,
    variant: "info",
    duration: OPENCODE_V2_NOTICE_DURATION_MS,
  })
}

function directoryFrom(context: { readonly location?: { readonly directory?: string } }): string {
  return context.location?.directory ?? process.cwd()
}

async function startSidebar(
  context: SidebarSlotHost & { readonly location?: { readonly directory?: string } },
  directory: string,
): Promise<(() => void) | null> {
  if (typeof context.ui?.slot !== "function") {
    return null
  }
  const solid = await import("@opentui/solid").catch(() => null)
  if (!solid) {
    return null
  }
  const hud = await startSidebarHud({
    directory,
    host: context,
    solid,
    onPollError: (error) => log("[tui-sidebar] V2 polling failed", { error }),
  })
  return hud?.dispose ?? null
}

export const opencodeV2Tui = Plugin.define({
  id: "oh-my-openagent:tui",
  setup: async (context) => {
    showOpenCodeV2Notice(context as NoticeToast)

    const directory = directoryFrom(context)
    try {
      const dispose = await startSidebar(context, directory)
      if (dispose) {
        return dispose
      }
    } catch (error) {
      log("[tui-sidebar] V2 sidebar setup failed", { error })
    }
  },
})
