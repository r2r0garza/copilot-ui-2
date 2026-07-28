# Persistence Foundation Plan

**Status:** Ready for implementation  
**Created:** 2026-07-28  
**Scope:** Durable chat sessions now; crash-resumable goals and long-running work later  

## Objective

Replace panel-local memory with a workspace-scoped SQLite persistence layer that:

1. Restores chats, messages, model selection, titles, and visible activity after the Extension Host restarts.
2. Gives every agent conversation a stable LangGraph `thread_id`.
3. Replaces per-run `MemorySaver` instances with a durable SQLite checkpointer.
4. Establishes explicit run, recovery, todo-snapshot, approval-audit, and tool-execution records for future long-running goals.
5. Makes crash recovery safe: interrupted work can resume from its last checkpoint without silently repeating an uncertain side effect.

The persistence layer is an execution substrate, not merely chat-history storage.

## Phase Boundary

### Delivered in this phase

- One versioned SQLite database per VS Code workspace.
- Durable session list and session metadata.
- Durable conversation messages and UI activity events.
- Stable LangGraph threads backed by SQLite checkpoints.
- Session creation, rename, deletion, model changes, and title generation persisted.
- A run ledger capable of identifying work interrupted by Extension Host termination.
- A recovery policy and APIs that future durable goals can use.
- Versioned snapshots of Deep Agents todos for visibility and diagnostics.
- Persistence and restart integration tests.
- Native SQLite packaging verification for supported VS Code platforms.

### Designed now, implemented later

- A goal/task scheduler.
- Automatic background continuation.
- “Auto” execution policy.
- Host-owned durable task decomposition with stable task IDs.
- Cross-workspace task dashboards.

### Explicitly out of scope

- Running while VS Code or the laptop is off.
- Cloud synchronization or multi-device continuation.
- Automatically rerunning a command whose completion is unknown after a crash.
- Treating the current Deep Agents todo list as an independently mutable source of truth.
- Persisting “Allow for session” authority across Extension Host restarts.
- Multi-root workspace support beyond the current first-root behavior.

## Research Basis

- LangGraph requires a checkpointer plus a stable `configurable.thread_id`; checkpoints are written at graph step boundaries and allow interrupted work to resume from stored state.
- The official JavaScript SQLite implementation is `@langchain/langgraph-checkpoint-sqlite`, whose `SqliteSaver` stores `checkpoints` and pending `writes`.
- The current SQLite saver depends on native `better-sqlite3`, so VS Code/Electron ABI packaging must be proven before the dependency is locked in.
- Deep Agents accepts both `checkpointer` and `store` options.
- Deep Agents’ `write_todos` state currently contains `{ content, status }`, where status is `pending`, `in_progress`, or `completed`. It does not expose a stable todo ID.
- LangGraph resumes at node boundaries. A node containing an external side effect can run again after interruption, so resumability alone does not guarantee exactly-once effects.

References:

- [LangGraph persistence documentation](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph checkpointer documentation](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)
- [LangGraph SQLite saver source](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite)
- [Deep Agents JavaScript source](https://github.com/langchain-ai/deepagentsjs)

## Locked Architecture Decisions

### D-01: Workspace-scoped database

Store the database under `ExtensionContext.storageUri`, for example:

`<workspace-storage>/deep-agents.sqlite`

This matches the existing repository-scoped agent boundary. Opening the same VS Code workspace restores its chats and recoverable work. A global task index can be added later without moving the underlying execution database.

### D-02: One SQLite file, separate ownership boundaries

Use one file with two logical owners:

- LangGraph owns its `checkpoints` and `writes` tables.
- The extension owns all application tables and migrations.

Application code must not query or mutate LangGraph tables directly. It interacts with them through the checkpointer API.

### D-03: LangGraph checkpoints are canonical execution state

Checkpoints are the source of truth for exact graph reconstruction, including messages, interrupts, pending writes, and the Deep Agents `todos` state.

Relational application tables are used for:

- Session discovery and sorting.
- UI replay.
- Goal and run lifecycle.
- Recovery decisions.
- Auditing approvals and side effects.
- Searchable/projectable todo snapshots.

If a projection disagrees with a checkpoint, the checkpoint wins and the projection is rebuilt.

### D-04: Stable thread per session or durable goal

- Each chat session gets one stable UUID `thread_id`.
- Every turn in that chat invokes the graph with that same `thread_id`.
- A future independently executing goal gets its own stable thread, even if it originated from a chat.
- `checkpoint_ns` remains explicit and defaults to an empty string.

Changing the selected model does not change the thread. A newly compiled Deep Agent can load the same checkpoint using the selected model for the next turn.

### D-05: Append-only conversation events

Persist user messages, assistant messages, tool calls, tool results, approvals, errors, and cancellations as ordered events. The UI replays these events rather than trying to decode LangGraph checkpoint blobs.

Mutable session data—title, model, status—is stored on the session row.

### D-06: Todo snapshots, not a mutable todo source of truth

Do not create a canonical `tasks` table from current `write_todos` output. The todo objects have no stable IDs, and matching by text or array position would corrupt identity when the agent rewrites its plan.

Persist each observed todo list as a snapshot linked to a run and checkpoint. Later durable goals should use one of these deliberate approaches:

1. Introduce host-owned `goal_tasks` with stable UUIDs and map them into agent context.
2. Replace/extend the planning middleware so todos carry stable IDs.

That later decision must not be hidden inside this persistence migration.

### D-07: Safe recovery before automatic recovery

On startup, a stale `running` attempt becomes `interrupted`. Recovery classifies it as:

- `safe_to_resume`: checkpoint exists and no side effect is in an uncertain state.
- `waiting_for_approval`: checkpoint contains a human-in-the-loop interrupt.
- `needs_review`: a command or write may have executed but its result was not durably recorded.
- `not_resumable`: checkpoint is absent or incompatible.

Only `safe_to_resume` may eventually be eligible for automatic continuation. `needs_review` always requires a user decision.

### D-08: Approval authority expires on restart

Persist approval decisions for audit and UI replay, but attach active “Allow for session” grants to a process-instance ID. On activation, previous process grants are inactive.

Pending approval interrupts remain resumable and must be shown again.

### D-09: Versioned migrations and conservative durability

The database service configures:

- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000`
- A documented `synchronous` setting selected during the SQLite packaging spike

Every schema change is an ordered migration executed transactionally. Startup aborts persistence initialization on a failed or unknown migration rather than silently resetting data.

## Proposed Data Model

The SQL below is a contract sketch. Migration files remain the implementation source of truth.

### `app_migrations`

| Column | Purpose |
|---|---|
| `version INTEGER PRIMARY KEY` | Monotonic schema version |
| `name TEXT NOT NULL` | Migration name |
| `applied_at TEXT NOT NULL` | ISO timestamp |

### `workspace_metadata`

| Column | Purpose |
|---|---|
| `id INTEGER PRIMARY KEY CHECK (id = 1)` | Single-row metadata |
| `workspace_uri TEXT NOT NULL` | URI used when the database was created |
| `workspace_root TEXT NOT NULL` | Display/debug path |
| `created_at`, `updated_at` | Lifecycle timestamps |

### `chat_sessions`

| Column | Purpose |
|---|---|
| `id TEXT PRIMARY KEY` | Stable session UUID |
| `thread_id TEXT UNIQUE NOT NULL` | Stable LangGraph thread |
| `checkpoint_ns TEXT NOT NULL DEFAULT ''` | LangGraph namespace |
| `title TEXT NOT NULL` | Display title |
| `title_source TEXT NOT NULL` | `default`, `generated`, or `manual` |
| `selected_model_key TEXT` | Last selected Copilot model |
| `status TEXT NOT NULL` | `active`, `archived`, or `deleting` |
| `created_at`, `updated_at`, `last_event_at` | Sorting and lifecycle |

Index `status, last_event_at DESC`.

### `conversation_events`

| Column | Purpose |
|---|---|
| `id TEXT PRIMARY KEY` | Event UUID |
| `session_id TEXT NOT NULL` | Parent session |
| `run_id TEXT` | Logical agent run, when applicable |
| `sequence INTEGER NOT NULL` | Strict ordering within a session |
| `event_type TEXT NOT NULL` | Message, tool, approval, error, or cancellation type |
| `payload_json TEXT NOT NULL` | Versioned event payload |
| `created_at TEXT NOT NULL` | Timestamp |

Constraints:

- Foreign key to `chat_sessions(id)` with cascade delete.
- Unique `(session_id, sequence)`.
- Event inserts and `chat_sessions.last_event_at` updates occur in one transaction.

Initial event types:

- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `approval_requested`
- `approval_resolved`
- `run_error`
- `run_cancelled`
- `model_changed`
- `title_changed`

Each payload includes `schemaVersion: 1`.

### `checkpoint_cleanup_queue`

LangGraph thread deletion cannot be assumed to share the same application transaction.
This queue makes clear/delete operations restart-safe.

| Column | Purpose |
|---|---|
| `thread_id TEXT NOT NULL` | Thread to remove through the saver API |
| `checkpoint_ns TEXT NOT NULL DEFAULT ''` | Namespace |
| `reason TEXT NOT NULL` | `session_deleted`, `session_cleared`, or migration cleanup |
| `attempts INTEGER NOT NULL DEFAULT 0` | Retry count |
| `last_error TEXT` | Most recent cleanup failure |
| `created_at`, `updated_at` | Lifecycle |

Primary key: `(thread_id, checkpoint_ns)`.

### `goals`

This table establishes the future durable-task boundary without implementing scheduling yet.

| Column | Purpose |
|---|---|
| `id TEXT PRIMARY KEY` | Goal UUID |
| `session_id TEXT` | Optional originating chat |
| `title TEXT NOT NULL` | Human-readable name |
| `objective TEXT NOT NULL` | Durable user intent |
| `status TEXT NOT NULL` | `draft`, `queued`, `running`, `paused`, `completed`, `failed`, or `cancelled` |
| `priority INTEGER NOT NULL DEFAULT 0` | Future scheduler input |
| `active_run_id TEXT` | Current logical run |
| `version INTEGER NOT NULL DEFAULT 1` | Optimistic concurrency |
| `created_at`, `updated_at`, `completed_at` | Lifecycle |

Create the table and repository in this phase, but no production UI writes goals until the later durable-goals phase.

### `agent_runs`

A row represents one logical execution that may span multiple Extension Host processes.

| Column | Purpose |
|---|---|
| `id TEXT PRIMARY KEY` | Logical run UUID |
| `session_id TEXT` | Chat context |
| `goal_id TEXT` | Optional durable goal |
| `thread_id TEXT NOT NULL` | LangGraph thread used by this run |
| `checkpoint_ns TEXT NOT NULL DEFAULT ''` | LangGraph namespace |
| `last_checkpoint_id TEXT` | Last observed checkpoint |
| `model_key TEXT` | Model selected for the latest step |
| `status TEXT NOT NULL` | Run state |
| `recovery_class TEXT` | Recovery decision |
| `resume_count INTEGER NOT NULL DEFAULT 0` | Number of resumptions |
| `last_error TEXT` | Diagnostic, not control flow |
| `created_at`, `updated_at`, `completed_at` | Lifecycle |

Initial run states:

`queued`, `running`, `waiting_approval`, `paused`, `interrupted`, `completed`, `failed`, `cancelled`.

### `run_attempts`

Each Extension Host process that works on a logical run creates an attempt.

| Column | Purpose |
|---|---|
| `id TEXT PRIMARY KEY` | Attempt UUID |
| `run_id TEXT NOT NULL` | Logical run |
| `process_instance_id TEXT NOT NULL` | Activation instance |
| `status TEXT NOT NULL` | `starting`, `running`, `interrupted`, `completed`, or `failed` |
| `lease_expires_at TEXT` | Stale-run detection |
| `heartbeat_at TEXT` | Last liveness signal |
| `started_at`, `ended_at` | Attempt lifecycle |
| `interruption_reason TEXT` | Crash/restart/network/user classification |

Only one unexpired attempt lease may own a run.

### `todo_snapshots`

| Column | Purpose |
|---|---|
| `run_id TEXT NOT NULL` | Logical run |
| `checkpoint_id TEXT NOT NULL` | Snapshot version |
| `ordinal INTEGER NOT NULL` | Position in Deep Agents todo array |
| `content TEXT NOT NULL` | Todo text |
| `status TEXT NOT NULL` | `pending`, `in_progress`, or `completed` |
| `observed_at TEXT NOT NULL` | Timestamp |

Primary key: `(run_id, checkpoint_id, ordinal)`.

These rows are a read model only. They do not reconstruct graph state.

### `tool_executions`

| Column | Purpose |
|---|---|
| `run_id TEXT NOT NULL` | Logical run |
| `tool_call_id TEXT NOT NULL` | Provider/LangGraph call ID |
| `tool_name TEXT NOT NULL` | Tool name |
| `input_json TEXT NOT NULL` | Exact requested arguments |
| `input_hash TEXT NOT NULL` | Integrity/idempotency comparison |
| `effect_class TEXT NOT NULL` | `read_only`, `idempotent_write`, or `non_idempotent` |
| `status TEXT NOT NULL` | Execution lifecycle |
| `output_json TEXT` | Durable result |
| `started_at`, `finished_at` | Timing |

Primary key: `(run_id, tool_call_id)`.

Lifecycle:

`requested`, `waiting_approval`, `approved`, `running`, `succeeded`, `failed`, `denied`, `uncertain`.

If the process dies after `running` but before a terminal result, recovery marks the row `uncertain`. A non-read-only uncertain operation blocks automatic resume.

### `approval_decisions`

| Column | Purpose |
|---|---|
| `id TEXT PRIMARY KEY` | Decision UUID |
| `session_id`, `run_id`, `tool_call_id` | Scope |
| `tool_name TEXT NOT NULL` | Approved/denied capability |
| `decision TEXT NOT NULL` | `once`, `session`, or `deny` |
| `process_instance_id TEXT NOT NULL` | Restart expiration boundary |
| `created_at TEXT NOT NULL` | Audit timestamp |

## Recovery State Machine

```text
queued
  -> running
     -> waiting_approval -> running
     -> paused          -> running
     -> completed
     -> failed
     -> cancelled

running + stale lease
  -> interrupted
     -> safe_to_resume      -> queued/running
     -> waiting_for_approval
     -> needs_review
     -> not_resumable
```

Startup recovery procedure:

1. Create a new `process_instance_id`.
2. Find attempts with an expired lease and nonterminal status.
3. Mark those attempts `interrupted`.
4. Load the latest checkpoint through the saver API.
5. Inspect pending interrupts and nonterminal `tool_executions`.
6. Assign `recovery_class`.
7. Surface recoverable work in the UI; do not start it automatically in this phase.
8. On explicit resume, reuse `thread_id` and increment `resume_count`.

## Runtime Integration Changes

Current behavior to replace:

- `MemorySaver` is created inside every `run()`.
- A new random `thread_id` is created for every turn.
- The entire transcript is replayed into a newly created graph.
- Sessions and approval scopes exist only in panel memory.

Target behavior:

1. `activate()` creates one workspace `PersistenceService`.
2. `PersistenceService` opens/migrates the database and exposes:
   - `SessionRepository`
   - `ConversationEventRepository`
   - `GoalRepository`
   - `RunRepository`
   - `ToolExecutionRepository`
   - `ApprovalRepository`
   - `CheckpointCleanupRepository`
   - `RecoveryRepository`
   - `SqliteSaver`
3. The panel loads session summaries before rendering initial state.
4. Sending a user message:
   - Inserts the user event and logical run record transactionally.
   - Invokes Deep Agents with only the new input and the session’s stable `thread_id`.
   - Lets the checkpointer load prior graph state.
   - Persists UI events as adapter/tool/approval events arrive.
   - Writes a terminal run state and assistant event.
5. Switching models updates `chat_sessions.selected_model_key`; the next graph compilation uses that model and the same thread.
6. Deleting a session marks it `deleting` and enqueues its thread for checkpoint cleanup. After `checkpointer.deleteThread(thread_id)` succeeds, application rows are hard-deleted. Startup retries unfinished cleanup.
7. Clearing a session rotates it to a new `thread_id`, deletes its visible events, and queues the old thread for cleanup. This makes the cleared chat immediately fresh even if old-checkpoint cleanup must be retried.
8. Closing the panel does not close the database. Extension deactivation closes it.

## Implementation Plans

### Plan 01 — Prove the SQLite runtime and package boundary

**Wave:** 1  
**Files:** `package.json`, `package-lock.json`, `esbuild.mjs`, new persistence spike/test files

#### Task 1.1: Verify the official SQLite saver in the VS Code Extension Host

<read_first>

- `package.json`
- `esbuild.mjs`
- `src/extension.ts`
- `test/run.mjs`

</read_first>

<action>

- Add a controlled spike using `@langchain/langgraph-checkpoint-sqlite`.
- Verify its `better-sqlite3` native dependency can load in:
  - The current Extension Development Host.
  - A packaged VSIX for the current platform.
  - Windows and Linux CI or equivalent target builds.
- Keep the native module external to the esbuild bundle and copy/package it intentionally.
- Record the exact rebuild/packaging command and supported target matrix.
- If the official saver cannot meet the packaging matrix, stop at a decision gate and compare:
  - A small `BaseCheckpointSaver` implementation on `node:sqlite`.
  - A maintained non-native or WASM SQLite implementation.
  - Target-specific VSIX packages containing rebuilt `better-sqlite3`.
- Do not proceed with a custom saver merely to avoid documenting packaging.

</action>

<acceptance_criteria>

- A file-backed checkpoint survives Extension Host reload.
- The same `thread_id` retrieves its latest checkpoint.
- The produced VSIX contains the required SQLite runtime.
- The extension activates without `NODE_MODULE_VERSION` or native-binding errors on every declared platform.
- The selected driver and packaging approach are documented in this plan or a colocated decision note.

</acceptance_criteria>

### Plan 02 — Database service, migrations, and repositories

**Wave:** 2  
**Depends on:** Plan 01  
**Files:** new `src/persistence/**`, `src/extension.ts`, persistence tests

#### Task 2.1: Build the database lifecycle

<read_first>

- Plan 01 decision note
- `src/extension.ts`
- `package.json`

</read_first>

<action>

- Add `PersistenceService.open(context.storageUri, workspaceUri)`.
- Create the storage directory before opening SQLite.
- Configure WAL, foreign keys, busy timeout, and the selected synchronous policy.
- Implement ordered migrations with `app_migrations`.
- Fail activation with a specific VS Code error message if migration fails; never delete or recreate an existing database automatically.
- Add `close()` and register it in extension subscriptions.

</action>

<acceptance_criteria>

- First open creates a valid database and applies migration 1 exactly once.
- Second open is idempotent.
- A failed migration rolls back all changes from that migration.
- Unknown future schema versions fail closed.
- Foreign-key enforcement is verified by test.

</acceptance_criteria>

#### Task 2.2: Implement typed repositories

<read_first>

- Migration SQL
- Existing `ChatSession` and `WebviewMessage` definitions in `src/extension.ts`

</read_first>

<action>

- Implement repositories for sessions, conversation events, goals, runs, attempts, todo snapshots, tool executions, approval audit, and checkpoint cleanup.
- Centralize ISO timestamp creation and JSON encoding/decoding.
- Validate decoded `payload_json` by event type and schema version.
- Provide transactions for:
  - Event append plus session timestamp update.
  - Run start plus attempt creation.
  - Terminal run state plus terminal UI event.
- Add indexes described in the schema.

</action>

<acceptance_criteria>

- Repository tests cover create, read, update, ordered list, cascade delete, malformed JSON, and transaction rollback.
- Concurrent sequence allocation cannot create duplicate `(session_id, sequence)` values.
- No raw SQL is issued from the webview or panel class.

</acceptance_criteria>

### Plan 03 — Persist the current chat experience

**Wave:** 3  
**Depends on:** Plan 02  
**Files:** `src/extension.ts`, new session/runtime services, webview protocol types, integration tests

#### Task 3.1: Move session ownership out of the panel

<read_first>

- `src/extension.ts`
- Session and event repositories
- `src/sidebarProvider.ts`

</read_first>

<action>

- Replace the panel’s `ChatSession[]` with a session service backed by SQLite.
- Load sessions ordered by `last_event_at DESC`.
- Persist new, select, rename, delete, clear, and model-change operations.
- Preserve generated-title/manual-title precedence with `title_source`.
- Make “Clear” rotate `thread_id`, delete conversation events, and queue the old LangGraph thread for cleanup while retaining session identity and approval audit.
- Keep session list rendering behavior unchanged from the user’s perspective.

</action>

<acceptance_criteria>

- Create two chats, add messages, rename one, switch models, reload the Extension Host, and observe the same list/order/title/model/transcripts.
- Deleting a chat hides it immediately, completes queued checkpoint deletion, and removes it after reload.
- Clearing a chat yields an empty transcript after reload and starts a fresh graph state.
- A title-generation response cannot overwrite a manual rename.

</acceptance_criteria>

#### Task 3.2: Persist complete conversation activity

<read_first>

- Adapter event handling in `src/extension.ts`
- `src/vscodeChatModel.ts`
- Conversation event repository

</read_first>

<action>

- Persist user/assistant messages and tool/approval/error/cancellation events.
- Store tool labels and raw input/result payloads needed to rebuild collapsed activity rows.
- Extend `workbenchState` to replay persisted events, not only user/final-assistant transcript entries.
- Bound persisted tool output size and record truncation explicitly.
- Preserve strict event ordering even when adapter callbacks arrive concurrently.

</action>

<acceptance_criteria>

- Tool rows, approval outcomes, errors, and cancellations are restored after session switching and Extension Host reload.
- Restored tool rows remain collapsed by default.
- Event order matches the original visible conversation.
- Large tool output is bounded and visibly marked truncated.

</acceptance_criteria>

### Plan 04 — Durable LangGraph threads

**Wave:** 3  
**Depends on:** Plan 02  
**Files:** agent construction/runtime modules, `src/extension.ts`, integration tests

#### Task 4.1: Replace per-run memory checkpointing

<read_first>

- `src/extension.ts`
- `src/vscodeChatModel.ts`
- SQLite saver API selected in Plan 01
- LangGraph persistence documentation

</read_first>

<action>

- Inject the shared SQLite checkpointer into each `createDeepAgent` call.
- Use `chat_sessions.thread_id` and `checkpoint_ns` for every turn.
- Stop replaying the complete transcript as fresh graph input; submit only the new user message for an existing thread.
- Keep the model adapter selectable per turn.
- Capture the latest checkpoint ID after each graph transition/run and update `agent_runs.last_checkpoint_id`.
- Add a compatibility version to run metadata so later graph-state schema changes can be migrated or declared non-resumable.

</action>

<acceptance_criteria>

- A second turn sees the first turn through checkpoint state without duplicated messages.
- Switching models between turns preserves conversation state.
- Restarting the Extension Host and sending another turn continues the same thread.
- Existing human-in-the-loop approval resume behavior works with the SQLite saver.
- No `MemorySaver` remains in production extension code.

</acceptance_criteria>

#### Task 4.2: Verify interrupted graph continuation

<read_first>

- Durable agent runtime
- LangGraph checkpoint and interrupt tests

</read_first>

<action>

- Add a deterministic test graph/tool that pauses after at least one checkpoint.
- Terminate/dispose the first runtime without completing the graph.
- Construct a new runtime using the same database and `thread_id`.
- Resume through the documented LangGraph API rather than replaying all input.
- Assert already-checkpointed steps are not rerun.

</action>

<acceptance_criteria>

- The integration test proves continuation in a fresh process/runtime.
- Completed checkpointed steps execute once.
- The resumed result contains state produced before interruption.
- An incompatible or missing checkpoint produces a recoverable typed error.

</acceptance_criteria>

### Plan 05 — Recovery and side-effect safety foundation

**Wave:** 4  
**Depends on:** Plans 03 and 04  
**Files:** new recovery/run/tool-ledger services, command tool integration, activation/UI integration, tests

#### Task 5.1: Add leases, heartbeats, and startup recovery classification

<read_first>

- `src/executeCommandTool.ts`
- Run and attempt repositories
- Durable agent runtime

</read_first>

<action>

- Generate one `process_instance_id` per activation.
- Create/renew an attempt lease while a run is active.
- On activation, mark expired active attempts interrupted.
- Classify recovery using checkpoint presence, pending interrupts, compatibility version, and tool-execution state.
- Expose recoverable items to the panel state, initially with an explicit Resume action.
- Do not auto-resume in this phase.

</action>

<acceptance_criteria>

- Simulated process death converts a stale run to `interrupted`.
- Pending approval is classified `waiting_for_approval`.
- A checkpoint with no uncertain side effect is `safe_to_resume`.
- A non-read-only `running` tool row is `needs_review`.
- Missing/incompatible checkpoints are `not_resumable` with a user-facing reason.

</acceptance_criteria>

#### Task 5.2: Add the tool-execution ledger

<read_first>

- `src/executeCommandTool.ts`
- Approval flow in `src/extension.ts`
- Tool execution repository

</read_first>

<action>

- Record tool request, approval, start, and terminal result using `(run_id, tool_call_id)`.
- Classify built-in read tools as `read_only`.
- Classify `write_file` and deterministic whole-file writes as `idempotent_write` only after explicit review.
- Classify `edit_file` and `execute_command` as `non_idempotent` by default.
- If a terminal result already exists for a tool call ID and the input hash matches, return/replay that result instead of executing again.
- If the input hash differs for a reused ID, stop with an integrity error.
- Mark nonterminal executions `uncertain` during crash recovery.

</action>

<acceptance_criteria>

- A completed command result is not executed twice for the same tool call ID.
- Reusing an ID with different input fails closed.
- A crash after tool start but before durable completion produces `uncertain`.
- `uncertain` command/edit operations block automatic graph resume.
- Read-only operations can be retried under an explicit recovery policy.

</acceptance_criteria>

#### Task 5.3: Persist audit, not restart-spanning authority

<read_first>

- Current approval controls
- Approval repository
- Recovery service

</read_first>

<action>

- Write all approval decisions to `approval_decisions`.
- Keep active session grants keyed by the current `process_instance_id`.
- On restart, show prior decisions in replayed history but require new approval for future writes/commands.
- Re-present a checkpointed pending approval without executing the tool.

</action>

<acceptance_criteria>

- “Allow for session” suppresses repeat prompts during one activation.
- Reloading the Extension Host restores the audit event but not the active grant.
- A pending approval survives restart and is shown before execution.
- Denial remains visible in restored activity.

</acceptance_criteria>

### Plan 06 — Future-goal compatibility and operational hardening

**Wave:** 5  
**Depends on:** Plan 05  
**Files:** goal/run repository tests, migration/recovery documentation, README

#### Task 6.1: Prove the schema can represent a resumable goal

<read_first>

- Goal, run, attempt, todo snapshot, and tool execution repositories
- Deep Agents todo state types

</read_first>

<action>

- Add an integration fixture that creates a goal, logical run, process attempt, checkpoints, todo snapshots, and tool ledger entries.
- Simulate interruption and a second attempt.
- Complete the goal without replacing its logical run or LangGraph thread.
- Document that automatic scheduling remains deferred.

</action>

<acceptance_criteria>

- One logical run has two attempts and one stable thread.
- Todo snapshots show pre- and post-resume states.
- Goal lifecycle reaches `completed`.
- No todo snapshot is used to reconstruct the graph.

</acceptance_criteria>

#### Task 6.2: Add backup, corruption, and migration tests

<read_first>

- Persistence service
- All migrations
- VS Code storage lifecycle

</read_first>

<action>

- Test upgrade from every committed schema version.
- Add a database health check using SQLite integrity verification appropriate to startup cost.
- Document manual backup/export and database location.
- Never auto-delete a corrupt database; rename/copy recovery must require user action.
- Add tests for abrupt close with WAL and reopening.

</action>

<acceptance_criteria>

- Migration fixtures reach the current schema without data loss.
- A corrupt database yields a clear error and preserves the original file.
- Abrupt-close test reopens successfully with committed transactions present and partial transactions absent.
- README documents storage scope, restart behavior, approval expiration, and known recovery limits.

</acceptance_criteria>

## Verification Matrix

| Scenario | Expected result |
|---|---|
| Close and reopen chat panel | Sessions remain |
| Reload Extension Host | Sessions, messages, model, titles, tool activity remain |
| Change model between turns | Same thread continues with new model |
| Crash during LLM request before checkpoint | Run becomes interrupted; resume classification is explicit |
| Crash at pending approval | Approval is shown again; tool is not executed |
| Crash before a read-only tool result | Eligible for explicit retry |
| Crash while command/edit status is `running` | Marked uncertain; no automatic retry |
| Delete session | App rows and checkpoint thread are removed |
| Migration failure | Transaction rolls back; original DB remains |
| Laptop/network interruption | On next workspace activation, stale attempt is detected and recoverable state is surfaced |

## Threat Model

### Assets

- User prompts and model responses.
- Source-code excerpts in tool results/checkpoints.
- Command output that may contain secrets.
- Approval decisions.
- Durable goal instructions.

### Threats and mitigations

| Threat | Severity | Mitigation |
|---|---:|---|
| SQL injection through stored metadata/filtering | High | Parameterized extension SQL; never expose arbitrary metadata filter keys; pin patched dependencies |
| Repeated side effects after crash | High | Tool ledger, input hashes, `uncertain` state, user review |
| Old session approval silently surviving restart | High | Process-scoped grants only |
| Corrupt migration destroys history | High | Transactional migrations, fail closed, no automatic reset |
| Database copied/read by another local process | Medium | Store under VS Code extension storage; document local-data sensitivity; avoid logging DB contents |
| Unbounded tool output grows DB indefinitely | Medium | Payload size limits and explicit truncation metadata |
| Stale process and new process both run a goal | High | Attempt leases and ownership checks |
| Graph schema changes make old checkpoints unsafe | Medium | Persist compatibility version and classify non-resumable |

## Artifacts This Phase Produces

Exact names can be adjusted during Plan 01’s driver decision, but responsibilities must remain:

- `src/persistence/PersistenceService.ts`
- `src/persistence/migrations.ts`
- `src/persistence/types.ts`
- `src/persistence/SessionRepository.ts`
- `src/persistence/ConversationEventRepository.ts`
- `src/persistence/GoalRepository.ts`
- `src/persistence/RunRepository.ts`
- `src/persistence/ToolExecutionRepository.ts`
- `src/persistence/ApprovalRepository.ts`
- `src/persistence/CheckpointCleanupRepository.ts`
- `src/persistence/RecoveryService.ts`
- `src/agent/AgentRuntime.ts`
- SQLite migration 1 containing the extension-owned tables
- Restart and migration integration test suites
- Packaging/rebuild script for the selected SQLite driver

## Open Decisions for the Implementation Spike

These are evidence gates, not unanswered product requirements:

1. Can the official `better-sqlite3` saver be packaged reliably for the supported VS Code targets?
2. Which `synchronous` policy provides the desired durability/performance balance for local agent work?
3. What exact Deep Agents/LangGraph invocation resumes a non-HITL interrupted run in the installed versions? Lock it with an integration test.
4. Can current built-in file tools be wrapped with a durable ledger cleanly, or must recovery conservatively classify an interrupted write/edit as `needs_review`?
5. What compatibility versioning is required when Deep Agents upgrades its state schema?

## Completion Criteria

- SQLite survives real Extension Host and VS Code restarts.
- Chat state is fully restored from extension tables.
- Agent graph state is restored from LangGraph checkpoints using stable thread IDs.
- Model switching does not fork or reset a conversation.
- Current todo state can be inspected through snapshots without becoming a competing source of truth.
- Interrupted runs are detected and classified.
- No potentially non-idempotent side effect is silently repeated.
- Schema migrations, native packaging, and crash recovery are covered by automated tests.
