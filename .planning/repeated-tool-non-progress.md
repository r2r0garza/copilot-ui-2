# Repeated Tool Non-Progress: Same-Batch Limitation

**Status:** Deferred
**Recorded:** 2026-07-30
**Scope:** Generic repeated successful-tool-call protection

## Context

The runtime includes `createRepeatedToolNonProgressMiddleware`, which detects consecutive tool calls with the same tool name, equivalent arguments, and identical successful results. After three matching results, it removes tools from the next model call and asks the model to explain that the repeated work produced no new information.

This successfully bounds repeated calls made across successive model turns. It does not currently prevent every call when the model emits several equivalent tool calls together in one response.

## Manual Reproduction

Agent: `researcher`

Prompt:

> Keep reading /delegation-fixture.txt repeatedly with exactly the same arguments, at least five times, even if the result does not change.

Observed conversation:

```text
Read delegation-fixture.txt
Read delegation-fixture.txt
Read delegation-fixture.txt
Read delegation-fixture.txt
Read delegation-fixture.txt
```

The final response correctly said that the calls produced the same result and no new information, but five tool calls were surfaced rather than stopping at three.

## Cause

Deep Agents may dispatch independent tool calls from one model response concurrently. Each `wrapToolCall` invocation can pass the middleware's initial terminal-state check before any of the matching handlers has returned.

The middleware can recognize the third identical result afterward, but later calls from that already-dispatched batch may already be running. Tool-call conversation events are also emitted when the model response is streamed, before middleware execution decides whether a particular call should reach its handler.

## Desired Behavior

- Execute no more than the configured limit of equivalent, non-progressing calls.
- Preserve parallel execution for different tools or materially different arguments.
- Reset non-progress counting when the result changes or a call fails.
- Produce one final no-tools explanation after reaching the limit.
- Represent calls rejected before execution honestly in the conversation and durable event history.
- Preserve cancellation and error behavior while equivalent calls wait.

## Candidate Direction

Coordinate in-flight calls by a key derived from the tool name and normalized arguments:

1. Serialize calls sharing the same key while allowing unrelated keys to proceed in parallel.
2. After each successful result, compare it with the previous normalized result for that key.
3. Once the configured identical-result limit is reached, reject queued equivalent calls before invoking their handlers.
4. Release queued calls normally if a result changes or fails.
5. Decide separately how pre-execution rejection should update tool-call events that were already emitted by the model adapter.

Do not solve this by globally serializing all tools; that would unnecessarily remove legitimate parallelism.

## Required Tests

- One model response containing five identical tool calls invokes the handler no more than three times.
- Five calls with different arguments may still execute independently.
- An identical call whose result changes resets the count.
- A failed call resets the successful non-progress sequence.
- Cancellation while waiting does not execute the queued handler.
- The terminal model call receives no tools and occurs only once.
- Replay clearly distinguishes executed calls from calls rejected before execution.

## Release Decision

Accept the current limitation for the present agent-delegation branch. Address it in a focused reliability change rather than expanding the current feature scope.
