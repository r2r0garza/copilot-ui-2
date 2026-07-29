# Runtime Capabilities Completion Plan

**Status:** Planned
**Created:** 2026-07-29
**Depends on:** Executable `.github` agents/skills slice; settings persistence where explicitly referenced
**Scope:** Complete the remaining agent runtime bridges, delegation, live-turn controls, and production hardening

## Objective

Complete the runtime work that remains after project agents, project skills, and fail-closed tool policies are executable:

1. Make configured MCP server tools callable by selected agents.
2. Bridge VS Code’s integrated web and browser capabilities while preserving their distinct intent.
3. Enable controlled project-agent delegation through DeepAgents.
4. Add stop and mid-turn steering behavior to the composer.
5. Harden diagnostics, failure loops, documentation, and end-to-end verification.

This phase does not duplicate `.planning/002-settings/PLAN.md`. Phase 002 owns the settings pane, default-agent selection, and persisted DeepAgents-base-prompt toggle.

## Delivered Baseline

The current feature slice already provides:

- Discovery and validation of `.github/agents/*.agent.md`.
- Discovery of `.github/skills/*/SKILL.md`.
- MCP configuration discovery with `.vscode/mcp.json` precedence over `.github/mcp.json`.
- Per-chat project-agent selection and persistence.
- New chats starting without an implicit agent.
- Dynamic `.agent.md` instruction loading.
- `<custom_instructions>` transport wrapping for Copilot compatibility.
- A temporary false default for the DeepAgents base prompt.
- Fail-closed alias-to-tool resolution and invocation blocking.
- Dynamic skill catalogs that refresh in existing checkpointed chats.
- Workspace filesystem tools, host command execution, approvals, and durable recovery.

Phase 003 builds on those contracts rather than replacing them.

## Locked Decisions

### R-01: VS Code’s `vscode` capability remains ignored

An agent declaring `tools: [vscode]` receives no Bridgit capability from that entry.

No general-purpose VS Code command bridge is planned. Specific capabilities may be bridged deliberately under their own names and security contracts.

### R-02: Web and browser are distinct capabilities

Both may use VS Code-integrated or Playwright-backed infrastructure, but their intent differs:

- `web`: retrieve information from the web, such as current news, factual lookups, and search/fetch workflows.
- `browser`: interact with pages, forms, application state, and visual or exploratory browser workflows.

The model-facing names, descriptions, approval behavior, and tests must preserve this distinction.

Examples:

- “What are today’s top news stories?” routes to `web`.
- “Who won the 2026 World Cup?” routes to `web`.
- “Open example.com and fill in the form” routes to `browser`.
- “Perform exploratory testing on this site” routes to `browser`.

### R-03: Prefer VS Code-managed tool providers

Research and use VS Code’s registered language-model tools before building duplicate HTTP, search, or browser clients.

If VS Code exposes configured MCP, web, or browser tools through its language-model tool registry, Bridgit should adapt those tools into DeepAgents-compatible tools and invoke them through the supported VS Code API.

Do not depend on undocumented identifiers without runtime discovery and diagnostics.

### R-04: MCP configuration precedence remains unchanged

- Read both `.github/mcp.json` and `.vscode/mcp.json`.
- `.vscode/mcp.json` wins duplicate server names.
- Accept the source-specific `transport` versus `type` spelling at the discovery boundary.
- Preserve source diagnostics.

Runtime activation must skip invalid or unsupported definitions without hiding valid servers.

### R-05: Tool policy is the enforcement boundary

Provider discovery does not grant access.

An MCP, web, browser, delegation, filesystem, or command tool reaches the model only when the selected agent’s resolved policy allows its canonical name. Forced calls remain blocked in middleware.

`tools` omitted and `tools: []` continue to mean no tools.

### R-06: Delegation is explicit and allowlisted

The DeepAgents `task` tool is exposed only when the selected agent declares the `agent` capability.

When the parent `.agent.md` has an `agents:` list, it restricts which project agents may be invoked. When omitted, the implementation must choose and document a conservative default before enabling delegation.

Additional rules:

- `disable-model-invocation: true` excludes an agent from model-selected delegation.
- `user-invocable: false` affects the workbench selector, not necessarily delegation; `disable-model-invocation` is the delegation-specific gate.
- A delegated agent receives its own Markdown body, tool policy, and applicable project skills.
- A child never inherits broader tools from its parent.
- Detect direct and indirect delegation cycles.
- Bound delegation depth and surface a clear failure instead of recursing indefinitely.

### R-07: Stop and steer are different actions

Composer states:

| Runtime state | Textbox state | Primary control |
|---|---|---|
| Idle | Empty | Right-facing arrow, disabled |
| Idle | Has text | Right-facing arrow, enabled; sends a new turn |
| Running | Empty | Stop button; cancels the active run |
| Running | Has text | Up-facing arrow; sends a steering message |

Enter follows the same state-dependent action as clicking the primary control. Shift+Enter inserts a newline.

### R-08: Steering respects message/tool protocol boundaries

A steering message must never be inserted between an assistant tool call and its corresponding `ToolMessage`.

Queue steering input in the host and inject it at the next safe graph/model boundary:

- After outstanding tool results have been recorded.
- Before the next model call.
- Without discarding completed tool work.
- Without silently converting steering into cancellation.

Multiple steering messages require a deterministic policy such as FIFO queueing or explicit coalescing. The selected policy must be visible in tests.

### R-09: Stop uses the existing cancellation path

Stopping aborts the active model/tool loop through the existing `AbortController`, resolves pending approvals safely, records cancellation durably, and returns the composer to idle.

Cancellation does not roll back already completed side effects.

### R-10: Diagnostics must be deliberate and safe

The current “Deep Agents Model Calls” channel records complete prompts and may contain proprietary instructions, user content, and tool context.

Before this phase is complete:

- Make full prompt logging explicitly opt-in or development-only.
- Do not automatically reveal the channel on every model call in normal use.
- Clearly label sensitive diagnostic output.
- Never log secrets returned by tools without an explicit diagnostic contract and redaction policy.

### R-11: Repeated tool failures terminate coherently

Prevent unproductive loops such as repeatedly reading a nonexistent file when the selected agent lacks `write_file`.

The runtime should:

- Give the model an accurate view of available tools.
- Preserve useful tool errors.
- Detect repeated identical failures within a run.
- Stop or redirect after a bounded threshold with a clear capability/error explanation.
- Avoid converting a capability limitation into dozens of replay rows.

## Implementation Slices

### Plan 01 — Provider and tool-registry research

- Inspect the current VS Code Language Model API for registered tool discovery and invocation.
- Determine how built-in web/browser tools and configured MCP tools are identified.
- Record stable identifiers, metadata, cancellation behavior, result formats, and availability constraints.
- Verify behavior when a provider is absent, disabled, or requires consent.
- Produce an adapter contract before implementation.

Acceptance:

- No production bridge depends on guessed tool names.
- Unsupported provider state has a deterministic diagnostic and fallback.

### Plan 02 — VS Code tool adapter

- Implement a DeepAgents-compatible adapter around supported VS Code language-model tools.
- Preserve JSON schemas and descriptions where possible.
- Translate invocation results into LangChain `ToolMessage` content.
- Propagate cancellation.
- Normalize failures without losing provider error details.
- Add unit tests with mocked registered tools.

Acceptance:

- A registered read-only fixture tool is visible, callable, cancellable, and policy-filtered.
- A forced forbidden call is blocked before provider invocation.

### Plan 03 — MCP runtime activation

- Match discovered MCP server definitions to VS Code-managed registered tools.
- Canonicalize names as `<server>/<tool>`.
- Support server wildcards such as `playwright-mcp/*`.
- Keep duplicate-source precedence from discovery.
- Skip invalid and unsupported server definitions while retaining diagnostics.
- Add a controlled fixture server integration test.

Acceptance:

- An allowed MCP tool completes through the DeepAgents loop.
- An unlisted MCP tool is absent and cannot be forced.
- Invalid servers do not prevent valid servers from loading.

### Plan 04 — Web and browser bridges

- Discover and adapt VS Code’s integrated web and browser tools.
- Expose canonical `web/...` and `browser/...` names.
- Write model-facing descriptions that encode the locked intent distinction.
- Decide which browser actions require explicit approval.
- Preserve browser session state only within a documented lifecycle.
- Add intent-routing and invocation tests.

Acceptance:

- Information retrieval does not accidentally launch an interactive browser workflow.
- Form interaction does not route through a fetch-only tool.
- Missing integrated-browser support produces a clear limitation.

### Plan 05 — Project-agent delegation

- Convert eligible project agents into DeepAgents subagent definitions.
- Pass each child its Markdown instructions, resolved tools, and dynamically refreshed skills.
- Enforce the parent `agents:` allowlist and child `disable-model-invocation`.
- Expose `task` only for the `agent` capability.
- Add depth, cycle, cancellation, and approval propagation contracts.
- Persist enough delegation activity for inert replay.

Acceptance:

- A permitted parent delegates to an allowed child.
- A forbidden or hidden-from-model child is unavailable.
- Child tools never exceed the child policy.
- Cycles and excessive depth fail clearly.

### Plan 06 — Composer stop and steer states

- Replace the text Send button with the agreed right-arrow, stop, and up-arrow states.
- Disable idle send while the textbox is empty.
- Keep the textbox editable while a run is active.
- Add accessible labels/tooltips for every icon state.
- Route Enter and click through one state machine.
- Preserve draft text across non-send UI updates.

Acceptance:

- All four composer states match R-07.
- Keyboard and pointer behavior are equivalent.
- Screen readers receive action-specific labels.

### Plan 07 — Safe steering queue

- Add a host-owned steering queue per active run.
- Define the safe injection boundary in the DeepAgents/LangGraph loop.
- Persist steering messages as conversation events in causal order.
- Handle steering during model thinking, tool execution, and approval waiting.
- Define behavior for multiple queued messages, cancellation, failure, and restart.
- Ensure restored replay distinguishes ordinary user turns from steering messages when useful.

Acceptance:

- Steering affects the next model decision without breaking tool-call/result pairing.
- Completed tool effects remain completed.
- Stop remains available when no steering text is present.
- Restart behavior is deterministic and documented.

### Plan 08 — Failure-loop and diagnostic hardening

- Add bounded repeated-tool-failure detection.
- Improve capability-limitation feedback.
- Make full model-call logging opt-in/development-only.
- Add structured diagnostics for provider/tool registration.
- Review prompt and tool logs for sensitive-data exposure.
- Remove temporary experiment flags that Phase 002 replaces with settings.

Acceptance:

- Repeated identical failures terminate within the documented bound.
- Normal users do not emit or auto-open full prompt logs.
- Diagnostic mode provides enough evidence to debug prompt and tool exposure.

### Plan 09 — Documentation and end-to-end verification

- Update the stale README claims about memory-only sessions and universally enabled tools.
- Document `.github` agent, skill, and MCP support.
- Document fail-closed `tools` semantics and ignored `vscode`.
- Document web versus browser intent.
- Document delegation, stop, steering, and prompt settings after implementation.
- Run the full automated suite and manual acceptance matrix.

## Verification Matrix

### Automated

- Provider adapter schema, result, error, and cancellation tests.
- MCP discovery-to-runtime integration with allow/deny enforcement.
- Web/browser intent and availability tests.
- Delegation allowlist, policy isolation, cycle, and depth tests.
- Composer state-machine tests.
- Steering causal-order and tool-pairing tests.
- Repeated-failure loop bound.
- Prompt wrapper and prompt-setting regression tests.
- Persistence/replay tests for delegation and steering events.
- Full existing persistence, approval, recovery, and tool-ledger suite.

### Manual

1. Invoke one allowed MCP tool and verify visible activity/results.
2. Confirm a forbidden MCP tool never appears to the model.
3. Ask a current-information question and verify `web` behavior.
4. Ask for interactive page work and verify `browser` behavior.
5. Delegate from an allowed parent to an allowed child.
6. Verify a disallowed child cannot be selected by the model.
7. Start a long response and stop it with the stop control.
8. Start another long response, type while it runs, and send a steering message with the up arrow.
9. Steer during tool activity and verify no orphaned tool result appears.
10. Trigger a repeated missing-file/capability failure and verify bounded termination.
11. Restart the Extension Host and verify replay/recovery remain coherent.
12. Verify full prompt logs are absent unless diagnostic mode is enabled.

## Success Criteria

- Configured MCP tools are callable only under the selected agent’s policy.
- Web and browser behaviors are distinct and use supported VS Code providers.
- Project-agent delegation is allowlisted, bounded, and policy-isolated.
- Stop reliably cancels active work without implying rollback.
- Steering reaches the next safe model boundary without corrupting tool protocol state.
- Repeated tool failures do not spiral indefinitely.
- Sensitive full-prompt logging is not enabled by default.
- Documentation matches shipped behavior.
- Existing persistence, approval, recovery, agent, skill, and tool-policy tests remain green.

## Out of Scope

- The Phase 001 future-goal scheduler and autonomous background continuation.
- The Phase 002 settings pane and settings persistence implementation.
- A general-purpose bridge for the `vscode` tool capability.
- Custom browser engines when VS Code’s integrated provider is sufficient.
- Cloud synchronization or execution while VS Code is closed.
- Silent retries of uncertain side effects.
