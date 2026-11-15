import * as Plugin from "@opencode/plugin/promise/plugin"
import { setupOpenCodeV2Bridge } from "./bridge/bridge-runner"
import { log } from "../shared/logger"

// OpenCode 2 entry point. It initializes the full OMO Compatibility Bridge layer
// so agents, tools, sessions, and hooks are fully active on OpenCode 2.
export const opencodeV2Server = Plugin.define({
  id: "oh-my-openagent",
  setup: async (context) => {
    try {
      const cleanup = await setupOpenCodeV2Bridge(context)
      return cleanup
    } catch (error) {
      log("[opencode-v2] failed to boot OMO compatibility bridge:", {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },
})
