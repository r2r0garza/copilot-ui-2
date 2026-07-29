# Workbench Settings Plan

**Status:** Planned
**Created:** 2026-07-29
**Scope:** Workspace-level workbench settings for default agent selection, DeepAgents prompt composition, and sensitive model-call diagnostics

## Objective

Add a settings pane to the Deep Agents workbench where users can configure:

1. The default project agent for newly created chats, or no default.
2. Whether DeepAgents’ built-in default base system prompt is included alongside the selected `.agent.md` instructions.
3. Whether sensitive full model-call prompt logging is enabled for diagnostics.

Settings are workspace-scoped. They affect future chat creation or future model calls as described below; they do not silently rewrite existing chat history.

## Current Temporary Behavior

Until this phase is implemented, the extension uses:

```ts
const INCLUDE_DEEPAGENTS_DEFAULT_SYSTEM_PROMPT = false;
```

When false, agent construction supplies:

```ts
systemPrompt: {
  prefix: agentDefinition.body,
  base: null,
}
```

When true, the agent body is supplied as a string. DeepAgents treats it as a prefix and appends its built-in base prompt.

The VS Code model adapter wraps the final assembled prompt in:

```xml
<custom_instructions>
...
</custom_instructions>
```

This wrapper is required for Copilot to recognize the project and DeepAgents instructions as custom instructions rather than conversational prompt injection.

The current “Deep Agents Model Calls” output channel records complete assembled prompts
and may automatically reveal itself during normal use. Until the diagnostic setting in
this phase is implemented, that behavior must be treated as temporary and sensitive.

## Locked Decisions

### S-01: Settings are workspace-scoped

Store settings with the workspace’s existing persistence data. Different workspaces may select different default agents and prompt behavior.

No global/user-level synchronization is included in this phase.

### S-02: “No default agent” is a first-class choice

The default-agent setting is nullable:

- A valid agent ID selects that agent automatically for new chats.
- `null` means a new chat starts with an empty agent selector.
- Sending remains unavailable until the user selects an agent.

The settings UI must label this choice clearly as “No default agent.”

### S-03: Existing chats retain their selected agent

Changing the default agent affects only chats created afterward.

It does not:

- Replace the selected agent in existing chats.
- Modify a running or interrupted run.
- Rewrite persisted conversation or checkpoint state.

### S-04: Agent IDs, not display names, are persisted

Persist the filename-derived agent ID from `.github/agents/<id>.agent.md`.

Display names may change without invalidating the setting. If the configured agent ID no longer exists or is no longer user-invocable:

- Treat the effective default as no agent.
- Preserve or clear the stale value according to the repository’s migration/repository policy, but never silently select a different agent.
- Surface the unavailable state in the settings pane.

### S-05: The DeepAgents prompt toggle defaults to off

The persisted boolean is:

```ts
includeDeepAgentsDefaultSystemPrompt: false
```

Off means:

```ts
systemPrompt: {
  prefix: agentDefinition.body,
  base: null,
}
```

On means:

```ts
systemPrompt: agentDefinition.body
```

DeepAgents normalizes the string to a prefix and appends its built-in default base prompt.

### S-06: Prompt changes apply on the next model call

Changing the prompt toggle does not require a new chat. The extension already reconstructs the selected Deep Agent for each user turn, so the next turn reads the latest setting.

An in-flight model call continues with the prompt configuration it started with.

Pending approval recovery must use the prompt setting associated with the resumed run or explicitly document the safe fallback. It must not unknowingly resume a checkpoint under incompatible behavioral instructions.

### S-07: The toggle controls the base prompt, not middleware contracts

Setting `base: null` omits DeepAgents’ general built-in base prompt. DeepAgents middleware may still append instructions required for filesystem, todo, summarization, or tool behavior.

The UI copy and tests must say “DeepAgents default base prompt” rather than promising that every DeepAgents-generated instruction is removed.

### S-08: Tool policy remains independent of prompt settings

The selected agent’s resolved tool policy continues to be enforced in middleware whether the DeepAgents base prompt is enabled or disabled.

Prompt text is guidance. Tool filtering and invocation blocking remain the security boundary.

### S-09: Full model-call logging is an explicit sensitive diagnostic

The persisted boolean is:

```ts
enableSensitiveModelCallLogging: false
```

It defaults to off. While off:

- Complete system prompts, user prompts, and assembled model context are not written to
  the model-call output channel.
- The output channel is not automatically revealed for model calls.
- Sanitized provider/tool registration diagnostics may still be emitted elsewhere under
  their own diagnostic contract.

While on, the output must clearly warn that it may contain proprietary instructions,
user content, and tool context. Enabling this setting does not authorize logging secrets
returned by tools or bypassing any separate redaction policy.

Changes apply to the next model call. An in-flight call retains the logging mode it
started with.

## Proposed Data Model

Add a versioned application migration for workspace settings. Either a typed single-row table or an equivalently constrained settings record is acceptable.

Recommended shape:

### `workspace_settings`

| Column | Purpose |
|---|---|
| `id INTEGER PRIMARY KEY CHECK (id = 1)` | Enforces one settings row per workspace database |
| `default_agent_id TEXT` | Nullable filename-derived project-agent ID |
| `include_deepagents_default_system_prompt INTEGER NOT NULL DEFAULT 0` | Boolean constrained to `0` or `1` |
| `enable_sensitive_model_call_logging INTEGER NOT NULL DEFAULT 0` | Sensitive diagnostic boolean constrained to `0` or `1` |
| `created_at TEXT NOT NULL` | Creation timestamp |
| `updated_at TEXT NOT NULL` | Last settings change |

The repository API should expose a typed value:

```ts
interface WorkbenchSettings {
  defaultAgentId: string | null;
  includeDeepAgentsDefaultSystemPrompt: boolean;
  enableSensitiveModelCallLogging: boolean;
}
```

Reads must return defaults even before an explicit settings save.

## UI Contract

Add a settings entry point to the workbench, using a gear icon or clearly labeled Settings action.

The settings pane contains:

### Default agent

- Dropdown populated from current `user-invocable: true` project agents.
- First option: “No default agent.”
- Optional description explaining that this applies only to new chats.
- Missing configured agents appear as unavailable rather than falling back to another agent.

### DeepAgents default base prompt

- Boolean toggle.
- Default: off.
- Suggested label: “Include DeepAgents default base prompt.”
- Supporting copy: “Adds DeepAgents’ general task-execution instructions after the selected project agent’s instructions. Applies on the next message.”

### Sensitive model-call logging

- Boolean toggle.
- Default: off.
- Suggested label: “Log complete model prompts for diagnostics.”
- Supporting warning: “May expose project instructions, user messages, and model
  context in the Deep Agents Model Calls output channel. Enable only while actively
  diagnosing a problem.”
- Enabling it must require an intentional user action; it must not be coupled to the
  base-prompt toggle or enabled merely by opening the settings pane.

Saving should be immediate or use a clear Save action; the implementation must choose one interaction consistently and communicate success/failure.

The settings controls are disabled while a destructive or incompatible transition would be unsafe. At minimum, changing settings must not mutate an active run’s already-constructed graph.

## Implementation Slices

### Plan 01 — Settings persistence

- Add the workspace-settings migration.
- Add a typed settings repository and expose it through `PersistenceService`.
- Return deterministic defaults when no row exists.
- Constrain both boolean settings to `0` or `1`.
- Add repository and migration integration tests.

### Plan 02 — Runtime settings integration

- Replace `INCLUDE_DEEPAGENTS_DEFAULT_SYSTEM_PROMPT` with the persisted boolean.
- Read the value before constructing each selected Deep Agent.
- Keep prompt assembly in one tested helper.
- Verify false produces `{ prefix, base: null }`.
- Verify true supplies the string form and retains the DeepAgents base prompt.
- Decide and test recovery semantics for interrupted/pending-approval runs.

### Plan 03 — Default agent behavior

- Apply `defaultAgentId` only in `createSession`.
- Preserve the per-chat `selectedAgentId` persistence already implemented.
- Keep existing chats unchanged when settings change.
- Validate the configured ID against the current user-invocable registry.
- Test missing, removed, hidden, renamed-display, and valid agents.

### Plan 04 — Settings pane

- Add the workbench settings entry point and pane.
- Populate the agent dropdown from current project customizations.
- Add “No default agent.”
- Add the DeepAgents base-prompt toggle with accurate copy.
- Add the sensitive model-call logging toggle with an explicit warning.
- Persist changes and refresh effective UI state without reloading the extension.
- Preserve accessibility labels, keyboard operation, VS Code theme tokens, and narrow-panel layout.

### Plan 05 — Sensitive prompt diagnostics

- Replace unconditional model-call prompt logging with the persisted
  `enableSensitiveModelCallLogging` setting.
- Read the setting at each model-call boundary without changing an in-flight call.
- When disabled, do not emit complete prompts and do not automatically reveal the
  “Deep Agents Model Calls” channel.
- When enabled, label the channel output as sensitive and include enough call metadata
  to correlate the diagnostic without logging tool-returned secrets.
- Keep sanitized provider/tool registration diagnostics independent from this setting.
- Add tests proving that full prompt content is absent by default and present only when
  explicitly enabled.

### Plan 06 — Verification

- When sensitive logging is enabled, identify in the model-call diagnostic whether the
  DeepAgents base prompt was included.
- Add automated prompt-composition tests for both toggle states.
- Add UI/state tests for new-chat defaults and existing-chat retention.
- Run the full test suite.
- Complete the manual acceptance matrix below.

## Verification

### Automated

- Migration is idempotent and upgrades existing workspace databases.
- Default settings are `defaultAgentId = null`,
  `includeDeepAgentsDefaultSystemPrompt = false`, and
  `enableSensitiveModelCallLogging = false`.
- Invalid booleans are rejected by the database constraint.
- A valid default agent is selected only for newly created chats.
- No-default mode creates chats with an empty agent selection.
- Existing sessions retain their selected agent after the default changes.
- Removed or hidden agents never become an implicit fallback.
- Prompt toggle off omits the DeepAgents base prompt.
- Prompt toggle on includes the DeepAgents base prompt after `.agent.md` instructions.
- Both modes retain the `<custom_instructions>` transport wrapper.
- Tool-policy integration tests pass in both prompt modes.
- Ordinary model calls do not emit or auto-reveal complete prompt diagnostics.
- Enabling sensitive model-call logging emits clearly labeled complete prompt
  diagnostics beginning with the next model call.

### Manual acceptance

1. Open settings and verify “No default agent” plus all user-invocable project agents are listed.
2. Select no default, create a chat, and verify the agent selector is empty.
3. Select an agent as default, create a new chat, and verify that agent is selected.
4. Return to an older chat and verify its previous agent remains selected.
5. Remove the configured `.agent.md`, reload customizations, and verify no replacement agent is silently selected.
6. With sensitive model-call logging off, send a message and verify no complete prompt
   is emitted and the output channel is not automatically revealed.
7. Enable sensitive model-call logging, send a message, and verify the output is clearly
   labeled as sensitive.
8. Turn the DeepAgents base prompt off, send a message, and verify the diagnostic omits
   the base prompt.
9. Turn it on, send another message in the same chat, and verify the diagnostic includes
   the base prompt after the project-agent instructions.
10. Disable sensitive logging again and verify subsequent complete prompts are absent.
11. Verify tool availability and approval behavior are unchanged in both prompt modes.
12. Restart the Extension Host and verify all three settings persist.

## Success Criteria

- Users can choose a default project agent or no default for new chats.
- Existing chats preserve their own selected agent.
- Users can enable or disable the DeepAgents default base prompt.
- The base-prompt toggle defaults to off.
- Users can explicitly enable sensitive model-call logging, which defaults to off.
- Normal model calls neither emit nor auto-reveal complete prompt diagnostics.
- Prompt ordering remains `.agent.md` instructions before any included DeepAgents base prompt.
- The `<custom_instructions>` wrapper remains intact.
- Settings persist per workspace and are applied at the documented lifecycle boundary.
- Tool enforcement remains independent of prompt text.

## Out of Scope

- Global settings shared across workspaces.
- Settings synchronization across machines.
- Per-agent override of the DeepAgents base-prompt toggle.
- Automatically changing agents in existing chats.
- Model selection defaults.
- MCP server management.
- Browser/web tool configuration.
- Styling beyond the workbench’s existing VS Code-native design language.
