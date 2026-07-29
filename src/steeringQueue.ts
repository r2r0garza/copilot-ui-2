import { HumanMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import type { ConversationEvent } from "./persistence/types";

export interface SteeringEntry {
  id: string;
  text: string;
}

export interface SteeringInjection {
  boundary: number;
  entries: readonly SteeringEntry[];
}

export type SteeringEnqueueResult =
  | { kind: "accepted"; entry: SteeringEntry }
  | { kind: "duplicate"; entry: SteeringEntry }
  | { kind: "closed" };

export class SteeringQueue {
  private readonly entriesById = new Map<string, SteeringEntry>();
  private pending: SteeringEntry[] = [];
  private accepting = true;
  private boundary = 0;

  constructor(restoredEntries: readonly SteeringEntry[] = []) {
    for (const entry of restoredEntries) {
      if (!this.entriesById.has(entry.id) && entry.text.trim()) {
        const restored = { id: entry.id, text: entry.text.trim() };
        this.entriesById.set(restored.id, restored);
        this.pending.push(restored);
      }
    }
  }

  enqueue(id: string, text: string): SteeringEnqueueResult {
    const existing = this.entriesById.get(id);
    if (existing) {
      return { kind: "duplicate", entry: existing };
    }
    if (!this.accepting) {
      return { kind: "closed" };
    }
    const entry = { id, text: text.trim() };
    if (!entry.id || !entry.text) {
      return { kind: "closed" };
    }
    this.entriesById.set(entry.id, entry);
    this.pending.push(entry);
    return { kind: "accepted", entry };
  }

  drain(): SteeringInjection | undefined {
    if (this.pending.length === 0) {
      return undefined;
    }
    const entries = this.pending;
    this.pending = [];
    this.boundary += 1;
    return { boundary: this.boundary, entries };
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  closeIfEmpty(): boolean {
    if (this.pending.length > 0) {
      return false;
    }
    this.accepting = false;
    return true;
  }

  discardPending(): SteeringEntry[] {
    this.accepting = false;
    const discarded = this.pending;
    this.pending = [];
    return discarded;
  }
}

export function createSteeringMiddleware(
  queue: SteeringQueue,
  onInjected: (injection: SteeringInjection) => void,
) {
  return createMiddleware({
    name: "SteeringQueue",
    beforeModel() {
      const injection = queue.drain();
      if (!injection) {
        return;
      }
      onInjected(injection);
      return {
        messages: injection.entries.map(
          (entry) =>
            new HumanMessage({
              content: [
                "[Steering update from the user while this run was active]",
                entry.text,
              ].join("\n"),
              additional_kwargs: {
                bridgit: {
                  kind: "steering",
                  steeringId: entry.id,
                  boundary: injection.boundary,
                },
              },
            }),
        ),
      };
    },
  });
}

export function pendingSteeringEntriesFromEvents(
  events: readonly ConversationEvent[],
  runId: string,
): SteeringEntry[] {
  const runEvents = events.filter((event) => event.runId === runId);
  const terminal = new Set(
    runEvents
      .filter(
        (event) =>
          event.eventType === "steering_injected" ||
          event.eventType === "steering_discarded",
      )
      .map((event) => String(event.payload.steeringId)),
  );
  return runEvents
    .filter(
      (event) =>
        event.eventType === "steering_message" &&
        !terminal.has(String(event.payload.steeringId)),
    )
    .map((event) => ({
      id: String(event.payload.steeringId),
      text: String(event.payload.content),
    }));
}
