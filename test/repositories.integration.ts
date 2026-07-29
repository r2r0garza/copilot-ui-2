import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistenceService } from "../src/persistence/PersistenceService";

function uri(fsPath: string) {
  return { fsPath, toString: () => `file://${fsPath}` };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "deepagents-repositories-"));
  const service = await PersistenceService.open(
    uri(join(root, "storage")),
    uri(join(root, "workspace")),
  );

  try {
    const first = service.sessions.create({
      id: "session-1",
      threadId: "thread-1",
      selectedModelKey: "copilot/model-a",
      selectedAgentId: "writer",
    });
    service.sessions.create({ id: "session-2", threadId: "thread-2" });
    service.sessions.rename(first.id, "Manual title");
    assert.equal(
      service.sessions.setGeneratedTitle(first.id, "Generated title"),
      false,
    );
    assert.equal(service.sessions.get(first.id)?.title, "Manual title");
    assert.equal(service.sessions.get(first.id)?.selectedAgentId, "writer");
    service.sessions.setAgent(first.id, "coder");
    assert.equal(service.sessions.get(first.id)?.selectedAgentId, "coder");

    service.conversationEvents.append({
      sessionId: first.id,
      eventType: "user_message",
      payload: { schemaVersion: 1, content: "hello" },
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    service.conversationEvents.append({
      sessionId: first.id,
      eventType: "assistant_message",
      payload: { schemaVersion: 1, content: "hi" },
      createdAt: "2026-07-28T12:00:01.000Z",
    });
    for (let index = 0; index < 20; index += 1) {
      service.conversationEvents.append({
        sessionId: first.id,
        eventType: "run_cancelled",
        payload: { schemaVersion: 1, reason: `fixture-${index}` },
      });
    }
    service.conversationEvents.append({
      sessionId: first.id,
      eventType: "steering_message",
      payload: {
        schemaVersion: 1,
        steeringId: "steer-1",
        content: "Persist this steering update.",
      },
    });
    service.conversationEvents.append({
      sessionId: first.id,
      eventType: "steering_injected",
      payload: {
        schemaVersion: 1,
        steeringId: "steer-1",
        boundary: 1,
      },
    });
    service.conversationEvents.append({
      sessionId: first.id,
      eventType: "steering_discarded",
      payload: {
        schemaVersion: 1,
        steeringId: "steer-2",
        reason: "cancelled",
      },
    });
    assert.deepEqual(
      service.conversationEvents.list(first.id).map((event) => event.sequence),
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    assert.equal(service.sessions.list()[0].id, first.id);

    const beforeInvalid = service.conversationEvents.list(first.id).length;
    assert.throws(() =>
      service.conversationEvents.append({
        sessionId: first.id,
        eventType: "assistant_message",
        payload: { schemaVersion: 1 },
      }),
    );
    assert.equal(
      service.conversationEvents.list(first.id).length,
      beforeInvalid,
    );

    const goalId = service.goals.create({
      sessionId: first.id,
      title: "Durable fixture",
      objective: "Prove the future-goal schema",
    });
    const { runId } = service.runs.start({
      sessionId: first.id,
      goalId,
      threadId: first.threadId,
      processInstanceId: "process-1",
      leaseExpiresAt: "2026-07-28T12:05:00.000Z",
    });
    service.runs.saveTodoSnapshot(runId, "checkpoint-1", [
      { content: "Persist state", status: "completed" },
      { content: "Resume state", status: "in_progress" },
    ]);
    service.toolExecutions.request({
      runId,
      toolCallId: "tool-1",
      toolName: "execute_command",
      arguments: { executable: "npm", args: ["test"] },
      inputHash: "fixture-hash",
      effectClass: "non_idempotent",
    });
    service.toolExecutions.transition(runId, "tool-1", "running");
    service.approvals.record({
      sessionId: first.id,
      runId,
      toolCallId: "tool-1",
      toolName: "execute_command",
      decision: "session",
      processInstanceId: "process-1",
    });

    const oldThread = service.sessions.clear(first.id, "thread-1-cleared");
    assert.equal(oldThread, "thread-1");
    assert.equal(service.conversationEvents.list(first.id).length, 0);
    assert.equal(service.sessions.get(first.id)?.title, "Manual title");
    assert.equal(
      service.sessions.get(first.id)?.selectedModelKey,
      "copilot/model-a",
    );
    assert.equal(service.sessions.get(first.id)?.selectedAgentId, "coder");
    assert.equal(service.approvals.countForSession(first.id), 1);
    assert.equal(service.checkpointCleanup.list()[0].threadId, "thread-1");

    service.sessions.markDeletingAndQueue(first.id);
    assert.equal(service.sessions.get(first.id)?.status, "deleting");
    service.sessions.hardDelete(first.id);
    assert.equal(service.sessions.get(first.id), undefined);
    assert.equal(service.approvals.countForSession(first.id), 0);

    const malformed = service.sessions.create({
      id: "malformed",
      threadId: "malformed-thread",
    });
    service.database.prepare(`
      INSERT INTO conversation_events (
        id, session_id, sequence, event_type, payload_json, created_at
      ) VALUES ('malformed-event', ?, 1, 'user_message', '{', 'now')
    `).run(malformed.id);
    assert.throws(() => service.conversationEvents.list(malformed.id));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }

  console.log(
    "Repository integration test passed: ordered events, title precedence, rollback, clear/delete retention, and future-run records",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
