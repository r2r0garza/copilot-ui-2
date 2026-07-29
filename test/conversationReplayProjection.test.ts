import assert from "node:assert/strict";
import {
  projectConversationEvents,
  type ConversationReplayItem,
} from "../src/persistence/ConversationReplayProjection";
import type {
  ConversationEvent,
  ConversationEventType,
  EventPayload,
} from "../src/persistence/types";

function event(
  sequence: number,
  eventType: ConversationEventType,
  payload: EventPayload,
): ConversationEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    runId: "run-1",
    sequence,
    eventType,
    payload,
    createdAt: `2026-07-28T12:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

function byKind<K extends ConversationReplayItem["kind"]>(
  items: ConversationReplayItem[],
  kind: K,
): Extract<ConversationReplayItem, { kind: K }>[] {
  return items.filter(
    (item): item is Extract<ConversationReplayItem, { kind: K }> =>
      item.kind === kind,
  );
}

const events = [
  event(8, "run_cancelled", {
    schemaVersion: 1,
    reason: "Cancelled by user.",
  }),
  event(2, "tool_call", {
    schemaVersion: 1,
    toolCallId: "call-1",
    toolName: "execute_command",
    input: { executable: "npm", args: ["test"] },
    label: "Ran npm test",
  }),
  event(1, "user_message", {
    schemaVersion: 1,
    content: "Run the tests",
  }),
  event(3, "tool_result", {
    schemaVersion: 1,
    toolCallId: "call-1",
    output: "x".repeat(100),
    truncated: true,
    originalLength: 150,
  }),
  event(4, "approval_requested", {
    schemaVersion: 1,
    requestId: "approval-1",
    toolName: "write_file",
    input: { path: "README.md" },
  }),
  event(5, "approval_resolved", {
    schemaVersion: 1,
    requestId: "approval-1",
    decision: "session",
  }),
  event(6, "assistant_message", {
    schemaVersion: 1,
    content: "Done",
  }),
  event(7, "run_error", {
    schemaVersion: 1,
    message: "The follow-up failed.",
  }),
  event(9, "model_changed", {
    schemaVersion: 1,
    modelKey: "vendor:model",
  }),
  event(10, "steering_message", {
    schemaVersion: 1,
    steeringId: "steer-1",
    content: "Focus on the unit tests.",
  }),
  event(11, "steering_injected", {
    schemaVersion: 1,
    steeringId: "steer-1",
    boundary: 1,
  }),
  event(12, "steering_message", {
    schemaVersion: 1,
    steeringId: "steer-2",
    content: "Ignore this late update.",
  }),
  event(13, "steering_discarded", {
    schemaVersion: 1,
    steeringId: "steer-2",
    reason: "cancelled",
  }),
];

const projected = projectConversationEvents(events);
assert.deepEqual(
  projected.map((item) => item.sequence),
  [1, 2, 3, 4, 5, 6, 7, 8, 10, 12],
  "projected activity is ordered by persisted sequence",
);
const steering = byKind(projected, "steering_message");
assert.deepEqual(
  steering.map(({ content, status, discardReason }) => ({
    content,
    status,
    discardReason,
  })),
  [
    {
      content: "Focus on the unit tests.",
      status: "injected",
      discardReason: null,
    },
    {
      content: "Ignore this late update.",
      status: "discarded",
      discardReason: "cancelled",
    },
  ],
);
assert.deepEqual(
  byKind(projected, "message").map(({ role, content }) => ({ role, content })),
  [
    { role: "user", content: "Run the tests" },
    { role: "assistant", content: "Done" },
  ],
);

const [toolCall] = byKind(projected, "tool_call");
assert.equal(toolCall.collapsed, true);
assert.deepEqual(toolCall.input, {
  executable: "npm",
  args: ["test"],
});

const [toolResult] = byKind(projected, "tool_result");
assert.equal(toolResult.collapsed, true);
assert.equal(toolResult.orphaned, false);
assert.equal(toolResult.toolName, "execute_command");
assert.deepEqual(toolResult.truncation, {
  truncated: true,
  persistedLength: 100,
  originalLength: 150,
});

const [approvalRequest] = byKind(projected, "approval_requested");
assert.equal(approvalRequest.status, "resolved");
assert.equal(approvalRequest.decision, "session");
assert.equal(approvalRequest.interaction, "informational");
assert.equal(approvalRequest.grantsAuthority, false);
assert.equal(approvalRequest.executesTool, false);

const [approvalResolution] = byKind(projected, "approval_resolved");
assert.equal(approvalResolution.orphaned, false);
assert.equal(approvalResolution.toolName, "write_file");
assert.equal(approvalResolution.interaction, "informational");
assert.equal(approvalResolution.grantsAuthority, false);
assert.equal(approvalResolution.executesTool, false);

assert.deepEqual(
  byKind(projected, "run_status").map(({ status, message }) => ({
    status,
    message,
  })),
  [
    { status: "error", message: "The follow-up failed." },
    { status: "cancelled", message: "Cancelled by user." },
  ],
);

const edgeCases = projectConversationEvents([
  event(1, "tool_result", {
    schemaVersion: 1,
    toolCallId: "missing-call",
    output: { safe: true },
    truncated: false,
  }),
  event(2, "approval_requested", {
    schemaVersion: 1,
    requestId: "still-pending",
    toolName: "edit_file",
    input: { path: "src/index.ts" },
  }),
  event(3, "approval_resolved", {
    schemaVersion: 1,
    requestId: "missing-request",
    decision: "deny",
  }),
  event(4, "run_cancelled", { schemaVersion: 1 }),
]);

const [orphanResult] = byKind(edgeCases, "tool_result");
assert.equal(orphanResult.orphaned, true);
assert.equal(orphanResult.toolName, null);
assert.deepEqual(orphanResult.output, { safe: true });
assert.deepEqual(orphanResult.truncation, {
  truncated: false,
  persistedLength: 13,
  originalLength: null,
});

const [pendingApproval] = byKind(edgeCases, "approval_requested");
assert.equal(pendingApproval.status, "pending");
assert.equal(pendingApproval.decision, null);
assert.equal(pendingApproval.interaction, "informational");
assert.equal(pendingApproval.grantsAuthority, false);
assert.equal(pendingApproval.executesTool, false);

const [orphanResolution] = byKind(edgeCases, "approval_resolved");
assert.equal(orphanResolution.orphaned, true);
assert.equal(orphanResolution.toolName, null);
assert.equal(orphanResolution.grantsAuthority, false);
assert.equal(orphanResolution.executesTool, false);

assert.deepEqual(byKind(edgeCases, "run_status")[0], {
  eventId: "event-4",
  runId: "run-1",
  sequence: 4,
  createdAt: "2026-07-28T12:00:04.000Z",
  kind: "run_status",
  status: "cancelled",
  message: "Cancelled.",
});

assert.deepEqual(
  events.map((item) => item.sequence),
  [8, 2, 1, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13],
);

console.log(
  "Conversation replay projection test passed: ordered inert history, collapsed tools, orphan safety, statuses, and truncation metadata",
);
