export type TitleSource = "default" | "generated" | "manual";
export type SessionStatus = "active" | "archived" | "deleting";
export type ConversationEventType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "approval_requested"
  | "approval_resolved"
  | "run_error"
  | "run_cancelled"
  | "model_changed"
  | "title_changed";

export interface ChatSession {
  id: string;
  threadId: string;
  checkpointNamespace: string;
  title: string;
  titleSource: TitleSource;
  selectedModelKey: string | null;
  selectedAgentId: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastEventAt: string;
}

export interface EventPayload {
  schemaVersion: 1;
  [key: string]: unknown;
}

export interface ConversationEvent {
  id: string;
  sessionId: string;
  runId: string | null;
  sequence: number;
  eventType: ConversationEventType;
  payload: EventPayload;
  createdAt: string;
}

const REQUIRED_STRING_FIELDS: Partial<
  Record<ConversationEventType, readonly string[]>
> = {
  user_message: ["content"],
  assistant_message: ["content"],
  tool_call: ["toolCallId", "toolName"],
  tool_result: ["toolCallId"],
  approval_requested: ["requestId", "toolName"],
  approval_resolved: ["requestId", "decision"],
  run_error: ["message"],
  model_changed: ["modelKey"],
  title_changed: ["title"],
};

export function validateEventPayload(
  eventType: ConversationEventType,
  value: unknown,
): EventPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${eventType} payload: expected an object.`);
  }
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== 1) {
    throw new Error(
      `Unsupported ${eventType} payload schema version: ${String(payload.schemaVersion)}.`,
    );
  }
  for (const field of REQUIRED_STRING_FIELDS[eventType] ?? []) {
    if (typeof payload[field] !== "string") {
      throw new Error(
        `Invalid ${eventType} payload: "${field}" must be a string.`,
      );
    }
  }
  return payload as EventPayload;
}
