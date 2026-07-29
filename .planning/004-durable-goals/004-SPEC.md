# Phase 004: Durable Goal Orchestration — Specification

**Created:** 2026-07-29
**Ambiguity score:** 0.14 (gate: ≤ 0.20)
**Requirements:** 10 locked

## Goal

A user can submit `/goal <objective>` from any chat and receive a workspace-durable, dependency-aware goal that starts or queues unambiguously, resumes safely after restart, reports its state in a GOALS view, and identifies every conversation with actively executing agent work.

## Background

The persistence foundation already stores goals, logical runs, attempts, checkpoints, todo projections, approvals, and tool-execution records. It proves that one logical goal run can resume through multiple attempts without replacing its LangGraph thread.

No user-facing goal command or scheduler exists today. Every submitted message follows the ordinary chat path, and the workbench owns a single panel-wide `running` flag. While any run is active, the user cannot switch conversations or start work elsewhere. Sessions do not expose per-conversation activity, and there is no workspace-level view of goal status or dependencies.

This phase turns the existing durable schema into an explicit goal workflow. Durable goal execution remains local to the active VS Code workspace and Extension Host.

## Requirements

1. **Explicit slash command**: A trimmed message beginning with the exact command `/goal` and followed by a non-empty objective creates a durable goal rather than an ordinary chat turn.
   - Current: All non-empty composer submissions are ordinary chat prompts.
   - Target: `/goal <objective>` records the objective verbatim after trimming, links the goal to the originating conversation, snapshots that conversation's selected agent and model, assigns a dedicated goal thread, and immediately enters dependency analysis. `/goal` without an objective is rejected without creating a goal.
   - Acceptance: Submitting `/goal Update the persistence documentation` creates one goal linked to the active session with that objective and a thread different from the chat thread; submitting `/goal` creates no goal and displays a validation error.

2. **Single workspace goal slot**: At most one durable goal executes in a workspace at a time.
   - Current: There is no goal scheduler, and one panel-wide flag serializes all chat activity.
   - Target: A ready goal starts immediately when the workspace goal slot is free. Other durable goals remain queued or blocked. Ordinary chat turns in other conversations may execute concurrently, while the originating conversation's composer steers its actively running goal instead of starting a competing turn.
   - Acceptance: With Goal A running, submitting Goal B persists B without starting a second goal attempt; an ordinary turn in a different conversation can run; composer input in A's originating conversation is delivered as steering to A.

3. **Dependency-aware scheduling**: Goal order is determined by a persisted acyclic dependency graph, not FIFO alone.
   - Current: Goals have no dependency relationships or readiness calculation.
   - Target: A goal is ready only when every dependency is completed and it is not awaiting dependency review. The scheduler selects from ready goals; submission order and optional manual ordering only break ties between simultaneously ready goals.
   - Acceptance: For dependencies A → C → B, execution order is A, C, B even when B was submitted before C; B never starts while A or C is incomplete.

4. **Safe dependency inference**: The orchestrator analyzes each new goal against existing workspace goals and persists only dependency changes it can determine confidently.
   - Current: No goal-dependency analysis occurs.
   - Target: Analysis may add dependencies to the new goal and retroactively add or remove dependencies on queued goals. It never rewrites dependencies of a running goal. Every inferred edge is visible and editable in GOALS. When the orchestrator is unsure, it pauses goal admission and asks the user to resolve the proposed relationship rather than guessing.
   - Acceptance: When A exists and queued B depends on A, submitting C that is required between them can produce A → C → B; a deliberately ambiguous fixture requests user confirmation; a running goal's dependency set is unchanged.

5. **Cycle and dependency-failure safety**: Invalid or unsatisfied dependency graphs fail closed.
   - Current: No dependency cycles or propagation rules exist.
   - Target: A proposed cycle is rejected for user review. If a dependency fails or is cancelled, each dependent goal becomes blocked and cannot start. Cancelling/removing the failed dependency or removing an edge does not automatically release the dependent goal: the user must explicitly select **Continue** after verifying that required artifacts or side effects exist.
   - Acceptance: A proposed A → B → A cycle starts neither goal; failure of A blocks B; changing A or the A → B edge leaves B blocked until the user selects **Continue**.

6. **Safe restart continuation**: Workspace activation resumes only goals already classified `safe_to_resume`.
   - Current: Startup classifies interrupted attempts but does not schedule durable goals.
   - Target: A safe interrupted goal automatically reacquires the single workspace goal slot and resumes its existing logical run and goal thread. A goal waiting for approval or uncertain-side-effect reconciliation remains paused, occupies the goal slot, and requires user action in its originating conversation. Queued goals do not bypass it.
   - Acceptance: Restarting during a checkpoint-safe goal creates a new attempt for the same run and thread; restarting at approval or uncertain execution starts no new tool execution and no queued goal.

7. **Workspace GOALS view**: The workbench exposes CHAT and GOALS modes while keeping the session list visible.
   - Current: The sidebar heading is SESSIONS and the main area always displays the selected chat.
   - Target: The heading becomes **CHAT** with **GOALS** beside it. Selecting GOALS replaces the main chat area with a workspace goal list without hiding the session list. Each goal displays its objective/title, originating conversation, effective status, dependencies, and required action. Queued and active goals can be cancelled; inferred dependencies are reviewable and editable; audit records are never hard-deleted from this view.
   - Acceptance: Switching CHAT → GOALS leaves all session rows visible and renders queued, running, blocked, completed, failed, and cancelled fixtures with correct dependency information and available controls.

8. **Goal-to-conversation navigation**: Selecting a goal returns the user to its execution context.
   - Current: No goal navigation exists.
   - Target: Clicking a goal switches to CHAT, selects its originating conversation, and scrolls/focuses the transcript at the goal's first event so the user can inspect subsequent model output, tool calls, approvals, and recovery activity.
   - Acceptance: Clicking a goal originating in a non-selected conversation activates that conversation and positions the goal's first event in view.

9. **Per-conversation activity spinner**: Session titles independently indicate active agent execution.
   - Current: A panel-wide running state controls the composer, and session rows have no activity state.
   - Target: A spinner appears beside every conversation with an actively executing ordinary turn or durable goal. Multiple conversations can show spinners when ordinary work and the workspace goal run concurrently. Queued, blocked, waiting, completed, failed, and cancelled work does not show the active spinner.
   - Acceptance: Starting work in two eligible conversations displays two spinners; completing one removes only its spinner; restoring queued or blocked goals displays no spinner until execution begins.

10. **Non-disruptive transcript following**: New goal or chat activity does not steal a reader's scroll position.
    - Current: The workbench has no explicit away-from-bottom control.
    - Target: When the selected transcript is not at the bottom, incoming activity preserves the current scroll position and displays a floating **Jump to bottom** button. Selecting it scrolls to the latest event and hides the button. The button also appears whenever the user manually scrolls away from the bottom.
    - Acceptance: While reading older content, append multiple streamed and tool events without changing the visible position; verify the button appears, scrolls to the final event when selected, and disappears at the bottom.

## Boundaries

**In scope:**

- `/goal <objective>` parsing, validation, durable creation, and immediate admission.
- One workspace-wide durable-goal execution slot.
- Concurrent ordinary chat turns in other conversations.
- Dedicated goal threads linked to originating conversations.
- Dependency inference, uncertain-relationship review, persisted DAG validation, and readiness scheduling.
- Retroactive dependency changes for queued goals only.
- Explicit blocked-goal continuation after dependency failure or cancellation.
- Safe automatic restart continuation.
- CHAT/GOALS workbench modes and goal lifecycle controls.
- Per-conversation active spinners.
- Goal-to-transcript navigation and Jump to bottom behavior.
- Durable audit retention for cancelled, failed, and completed goals.

**Out of scope:**

- More than one concurrently executing durable goal per workspace — excluded to reduce workspace file-edit collisions.
- Rewriting dependencies of a running goal — excluded because execution may already rely on the original graph.
- Automatically guessing low-confidence dependency relationships — user confirmation is required.
- Automatically releasing dependents after a failed/cancelled prerequisite or edited dependency — explicit Continue is required.
- Hard deletion of goal/dependency audit history from GOALS — cancellation preserves recovery evidence.
- Execution while VS Code, the Extension Host, or the computer is off — continuation occurs on workspace activation.
- Cloud synchronization, multi-device execution, or cross-workspace scheduling — goals remain workspace-scoped.
- Cross-workspace dependency edges — the scheduler has authority only over the current workspace database.

## Constraints

- Dependency relationships must remain acyclic and durably queryable after restart.
- Dependency inference must not start a goal until confident edges are persisted or uncertain edges are resolved by the user.
- The existing side-effect ledger, approval expiration, and recovery classifications remain authoritative.
- A goal uses the originating conversation's agent/model selection captured at submission and a separate stable LangGraph thread.
- Waiting approval and uncertain execution retain the single workspace goal slot.
- The session list must remain interactive while work runs; controls are disabled only when their specific session/goal state makes the action unsafe.
- Desktop VS Code support remains macOS, Windows, and Linux with the current first-workspace-root boundary.

## Acceptance Criteria

- [ ] `/goal <objective>` creates exactly one durable, session-linked goal with a dedicated thread; blank objectives are rejected.
- [ ] No workspace can have more than one executing durable goal attempt.
- [ ] Ordinary turns in other conversations can execute concurrently with the durable goal.
- [ ] Dependency readiness produces A → C → B when B depends on both preceding outcomes.
- [ ] Low-confidence dependency analysis asks the user instead of persisting a guessed edge.
- [ ] Dependency inference may revise queued goals but never a running goal.
- [ ] Cycles are rejected before execution.
- [ ] Failed/cancelled dependencies block dependents until an explicit Continue action.
- [ ] Only `safe_to_resume` goals automatically resume after workspace activation.
- [ ] Waiting approval or uncertain review occupies the goal slot and prevents queued goals from bypassing it.
- [ ] GOALS displays statuses, origins, dependencies, and valid controls without hiding the session list.
- [ ] Clicking a goal returns to its originating transcript at the goal's first event.
- [ ] Session spinners independently reflect active work in each conversation.
- [ ] Jump to bottom preserves manual scroll position until explicitly selected.
- [ ] Cancelling a goal preserves its goal, run, dependency, tool, and approval audit records.

## Ambiguity Report

| Dimension | Score | Min | Status | Notes |
|---|---:|---:|:---:|---|
| Goal Clarity | 0.95 | 0.75 | ✓ | Slash command, scheduler outcome, and UI are explicit |
| Boundary Clarity | 0.82 | 0.70 | ✓ | Concurrency and deferred cross-workspace behavior are bounded |
| Constraint Clarity | 0.79 | 0.65 | ✓ | Dependency mutation, blocked-slot, and restart rules are locked |
| Acceptance Criteria | 0.86 | 0.70 | ✓ | Fifteen pass/fail criteria cover command, scheduler, and UI |
| **Ambiguity** | **0.14** | **≤0.20** | **✓** | Ready for implementation discussion and planning |

## Interview Log

| Round | Perspective | Question summary | Decision locked |
|---:|---|---|---|
| 1 | Researcher | How should goals execute and survive restart? | `/goal` starts immediately when eligible; safe goals auto-resume; goals use dedicated threads linked to their origin chat |
| 1 | Researcher | How should active conversations be identified? | Per-session title spinners identify actively executing work |
| 2 | Simplifier | Is scheduling FIFO and what happens while blocked? | One workspace goal slot; blocked approval/review retains it; goal click returns to its originating transcript |
| 3 | Boundary Keeper | Are dependencies part of v0.1? | Yes; scheduler uses inferred dependencies rather than requiring manual queue ordering |
| 3 | Boundary Keeper | What goal and scroll controls are required? | GOALS supports cancellation; Jump to bottom preserves reader position |
| 4 | Failure Analyst | How much authority does inference have? | Confident edges persist visibly; uncertainty asks the user; queued dependencies may change, running dependencies may not |
| 4 | Failure Analyst | What happens after dependency failure/cancellation? | Dependents remain blocked and require explicit Continue even after graph edits |
| Gate | Seed Closer | Remaining composer and retention defaults | Origin composer steers its goal; other chats may run; goal audit is never hard-deleted |

---

*Phase: 004-durable-goals*
*Spec created: 2026-07-29*
*Next step: implementation discussion and planning; do not implement directly from this specification*
