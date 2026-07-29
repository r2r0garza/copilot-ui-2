import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import {
  createSteeringMiddleware,
  pendingSteeringEntriesFromEvents,
  SteeringQueue,
  type SteeringInjection,
} from "../src/steeringQueue";
import type {
  ConversationEvent,
  ConversationEventType,
} from "../src/persistence/types";

async function main(): Promise<void> {
  const queue = new SteeringQueue();
  assert.equal(queue.enqueue("one", " first ").kind, "accepted");
  assert.equal(queue.enqueue("two", "second").kind, "accepted");
  assert.equal(queue.enqueue("one", "changed").kind, "duplicate");

  const injections: SteeringInjection[] = [];
  const middleware = createSteeringMiddleware(
    queue,
    (injection) => injections.push(injection),
  );
  assert.ok(middleware.beforeModel);
  assert.equal(typeof middleware.beforeModel, "function");
  const beforeModel = middleware.beforeModel as Exclude<
    typeof middleware.beforeModel,
    { hook: unknown } | undefined
  >;
  const update = await beforeModel(
    { messages: [] } as never,
    {} as never,
  );
  const messages = (update as { messages: HumanMessage[] }).messages;
  assert.deepEqual(
    messages.map((message) => String(message.content)),
    [
      "[Steering update from the user while this run was active]\nfirst",
      "[Steering update from the user while this run was active]\nsecond",
    ],
  );
  assert.deepEqual(
    injections[0]?.entries.map((entry) => entry.id),
    ["one", "two"],
    "one safe model boundary drains all queued entries in FIFO order",
  );
  assert.equal(queue.hasPending(), false);
  assert.equal(queue.closeIfEmpty(), true);
  assert.equal(queue.enqueue("three", "late").kind, "closed");

  const restored = new SteeringQueue([
    { id: "restored-1", text: "resume me" },
    { id: "restored-1", text: "duplicate" },
  ]);
  assert.equal(restored.hasPending(), true);
  assert.deepEqual(
    restored.discardPending(),
    [{ id: "restored-1", text: "resume me" }],
  );
  assert.equal(restored.enqueue("restored-2", "too late").kind, "closed");

  const events = [
    steeringEvent(1, "steering_message", {
      steeringId: "already-injected",
      content: "done",
    }),
    steeringEvent(2, "steering_injected", {
      steeringId: "already-injected",
    }),
    steeringEvent(3, "steering_message", {
      steeringId: "still-pending",
      content: "resume after restart",
    }),
    steeringEvent(4, "steering_message", {
      steeringId: "discarded",
      content: "do not resume",
    }),
    steeringEvent(5, "steering_discarded", {
      steeringId: "discarded",
      reason: "cancelled",
    }),
  ];
  assert.deepEqual(
    pendingSteeringEntriesFromEvents(events, "run-1"),
    [{ id: "still-pending", text: "resume after restart" }],
    "restart restoration includes only accepted steering without a terminal outcome",
  );

  console.log(
    "Steering queue test passed: FIFO drain, duplicate safety, close, restore, and discard contracts",
  );
}

function steeringEvent(
  sequence: number,
  eventType: ConversationEventType,
  payload: Record<string, unknown>,
): ConversationEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    runId: "run-1",
    sequence,
    eventType,
    payload: { schemaVersion: 1, ...payload },
    createdAt: `2026-07-29T12:00:0${sequence}.000Z`,
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
