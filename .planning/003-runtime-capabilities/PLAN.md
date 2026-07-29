# Runtime Capabilities Completion Plan

**Status:** Complete — Plans 01–09 verified
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

### R-10: Runtime diagnostics must be deliberate and safe

The current “Deep Agents Model Calls” channel records complete prompts and may contain proprietary instructions, user content, and tool context.

Phase 002 owns the persisted setting, UI, and runtime gate that make complete model-call
prompt logging explicitly opt-in. This phase owns the remaining runtime diagnostic
surface:

- Provider and registered-tool diagnostics must be structured and useful without
  including complete prompts.
- Diagnostic output must not include secrets returned by tools without an explicit
  diagnostic contract and redaction policy.
- Any temporary full-prompt logging behavior remains documented as sensitive until the
  Phase 002 setting replaces it.

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

#### Plan 01 research record — 2026-07-29

The supported VS Code 1.105 Language Model Tool API provides:

- `vscode.lm.tools`: a snapshot of all registered tools.
- `LanguageModelToolInformation`: `name`, `description`, `inputSchema`, and `tags`.
- `vscode.lm.invokeTool(name, options, token)`: schema-validated invocation by registered name.
- `LanguageModelToolInvocationOptions`: `input`, an optional tokenization budget, and a chat-participant invocation token.
- `LanguageModelToolResult`: an ordered content array containing text, prompt-TSX, or future/unknown parts.
- Cancellation through the `CancellationToken` passed to `invokeTool`.

Public API references:

- <https://code.visualstudio.com/api/references/vscode-api#lm>
- <https://code.visualstudio.com/api/extension-guides/ai/tools>

The public metadata does **not** expose an owning extension, provider kind, MCP server
name, source configuration, or a stable web/browser category. It also does not expose
a tool-registry change event. Therefore:

- Provider names, prefixes, tags, and descriptions are evidence to inspect, not a
  supported identity contract by themselves.
- Bridgit must take a fresh `vscode.lm.tools` snapshot when constructing a run instead
  of retaining a process-lifetime registry cache.
- Plan 03 cannot map a configured MCP server to registered tools from public metadata
  alone unless the live provider exposes an additional stable convention that is
  captured and verified.
- Plan 04 cannot classify integrated web/browser tools from guessed names or fuzzy
  description matching.

Before Plan 02 implementation, add a safe diagnostic inventory that records, for each
registered tool:

- exact provider name;
- description;
- tags;
- input schema;
- whether the exact provider name is present in the global `vscode.lm.tools` snapshot;
- the VS Code and relevant provider-extension versions used for the observation.

Do not invoke tools merely to inventory them. Invocation availability, consent, result
shape, and cancellation require controlled fixture probes plus explicit manual probes
for built-in providers.

#### Adapter contract

Each adapted tool uses two identities:

- `providerName`: the exact opaque name accepted by `vscode.lm.invokeTool` and,
  when it satisfies the chat model's tool-name grammar, exposed to the model;
- `canonicalName`: the policy-facing Bridgit identity used by agent configuration,
  diagnostics, and authorization.

The registry entry retains both identities and immutable copies of the provider
description, tags, and JSON input schema. Policy filtering is applied to
`canonicalName` before model exposure and again before provider invocation. When
`providerName` and `canonicalName` differ, middleware translates the model-facing
provider name back to the canonical identity at both enforcement points.

Invocation follows this boundary:

1. Validate that the current registry still contains `providerName`.
2. Invoke `vscode.lm.invokeTool(providerName, { input, toolInvocationToken:
   undefined }, cancellationToken)`. Bridgit uses a custom webview rather than a VS
   Code chat-participant request, so it has no valid chat-participant invocation
   token. Provider confirmations may still appear through VS Code.
3. Preserve ordered text parts. Normalize prompt-TSX and unknown parts through an
   explicit, tested serializer; never silently coerce them to `"[object Object]"`.
4. Return normalized content to LangChain as the matching `ToolMessage`.
5. Classify cancellation, provider disappearance, documented permission denial, and
   provider failure distinctly. Preserve the original provider error as the cause when
   VS Code does not expose a stable error code, including schema-validation or
   confirmation failures. The adapter itself does not retry.

Host cancellation must bridge the active run's `AbortSignal` into a disposable VS Code
`CancellationTokenSource`. Cancellation propagates to `invokeTool`, but already
completed external effects are not rolled back.

Provider resolution is fail-closed:

- An adapter is registered only when a deterministic resolver has proven both
  identities from runtime evidence.
- Zero matches produce an unavailable-provider diagnostic.
- Multiple matches produce an ambiguous-provider diagnostic.
- Provider disappearance between discovery and invocation produces a deterministic
  unavailable error and triggers a fresh inventory on the next run.

#### Remaining Plan 01 exit evidence

- [x] Public discovery, metadata, invocation, result, and cancellation contracts
  documented.
- [x] Unsupported identity fields and registry-refresh limitations documented.
- [x] DeepAgents adapter boundary documented.
- [x] Safe registered-tool inventory and exact contribution-manifest correlation
  implemented with automated coverage.
- [x] Registered-tool inventory captured in an Extension Host.
- [x] Controlled fixture tool proves global invocation, result normalization,
  cancellation, and failure behavior.
- [x] Integrated MCP, web, and browser observations either establish stable resolvers
  or record that the corresponding slice requires a documented fallback/revision.

Manual checkpoint:

1. Launch the extension in an Extension Development Host.
2. Run `Deep Agents: Inspect Registered Tools` from the Command Palette.
3. Confirm the `Deep Agents Runtime Tools` output channel opens.
4. Confirm the header says no tools were invoked and records the VS Code version and
   capture time.
5. Confirm every registered entry includes its exact name, description, tags, input
   schema, and any exact contribution-manifest match.
6. Save the output as Plan 01 evidence after reviewing it for unexpected sensitive
   metadata.

#### Extension Host evidence — 2026-07-29

Environment:

- VS Code `1.130.0`
- GitHub Copilot Chat `0.58.0`
- 72 registered language-model tools
- 38 tools correlated to two extension contribution manifests
- 34 registered tools unattributed by contribution-manifest correlation

The diagnostic did not invoke any tool and exposed no tool results or credentials.

Browser observations:

- The registry contains a coherent integrated-browser family:
  `open_browser_page`, `read_page`, `navigate_page`, `click_element`,
  `type_in_page`, `hover_element`, `drag_element`, `handle_dialog`,
  `screenshot_page`, and `run_playwright_code`.
- The family shares a `pageId` session contract. `open_browser_page` creates or shares
  a page; the other tools act on that page.
- These tools are unattributed and have no tags. Their names alone are not a supported
  provider identity.
- Plan 04 may implement a versioned structural resolver that requires the exact tool
  names plus compatible schemas and the shared `pageId` contract. Any missing,
  duplicate, or incompatible member makes the integrated-browser provider
  unavailable. The resolver must never select tools through fuzzy description
  matching.

Web observations:

- `copilot_fetchWebPage` is exactly correlated to
  `GitHub.copilot-chat@0.58.0`.
- Its contract accepts explicit `urls` plus a `query`, so it is suitable for canonical
  `web/fetch`.
- No general web-search/current-information discovery tool was present. Plan 04 must
  expose fetch only when this is the complete provider surface and report
  `web/search` as unavailable. The plan must not imply that fetch alone can answer
  open-ended current-news lookup requests.

MCP observations:

- No registered tool in this capture could be deterministically correlated to a
  configured MCP server.
- No MCP server was configured for this manual checkpoint, so absence here does not
  prove that VS Code-managed MCP tools are unavailable.
- Plan 03 must start with the controlled fixture server, capture its registry delta,
  and derive a server/tool resolver only from that evidence. If no stable correlation
  exists, Plan 03 must stop for a fallback/revision decision rather than parsing
  opaque names heuristically.

Plan 01 conclusion:

- The public invocation adapter boundary is viable.
- `web/fetch` has a deterministic provider candidate in this observed environment.
- Integrated browser support has a deterministic fail-closed structural probe, not a
  globally stable provider identifier.
- MCP activation and general web search remain intentionally unresolved until their
  respective implementation slices produce evidence.

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

#### Plan 02 implementation evidence — 2026-07-29

- Added a generic adapter that keeps the policy-facing `canonicalName` separate from
  the opaque VS Code `providerName`.
- The adapter copies the registered provider's description and JSON input schema into
  the LangChain tool definition.
- LangChain's active `AbortSignal` propagates through the Plan 01 invocation boundary
  into a disposable VS Code `CancellationTokenSource`.
- Ordered VS Code text, prompt-TSX, and future/unknown result parts are normalized into
  deterministic LangChain tool-message content without object string coercion.
- Both identities are retained as tool metadata for diagnostics and policy
  translation.
- Adapter construction and invocation fail closed when the exact provider is absent.
- Existing policy middleware filters canonical tools before model exposure and blocks
  forced forbidden calls before `vscode.lm.invokeTool`.
- A controlled DeepAgents integration fixture verifies schema/description exposure,
  canonical-to-provider invocation, tool-call/result pairing, cancellation, and
  forced-call blocking.
- TypeScript check, production bundle, and the full automated suite pass.

No unrestricted manual invocation command was added. Until Plan 03 or Plan 04 proves a
deterministic resolver, exposing a command that invokes arbitrary registered tools
would bypass the intended policy and approval boundaries. The next manual adapter
checkpoint belongs to the first safely resolved MCP or web/browser tool.

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

#### Plan 03 fixture checkpoint

A controlled local stdio server named `bridgit-runtime-fixture` provides one
deterministic, read-only, idempotent tool named `read_fixture`.

Automated evidence:

- The project discovery layer reads its `.vscode/mcp.json` definition.
- The official MCP TypeScript SDK starts over stdio.
- A protocol client lists the exact tool schema and read-only annotations.
- Calling `read_fixture` with `{ "key": "alpha" }` returns
  `bridgit-runtime-fixture:alpha`.
- TypeScript check, production bundle, and the full automated suite pass.

Manual registry checkpoint:

1. Launch the Extension Development Host.
2. Start and trust `bridgit-runtime-fixture` using `MCP: List Servers`.
3. If necessary, run `MCP: Reset Cached Tools` and restart the fixture server.
4. Run `Deep Agents: Inspect Registered Tools`.
5. Capture the complete registered entry corresponding to `read_fixture`, including
   exact name, description, tags, schema, and contribution attribution.
6. Do not implement a production MCP name parser until this evidence is recorded.

#### Plan 03 registry evidence and implementation — 2026-07-29

The local fixture initially failed to start in the Extension Host while the bare
`node` command worked in the development terminal. Its workspace MCP definition now
uses the environment-relative `${env:HOME}/.local/bin/node` executable so it does not
depend on the Extension Host's reduced process `PATH`.

A trusted Playwright MCP server supplied the required registry evidence:

- Starting server `playwright` increased the registry from 72 to 96 tools.
- The 24-tool delta used the exact provider-name form
  `mcp_playwright_<tool-name>`.
- Examples include `mcp_playwright_browser_click`,
  `mcp_playwright_browser_snapshot`, and
  `mcp_playwright_browser_take_screenshot`.
- All 24 entries were unattributed by extension contribution manifests.
- The registered schemas and descriptions matched their MCP tool contracts.

The initial production resolver used the observed short-server form:

`mcp_<configured-server-name>_<tool-name>` →
`<configured-server-name>/<tool-name>`

The long-named fixture then registered as
`mcp_bridgit-runti_read_fixture`, not with its full server name. Inspection of
the installed VS Code `1.130.0` workbench source confirmed the provider-object naming
algorithm:

1. Lowercase the configured server name.
2. Replace runs outside `[a-z0-9_.-]` with `_`.
3. Truncate the normalized server component to 13 characters.
4. Produce the 18-character first object prefix `mcp_<component>_`.
5. When normalized prefixes collide, allocate a numbered suffix and shorten the
   component further to retain the 18-character object-prefix limit.

The resolver implements the deterministic first object prefix and also requires the
registered tool's observed `mcp` tag. If multiple configured servers normalize to the
same first prefix, all colliding servers are skipped. Numbered collision prefixes are
not reverse-mapped because the public registry does not expose which server received
which allocation index.

Resolver constraints:

- Only valid, discovered project MCP server definitions participate.
- Registered providers with no configured server match are ignored.
- Providers matching more than one configured server prefix, or configured servers
  sharing one normalized/truncated prefix, are ambiguous and skipped.
- An empty tool-name suffix is invalid.
- A valid configured server with no registered matches remains unavailable and emits
  a diagnostic explaining how to start, trust, and refresh it.
- Invalid or unsupported server definitions emit diagnostics without preventing valid
  servers from resolving.
- A fresh `vscode.lm.tools` snapshot is used for every agent run.

Runtime activation:

- Resolved provider tools are converted through the Plan 02 adapter.
- The project agent policy filters canonical names before adapters are added to
  DeepAgents, while the model receives the provider's chat-safe name.
- Middleware translates model-facing provider names back to canonical identities and
  blocks forced forbidden calls before provider invocation.
- `Deep Agents: Inspect Project Customizations` now reports canonical-to-provider MCP
  runtime mappings and availability diagnostics.

Automated integration verifies exact-prefix resolution, ambiguous-prefix rejection,
invalid-server isolation, wildcard/granular policy filtering, allowed invocation
through DeepAgents, tool-result pairing, and forced-call blocking. TypeScript, the
production bundle, and the full suite pass.

The first manual DeepAgents invocation exposed one additional transport constraint:
`bridgit-runtime-fixture/read_fixture` was passed to the chat model as a tool name,
and VS Code rejected it because `/` is outside the supported alphanumeric, hyphen,
and underscore grammar. The adapter now exposes
`mcp_bridgit-runti_read_fixture` to the model while retaining
`bridgit-runtime-fixture/read_fixture` as the canonical policy identity. An explicit
alias map is applied during both model-tool filtering and forced-call authorization,
so this compatibility boundary does not weaken the allowlist. Automated coverage
reproduces the safe-name invocation and verifies that a forced forbidden provider
alias is blocked before `vscode.lm.invokeTool`.

Final manual checkpoint:

1. Restart the Extension Development Host with the latest extension build.
2. Start and trust `bridgit-runtime-fixture`.
3. Run `Deep Agents: Inspect Registered Tools` and confirm its provider is registered.
4. Run `Deep Agents: Inspect Project Customizations` and confirm a mapping from
   `bridgit-runtime-fixture/read_fixture` to
   `mcp_bridgit-runti_read_fixture`.
5. Open the Deep Agents workbench and select `MCP Fixture Verifier`.
6. Ask: `Use read_fixture with key alpha and report the exact result.`
7. Confirm the visible tool result is `bridgit-runtime-fixture:alpha`.

Manual acceptance evidence — 2026-07-29:

- The Extension Development Host exposed the fixture through the selected
  `MCP Fixture Verifier` agent.
- The agent invoked the model-facing provider
  `mcp_bridgit-runti_read_fixture`.
- Canonical policy authorization remained
  `bridgit-runtime-fixture/read_fixture`.
- The visible end-to-end result was exactly
  `bridgit-runtime-fixture:alpha`.
- Plan 03 acceptance is complete.

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

#### Plan 04 implementation evidence — 2026-07-29

Provider resolution:

- Canonical `web/fetch` resolves only to the exact
  `copilot_fetchWebPage` provider when its schema requires explicit `urls` and a
  `query`, and the tool is correlated to the `GitHub.copilot-chat` contribution
  manifest.
- The model-facing web description explicitly states that fetch is not general web
  search and must not be used for open-ended current-information discovery or
  interactive form work.
- `web/search` remains unavailable and produces a deterministic diagnostic rather
  than silently degrading to fetch.
- The integrated browser resolves as one fail-closed family. All ten exact providers
  must be present once with compatible schemas:
  `open_browser_page`, `read_page`, `navigate_page`, `click_element`,
  `type_in_page`, `hover_element`, `drag_element`, `handle_dialog`,
  `screenshot_page`, and `run_playwright_code`.
- Except for `open_browser_page`, every browser member must implement the shared
  required `pageId` contract. Capability-specific schema fields are also validated.
  A missing, duplicate, or incompatible member disables the entire browser family
  with a clear diagnostic; no fuzzy names or descriptions are used.

Canonical browser mappings:

- `browser/open` → `open_browser_page`
- `browser/read` → `read_page`
- `browser/navigate` → `navigate_page`
- `browser/click` → `click_element`
- `browser/type` → `type_in_page`
- `browser/hover` → `hover_element`
- `browser/drag` → `drag_element`
- `browser/dialog` → `handle_dialog`
- `browser/screenshot` → `screenshot_page`
- `browser/run-code` → `run_playwright_code`

Runtime and safety:

- Runtime tools are freshly resolved for every agent run, filtered through canonical
  agent policy, exposed with the provider's model-safe name, and translated back to
  canonical identities during both model filtering and forced-call enforcement.
- `browser/click`, `browser/type`, `browser/drag`, `browser/dialog`, and
  `browser/run-code` require Bridgit host approval because they can submit data,
  confirm actions, disclose files, or otherwise change remote page state.
- Browser open, read, navigate, hover, and screenshot operations do not add a Bridgit
  approval gate. Any confirmation the provider itself requires remains independent.
- Browser `pageId` values belong to VS Code's live integrated-browser provider.
  Bridgit does not persist or recreate browser pages. A page ID may be reused while
  that provider page remains live in the current workflow; stale or closed page IDs
  fail at provider invocation.
- `Deep Agents: Inspect Project Customizations` reports resolved web/browser mappings,
  approval classification, and limitations.

Automated integration covers complete-family resolution, missing/incompatible
fail-closed behavior, Copilot contribution correlation, explicit-URL web routing,
browser-only routing, approval classification, provider invocation, model-safe alias
translation, and forced forbidden-call blocking.

Manual acceptance checkpoint:

1. Restart the Extension Development Host with the latest extension build.
2. Run `Deep Agents: Inspect Project Customizations`.
3. Confirm `Web/browser runtime tools (11)` appears, including
   `web/fetch -> copilot_fetchWebPage` and the ten browser mappings above.
4. Confirm the diagnostic says general web search is unavailable.
5. Select `Web Fetch Verifier` and ask:
   `Fetch https://example.com and report its main heading. Do not open a browser.`
6. Confirm the result reports `Example Domain` and no integrated browser page opens.
7. Select `Browser Verifier` and ask:
   `Open file:///Users/r2r0garza/Documents/01-Projects/bridgit-deepagents/test-workbench/browser-fixture.html, read the page, click Increment once, then read it again and report the count.`
8. Confirm an approval checkpoint appears before the click. Approve it once.
9. Confirm the final result reports `Count: 1`.

Manual acceptance evidence — 2026-07-29:

- `Web Fetch Verifier` invoked `copilot_fetchWebPage` for an explicit HTTPS URL
  without opening an integrated browser page.
- A browser-workflow prompt sent to that fetch-only agent could not invoke browser
  tools. Its claim about the expected click result was inferred from fetched HTML,
  not an observed interaction; retrying with the intended browser agent established
  the real interaction boundary.
- `Browser Verifier` invoked `open_browser_page` and received a live provider-managed
  `pageId`.
- Before `click_element` executed, Bridgit displayed an approval checkpoint containing
  the provider name, safety description, page ID, selector, and human-readable element.
- Choosing `Allowed once` resumed the interrupted run. The subsequent `read_page`
  invocation observed and reported `Count: 1`.
- The test therefore verifies both locked routing boundaries: fetch-only retrieval
  does not launch a browser, and interactive form action uses the browser provider
  with host approval.
- Plan 04 acceptance is complete.

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

#### Plan 05 implementation evidence — 2026-07-29

- The conservative default for an omitted or empty `agents:` list is no delegated
  children.
- The selected parent receives a `task` tool only when its resolved tools include the
  `agent` capability and at least one declared child remains eligible.
- The built-in general-purpose subagent is removed. The task schema and project-specific
  delegation prompt expose only eligible project child IDs.
- `user-invocable: false` children remain eligible for delegation, while
  `disable-model-invocation: true`, unknown, duplicate, and cyclic children are
  excluded with diagnostics.
- Delegation is bounded to one child level. A direct child with its own `agents:` list
  remains callable, but nested delegation is withheld and reported as depth-limited.
- Every child is compiled with its own Markdown instructions, resolved tool policy,
  current project skill catalog, MCP/web/browser adapters, approval rules, and shared
  activity ledger. Parent tools are never inherited.
- A forced `task` call with an undeclared child ID returns an error ToolMessage before
  any child graph runs.
- The parent run's abort signal reaches active child model and tool requests. Child
  approval interrupts propagate through the parent checkpoint and resume without
  applying the side effect before approval.
- Shared adapter and tool-ledger events retain the outer `task` call/result and nested
  child tool activity for inert conversation replay.
- Unit and end-to-end tests cover allowlists, hidden and disabled children, direct and
  indirect cycles, depth bounding, child tool limits, forced calls, approval resume,
  cancellation, and delegation activity events. TypeScript check, production bundle,
  and the complete automated suite pass.

Manual workbench fixtures are available through `Delegation Parent`:

1. Ask it to delegate reading `/delegation-fixture.txt`; the result should include
   `delegation-reader-result: alpha:project-agent-delegation`.
2. Ask it to use `delegation-forbidden`; it must report that the child is unavailable
   and must not return the fixture agent's `ERROR:` marker.
3. Ask it to run the controlled approval edit. The delegated writer should pause before
   changing `/delegation-approval.txt`; approving once should resume and change
   `before` to `after`.

The first manual pass found two integration defects that the isolated delegation test
did not exercise:

- The production tool-execution ledger caught LangGraph's approval interrupt as an
  ordinary tool failure. It now restores the interrupted wrapper to a retryable state
  and rethrows graph interrupts so the host presents and resumes the approval.
- Child-final and parent-final streaming text reused one webview draft bubble, which
  concatenated both responses and caused the parent response to be rendered again at
  completion. Tool-result boundaries now close the current draft before subsequent
  model text.

Regression coverage now runs the delegated approval through the production durable
ledger, including interrupt propagation, pre-approval filesystem state, durable status
transitions, resume, and the approved side effect. The full automated suite passes
after both fixes.

Corrected manual verification confirmed:

- The delegated writer presents the standard approval checkpoint before editing.
- Choosing `Allowed once` resumes the parent run and applies `before` → `after`.
- Delegated-reader output and the parent's summary render as separate responses without
  concatenation or duplicate parent text.
- Plan 05 acceptance is complete.

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

#### Plan 06 implementation evidence — 2026-07-29

- Replaced the separate text Send and Cancel buttons with one square primary control.
- A dependency-free, unit-tested resolver maps composer state to the control:
  - idle + empty → disabled right arrow;
  - idle + text → enabled right arrow;
  - running + empty → stop square;
  - running + text → up arrow.
- No selected agent also keeps idle send disabled, while the selected agent is fixed
  during a run and does not affect stop or steering availability.
- The control updates its `title` and `aria-label` to `Send message`,
  `Select an agent before sending`, `Stop active run`, or
  `Send steering message` as appropriate. The glyph itself is hidden from assistive
  technology.
- Click and unmodified Enter call the same primary-action function. Shift+Enter retains
  the browser's normal newline behavior.
- The textarea remains enabled while a run is active. Workbench refreshes, selector
  refreshes, run-state changes, and assistant/tool updates do not replace its value.
- Sending a normal idle turn clears the composer. Stop uses the existing cancellation
  message. The up arrow emits a typed `steer` host message but deliberately preserves
  the draft; Plan 07 owns safe queueing, acknowledgement, and draft clearing.
- TypeScript check, production bundle, the composer state-machine test, and the full
  automated suite pass.

Manual visual checkpoint:

1. With an agent selected and an empty composer, confirm the disabled right arrow and
   `Send message` tooltip. Typing text enables it.
2. Confirm Shift+Enter inserts a newline and Enter sends the idle turn.
3. While the run is active and the composer is empty, confirm the stop square,
   `Stop active run` tooltip, and successful cancellation.
4. During another active run, type without stopping. Confirm the textbox remains
   editable, the control becomes an up arrow with `Send steering message`, and clearing
   the text restores the stop square.
5. Do not expect steering to affect the run until Plan 07; if activated in this slice,
   its draft intentionally remains visible.

Manual verification confirmed all four composer states, shared Enter/click behavior,
editable running input, Shift+Enter newline entry, and stop cancellation. Plan 06
acceptance is complete.

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

#### Plan 07 implementation evidence — 2026-07-29

- Added one host-owned `SteeringQueue` for each active parent run. Accepted messages
  are deduplicated by request ID and drained in FIFO order.
- Added parent-only LangChain middleware that injects all currently queued messages
  immediately before the next model call. Tool execution and approval resumption finish
  first, so an assistant tool call and its corresponding `ToolMessage` remain adjacent.
- Steering received during a final model response schedules another invocation with no
  new ordinary user turn. The completed intermediate response is retained and the
  steered follow-up starts in a separate response bubble.
- The composer clears a steering draft only after the extension host acknowledges it.
  Replay renders steering as a distinct labeled user message with queued, injected, or
  discarded status.
- Persisted `steering_message`, `steering_injected`, and `steering_discarded` events
  preserve causal outcomes. Schema migration 4 rebuilds the constrained event table
  without losing existing rows and accepts the new event types.
- Cancellation and failure close the queue and persist discard outcomes for pending
  entries. A restarted approval-waiting run restores only accepted entries that have
  neither an injected nor discarded outcome; already injected entries are not replayed
  into the model.
- Unit and integration coverage verifies FIFO ordering, duplicate safety, queue closure,
  cancellation discard, restart restoration, late-response follow-up, safe
  tool-call/result ordering, replay status, and migration data retention.
- TypeScript check, production build, the complete automated suite, and
  `git diff --check` pass.

Manual checkpoint:

1. Start a fresh run with an agent that can execute commands and ask it to run a command
   that waits about eight seconds before printing `alpha`, then report that result.
2. Approve the command. While it is executing, type
   `Also end your final answer with BRAVO.` and activate the up-arrow control.
3. Confirm the draft clears only after acknowledgement and appears as a separate
   `Steering` message. The empty composer must immediately return to the stop control.
4. Confirm the tool completes once, its result remains paired with its tool call, and
   the next model response reports `alpha` and ends with `BRAVO`.
5. Reload the Extension Host after completion and confirm the steering message remains
   distinct in replay and is shown as applied, rather than becoming an ordinary user
   turn or being applied again.

Manual verification confirmed that steering was acknowledged and applied during the
active run, with the tool operation completing and the steered final response produced
as expected. Plan 07 acceptance is complete.

### Plan 08 — Failure-loop and diagnostic hardening

- Add bounded repeated-tool-failure detection.
- Improve capability-limitation feedback.
- Add structured diagnostics for provider/tool registration.
- Review provider and tool diagnostics for sensitive-data exposure.

Acceptance:

- Repeated identical failures terminate within the documented bound.
- Structured diagnostics provide enough evidence to debug provider and tool exposure
  without including complete model prompts or tool-returned secrets.

#### Plan 08 repeated-failure slice — 2026-07-29

- Added a run-scoped middleware guard with a limit of three matching failures.
- A matching failure has the same tool name, canonicalized input, and normalized error
  result. Different inputs have independent counts, and a successful execution of the
  same request clears its earlier failures.
- At the third matching failure, the corresponding `ToolMessage` remains paired with
  its assistant tool call and gains an explicit terminal explanation. The next model
  decision receives the existing failure context with an empty tool list, allowing one
  final user-facing explanation without another tool attempt.
- Calls already emitted in the threshold-crossing model response are blocked before
  execution. If a provider nevertheless forces another tool/model cycle after the
  tools-disabled response, the guard raises a typed terminal error instead of looping.
- The guard is installed outside the policy, delegation, approval, and durable-ledger
  middleware so it observes returned policy/delegation failures while leaving graph
  interrupts and completed side effects unchanged.
- Unit coverage verifies canonical input matching, independent inputs, success reset,
  terminal tool blocking, the tools-disabled response, and the hard fallback bound.
  DeepAgents integration coverage verifies three forced policy failures followed by one
  final tools-disabled model response.
- TypeScript check, production build, and the complete automated suite pass.

Manual checkpoint:

1. Select an agent with `read_file` access and ask:
   `Use read_file to read /plan08-definitely-missing.txt exactly three times with
   exactly the same path even when it fails, then explain the result.`
2. Confirm exactly three failed read activities appear, each with a corresponding
   result. No fourth read should execute.
3. Confirm the final response explains the missing file or capability limitation
   instead of retrying indefinitely.

Manual verification confirmed exactly three paired `read_file` failures for the same
missing path, no fourth execution, no file changes, and a coherent final ENOENT
explanation. The repeated-failure slice is accepted.

#### Plan 08 capability-feedback slice — 2026-07-29

- Every model call now receives an authoritative, sorted inventory of tools actually
  exposed after agent-policy and runtime-provider filtering.
- When configured capabilities have no matching runtime tool, the prompt identifies
  them as currently unavailable and explains that a provider/configuration state change
  is required before an unchanged retry can succeed.
- An agent with no usable tools is told to answer without tools, explain the limitation,
  and suggest selecting an appropriately configured agent for workspace or external
  actions.
- Forced policy violations now state that no execution occurred, list the agent's
  configured capability selectors, prohibit alias/equivalent retries, and suggest the
  concrete agent-selection or `.agent.md` configuration remedies.
- Invalid delegation attempts now distinguish “not invoked” from execution failure,
  preserve the allowed-child list, and prohibit spelling-based retries.
- Registered VS Code provider errors now distinguish unavailable, permission-denied,
  and provider-failure states. Unavailable and permission-denied results describe the
  external state change required before retrying.
- Unit and DeepAgents integration coverage verifies visible/no-tool prompts, unavailable
  configured capabilities, forced-call blocking guidance, provider-state guidance, and
  unchanged fail-closed enforcement.
- TypeScript check, production build, complete automated suite, and
  `git diff --check` pass.

Manual checkpoint:

1. Select `Quality Reviewer`, whose explicit empty tools list resolves to no tools.
2. Ask:
   `Create capability-feedback.txt containing hello. If you cannot, explain exactly
   which capability is missing and what I should change.`
3. Confirm no tool activity or approval appears and no file is created.
4. Confirm the response immediately explains that the selected agent lacks a file-write
   capability and recommends selecting an agent with write/edit access or updating the
   agent's `.agent.md` tools configuration.

Manual verification confirmed that the no-tools agent exposed no activity or approval,
did not create the requested file, cited the authoritative empty runtime inventory,
identified `write_file`/`edit_file` as missing, and suggested appropriate configuration
or local alternatives. The capability-feedback slice is accepted.

#### Plan 08 sanitized-diagnostics slice — 2026-07-29

- Added `Deep Agents: Inspect Runtime Diagnostics` as a separate command from the
  detailed registered-tool research report.
- The versioned JSON snapshot includes only:
  - VS Code and capture metadata;
  - registered Copilot model identifiers and token limits;
  - registered tool names, tags, contribution-manifest owners, and top-level schema
    shape;
  - resolved MCP/web/browser canonical-to-provider mappings and approval classification;
  - sorted structured warning codes for missing/duplicate/unattributed providers and
    runtime contract mismatches.
- Explicit safety flags state that the report contains no model prompts, tool inputs,
  tool results, or MCP launch configuration.
- Tool descriptions, schema descriptions/defaults/examples, MCP source paths, commands,
  URLs, environment values, and invocation data are not copied into the snapshot.
- The report uses current `selectChatModels({ vendor: "copilot" })` and `vscode.lm.tools`
  snapshots, so provider changes are re-read each time the command runs.
- Automated redaction fixtures plant private marker strings in descriptions, schema
  defaults, MCP paths, commands, and environment values and prove none appear in the
  rendered report. Coverage also verifies model absence, duplicate tool names,
  unattributed tools, and canonical MCP resolution.
- Manual inspection found that emitting one warning for every tool without a matching
  contribution manifest overwhelmed the actionable diagnostics. Those entries are now
  consolidated into one count-based warning that points to each tool's existing
  `contributingExtensions` field and avoids inferring ownership from names.
- TypeScript check, production build, complete automated suite, and
  `git diff --check` pass.

Manual checkpoint:

1. Reload the Extension Host so the contributed command is available.
2. Run `Deep Agents: Inspect Runtime Diagnostics` from the Command Palette.
3. Confirm the `Deep Agents Runtime Tools` output starts with the safe-diagnostic notice
   and contains a JSON object with `schemaVersion: 1`.
4. Confirm all four `safety` values are `false`.
5. Confirm the report lists model metadata, registered tool schema shape, resolved
   MCP/web/browser mappings, and structured diagnostics applicable to the current
   workspace.
6. Confirm it does not contain recent user prompts or tool results, MCP command/URL/env
   values, or complete tool/schema descriptions. Running this command must not invoke a
   model or registered tool.

Initial manual inspection confirmed the versioned structure, all-false safety flags,
current model/tool mappings, useful MCP/web diagnostics, and absence of prompt, result,
launch-configuration, and secret-bearing values. A final rerun after the unattributed
warning consolidation should show exactly one `tools.runtime.unattributed` diagnostic.

The final manual rerun confirmed `schemaVersion: 1`, all four safety flags set to
`false`, and exactly one aggregated `tools.runtime.unattributed` diagnostic covering
the currently unattributed registrations. Plan 08 acceptance is complete.

### Plan 09 — Documentation and end-to-end verification

- Update the stale README claims about memory-only sessions and universally enabled tools.
- Document `.github` agent, skill, and MCP support.
- Document fail-closed `tools` semantics and ignored `vscode`.
- Document web versus browser intent.
- Document delegation, stop, steering, and prompt settings after implementation.
- Run the full automated suite and manual acceptance matrix.

#### Plan 09 implementation evidence — 2026-07-29

- Replaced stale README claims about in-memory chats, universally available built-ins,
  and an exclusively private tool path.
- Documented the durable SQLite/checkpoint model, process-local approval authority,
  startup recovery, and the distinction between persisted audit history and current
  authorization.
- Documented `.github/agents/*.agent.md`, `.github/skills/*/SKILL.md`, both MCP
  configuration locations and their precedence, agent visibility/delegation fields,
  and conservative one-level child allowlists.
- Documented fail-closed tool selection, built-in aliases, exact and wildcard MCP
  selectors, ignored `vscode`, per-call capability feedback, and forced-call
  enforcement.
- Documented explicit-URL `web/fetch` versus interactive `browser/*`, provider-managed
  page state, and the approval boundary for state-changing browser actions.
- Documented composer stop/steer states, FIFO steering at safe model boundaries,
  cancellation without rollback, repeated-failure termination, and the safe and
  sensitive diagnostic surfaces.
- Kept Phase 002 ownership explicit: complete prompt logging remains temporary and
  sensitive until the settings phase adds its persisted opt-in, default-agent setting,
  and Deep Agents base-prompt toggle.
- `npm test` passes, including TypeScript checking, the production bundle, all runtime
  adapter/policy/delegation/composer/steering/failure tests, and the complete existing
  persistence, approval, recovery, and tool-ledger suite. `git diff --check` also
  passes.

Earlier slice acceptance already supplies manual evidence for matrix items 1 and 4–11:
allowed MCP invocation; interactive browser routing and approval; allowed and forbidden
delegation; stop; steering during tool activity with intact pairing; bounded repeated
failures; and coherent replay after Extension Host reload.

Final manual checkpoint:

1. With the Playwright MCP server running and trusted, select `MCP Fixture Verifier`
   and ask:
   `Use playwright-mcp/browser_click. If it is unavailable to you, report the exact
   tools exposed for this model call and do not substitute another tool.`
2. Confirm no Playwright tool activity or approval appears. The response should state
   that only `bridgit-runtime-fixture/read_fixture` is exposed (or otherwise accurately
   omit `playwright-mcp/browser_click` from the exposed inventory).
3. Select `Web Fetch Verifier` and ask:
   `What are today's top news stories? Use only your available tools. Do not invent a
   URL and do not open a browser.`
4. Confirm no browser opens and no fetch call is made against a guessed URL. The
   response should explain that only explicit-URL fetch is available and that no
   deterministic general web-search provider is exposed.

Final manual acceptance evidence — 2026-07-29:

- With `MCP Fixture Verifier` selected, a request for
  `playwright-mcp/browser_click` produced no Playwright activity or approval. The
  response accurately listed `bridgit-runtime-fixture/read_fixture` as the only tool
  exposed for that model call.
- With `Web Fetch Verifier` selected, an open-ended request for today's top news
  produced no browser activity and no fetch against an invented URL. The response
  correctly declined because no explicit URL was supplied and the selected agent had
  no browser capability. Although its wording did not name the absent general-search
  provider directly, its behavior and stated limitation preserved the locked
  fetch-versus-browser/search boundary.
- Together with the earlier slice evidence, all eleven manual verification-matrix
  items have passed. Plan 09 and the runtime-capabilities completion phase are
  accepted.

## Verification Matrix

### Automated

- Provider adapter schema, result, error, and cancellation tests.
- MCP discovery-to-runtime integration with allow/deny enforcement.
- Web/browser intent and availability tests.
- Delegation allowlist, policy isolation, cycle, and depth tests.
- Composer state-machine tests.
- Steering causal-order and tool-pairing tests.
- Repeated-failure loop bound.
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

## Success Criteria

- Configured MCP tools are callable only under the selected agent’s policy.
- Web and browser behaviors are distinct and use supported VS Code providers.
- Project-agent delegation is allowlisted, bounded, and policy-isolated.
- Stop reliably cancels active work without implying rollback.
- Steering reaches the next safe model boundary without corrupting tool protocol state.
- Repeated tool failures do not spiral indefinitely.
- Documentation matches shipped behavior.
- Existing persistence, approval, recovery, agent, skill, and tool-policy tests remain green.

## Out of Scope

- The Phase 001 future-goal scheduler and autonomous background continuation.
- The Phase 002 settings pane and settings persistence implementation.
- A general-purpose bridge for the `vscode` tool capability.
- Custom browser engines when VS Code’s integrated provider is sufficient.
- Cloud synchronization or execution while VS Code is closed.
- Silent retries of uncertain side effects.
