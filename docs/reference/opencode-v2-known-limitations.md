# OpenCode V2 bridge: known limitations

Behavior the V2 bridge cannot reproduce because OpenCode V2 provides no API for it, or deliberately
does not. Each entry states what is missing, why, and what the user sees. These are not bugs to fix;
they are differences to expect when running OMO on V2.

## Formatter does not run after an edit

`tools/hashline-edit/formatter-trigger.ts` resolves formatters through
`client.config.get({ query: { directory } })`, and the bridge answers that with an empty object, so
`resolveFormatters()` finds nothing and no formatter runs after a hashline edit.

This is not a shortcut in the client shim. V2's plugin context exposes no `config` domain at all
(aisdk, command, credential, event, experimental, integration, mcp, model, permission, plugin,
provider, reference, rpc, session, shell, skill, storage, tool, vcs, websearch, worktree), so a
plugin has no route to the host's merged config and nothing to read `formatter` from.

The V1 pipeline's own formatter guard (`config-handler.ts` snapshots `config.formatter` and restores
it at the end) is therefore inert on V2: the config object the bridge supplies starts empty, so the
guard restores `undefined` over `undefined`. `V1ConfigResult` still declares the key so the V1 path
keeps its contract.

The same missing domain also empties `delegate-task`'s system-default-model lookup and
`runtime-skill-resolver`'s host skill list, both of which already fall back safely.

## Provider catalog is read, not received

V2 never passes a provider map into a plugin, and the V1 config pipeline's phase 1
(`applyProviderConfig`) derives the model context-limit cache, the image-capable model set, and the
Anthropic 1M-context flag from exactly that map. The bridge therefore reads `provider.list()` and
`model.list()` and seeds the map itself before running the pipeline.

Two consequences worth knowing:

- The plugin's `model.list()` domain call returns a wider catalog than the HTTP `model.list`
  endpoint (observed: 635 models and 8 providers versus 307 and 7), because the domain reports
  candidates including models disabled by earlier transforms. Extra entries are harmless, since the
  caches are keyed `providerID/modelID` lookups.
- Models sharing a `modelID` across variant entries collapse to one cache entry, which is correct:
  variants of a model share its context limit.

If either listing call fails, the bridge leaves the provider map unset and the caches stay empty,
which is the pre-seeding behavior rather than a load failure.

## Agent order is relative, not absolute

V2's `Agent.Info` has no `order` field (the schema strips unknown keys), and `Agent.list` does not
sort at all:

```js
list = () => { let T = Ei(_.agents.values()), y = active(_)
               return y ? [y, ...T.filter((E) => E.id !== y.id)] : T }
```

The list is `Map` insertion order with the active agent hoisted to index 0. That makes insertion
order the only ordering lever a plugin has, and `editor.update` cannot move an id already in the Map,
so a plugin can guarantee the *relative* order of the agents it registers but not their absolute
position: V2 registers its built-ins first, and they keep the leading slots.

`installAgentSortShim()` is therefore inert on V2. It exists because OpenCode 1.4.x sorted agents by
name, and V2 does not sort, so the shim's `Array.prototype` patch never activates. It stays installed
for V1 and does no harm; it is not something to fix if agent order looks off.

Consequence: OMO's core agents (`sisyphus -> hephaestus -> prometheus -> atlas`) are written in that
order and are contiguous, but they sit after the host's built-ins. Writing an `order` field, or
biasing names with invisible characters, does not work and is forbidden.

## Skills: code-only skills are pushed, not served

V1 ships two skills that exist only in code, `security-research` and `security-review`, and makes
them visible by starting a small HTTP server and appending its URL into `config.skills.urls`, which
the host fetches. Neither half of that survives V2: the plugin context has no `config` domain, and
`config.skills.urls` is never read.

V2 has a real `skill.add` on `SkillEditor`, so those entries are registered directly instead. The
`path` V2 stores for them is `skill://<name>/SKILL.md`, the same form the host uses for its own
file-less skills, and `content` is the body alone because V2 reports every skill that way.

Two things follow. Skills discovered from disk are unaffected, since V2's own loader finds those.
And `disabled_skills` behaves exactly as it does on V1, because selection goes through the same
`selectRuntimeSecuritySkills` source of truth.

The HTTP source server still starts on V2 even though nothing consumes its URL. It is shared startup
code and harmless, so removing it is a separate cleanup rather than part of the skill fix.

## MCP servers are projected, not resolved

OMO resolves MCP servers in one place, `applyMcpConfig`, which merges four tiers (built-in, Claude
Code `.mcp.json`, the user's own `config.mcp`, plugin components), applies the user's `enabled: false`
markers and deletes the names in `disabled_mcps`. The result lands in `config.mcp`, and the bridge
projects exactly that onto V2.

It used to do its own smaller merge, and that is why `disabled_mcps`, `websearch.provider` and plugin
component MCP servers had no effect on V2: the adapter called `createBuiltinMcps` with an empty
disabled list and no plugin config, and merged only two of the four tiers.

Two consequences are worth knowing. A server the host (or another plugin) already declares always
wins, because the projection skips any name that is already registered - so on a machine whose
`opencode.json` lists the built-in servers, the bridge contributes nothing visible and that is
correct, not a bug. And `oauth` is still sent as `false` for every remote server; whether V2's server
schema accepts an OAuth field could not be established, since `@opencode/schema` is not installed and
the shipped binary carries no readable schema annotation.

## Session todos

`session.todo` returns `[]`. V2 has no session-todo API, so there is nothing to read.

V2's todo surface is the built-in `todowrite` tool, gated behind `experimental.todo`. The list is
derived from `session.context`: find the last part with `type: "tool"`, `name: "todowrite"`,
`state.status: "completed"`, and read `state.input.todos` as `[{ content, status }]`. Consumers that
need the list must derive it that way rather than through a bridge method.

Consequence: OMO features that read the todo list through the V1 API see an empty list. They do not
crash, and they do not fabricate entries.

## Tools shadowed by V2 built-ins

`editor.add()` cannot override a V2 built-in tool, so an OMO tool sharing a built-in's id is never
reached. The 21 built-in ids are:

```
patch, edit, glob, grep, experimental_image_generate, opencode_session_rename,
opencode_session_move, opencode_worktree_create, opencode_worktree_list,
opencode_worktree_remove, opencode_models, opencode_list_mcp_resources,
opencode_read_mcp_resource, question, read, shell, skill, subagent, webfetch, websearch, write
```

The overlap with OMO is `grep`, `glob`, and `skill`. These are **accepted, not renamed**: the V2
built-in wins and OMO's version is inert. Tell them apart by output format, since `grep` is the one
that is easy to confuse:

- OMO: `Found N match(es) in M file(s)`
- V2 built-in: `path:line:text`

`session_list`, `task`, `look_at`, and `background_output` have no built-in counterpart, so they are
unambiguous proof of which side is answering.

## Session status

`session.status` returns `{}`. V2 exposes no per-session status API. Callers that want to know whether
a session is still working must use `session.wait` or derive it from the event stream.

Affected consumers: `tools/delegate-task/{unstable-agent-task,sync-session-poller}.ts`,
`tools/call-omo-agent/completion-poller.ts`, `tools/look-at/{session-poller,look-at-session-runner}.ts`,
`features/tui-sidebar/snapshot-builder.ts`, `features/background-agent/manager.ts`.

## TUI toasts

`tui.showToast` only writes to the log. `ctx.ui.toast.show` exists on the TUI context, not the server
context, and `ctx.event` has no emit, so a server-side plugin cannot push a toast directly. A working
toast needs a server-to-TUI route over `ctx.rpc` (`RpcDomain.register` plus `RpcRegistration.events.emit`).

## Server URL

`PluginInput.serverUrl` is `undefined`. V2 never tells a plugin its HTTP address and binds an arbitrary
port, so any guessed URL is worse than none: an SDK client built from it is refused, the error reads as
"unavailable", and session listing silently degrades to OpenCode's legacy JSON storage that V2 never
writes. Leaving it undefined routes those reads through the V1 client shim instead. The tmux manager
keeps its own `localhost:${OPENCODE_PORT ?? 4096}` fallback; the live-server route reports itself
unavailable, which is the truth.

## Shell runner

`PluginInput.$` is `undefined`. `ctx.shell` carries only `hook`, so V2 gives a plugin no shell runner.
Callers already fall back to `child_process.execFile` when `$` is not callable. It must be a real
`undefined`: a no-op function is callable, so it would be accepted as a runner and then fail later.

## Event publishing

`ctx.event` provides only `subscribe`, so a plugin cannot emit an event. Anything that needs to publish
must route through `ctx.rpc`.

## Server password

V2 reads `OPENCODE_PASSWORD`. The V1 name `OPENCODE_SERVER_PASSWORD` is no longer read, so
`getServerBasicAuthHeader()` no longer finds a credential from the environment alone.
