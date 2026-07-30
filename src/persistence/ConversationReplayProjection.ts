import type { ConversationEvent } from "./types";

interface ReplayItemBase {
  eventId: string;
  runId: string | null;
  sequence: number;
  createdAt: string;
}

export interface MessageReplayItem extends ReplayItemBase {
  kind: "message";
  role: "user" | "assistant";
  content: string;
}

export interface ToolCallReplayItem extends ReplayItemBase {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  label: string | null;
  collapsed: true;
}

export interface ToolResultReplayItem extends ReplayItemBase {
  kind: "tool_result";
  toolCallId: string;
  toolName: string | null;
  output: unknown;
  label: string | null;
  orphaned: boolean;
  collapsed: true;
  truncation: {
    truncated: boolean;
    persistedLength: number | null;
    originalLength: number | null;
  };
}

export interface ApprovalRequestedReplayItem extends ReplayItemBase {
  kind: "approval_requested";
  requestId: string;
  toolName: string;
  input: unknown;
  status: "pending" | "resolved";
  decision: string | null;
  interaction: "informational";
  grantsAuthority: false;
  executesTool: false;
}

export interface ApprovalResolvedReplayItem extends ReplayItemBase {
  kind: "approval_resolved";
  requestId: string;
  decision: string;
  toolName: string | null;
  orphaned: boolean;
  interaction: "informational";
  grantsAuthority: false;
  executesTool: false;
}

export interface RunStatusReplayItem extends ReplayItemBase {
  kind: "run_status";
  status: "error" | "cancelled";
  message: string;
}

export interface SteeringReplayItem extends ReplayItemBase {
  kind: "steering_message";
  steeringId: string;
  content: string;
  status: "queued" | "injected" | "discarded";
  discardReason: string | null;
}

export type ConversationReplayItem =
  | MessageReplayItem
  | ToolCallReplayItem
  | ToolResultReplayItem
  | ApprovalRequestedReplayItem
  | ApprovalResolvedReplayItem
  | SteeringReplayItem
  | RunStatusReplayItem;

interface ApprovalResolution {
  decision: string;
}

/**
 * Builds inert workbench history from the append-only conversation event log.
 *
 * Approval items deliberately contain no callback or resumable action. Persisted
 * approval decisions are history, not authority, and a pending request only says
 * that the user was previously asked.
 */
export function projectConversationEvents(
  events: readonly ConversationEvent[],
): ConversationReplayItem[] {
  const orderedEvents = events
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort(
      (left, right) =>
        left.event.sequence - right.event.sequence ||
        left.inputIndex - right.inputIndex,
    )
    .map(({ event }) => event);

  const approvalResolutions = new Map<string, ApprovalResolution>();
  const steeringOutcomes = new Map<
    string,
    { status: "injected" | "discarded"; reason: string | null }
  >();
  for (const event of orderedEvents) {
    if (event.eventType === "approval_resolved") {
      approvalResolutions.set(
        stringValue(event.payload.requestId),
        { decision: stringValue(event.payload.decision) },
      );
    } else if (event.eventType === "steering_injected") {
      steeringOutcomes.set(stringValue(event.payload.steeringId), {
        status: "injected",
        reason: null,
      });
    } else if (event.eventType === "steering_discarded") {
      steeringOutcomes.set(stringValue(event.payload.steeringId), {
        status: "discarded",
        reason: nullableString(event.payload.reason),
      });
    }
  }

  const calls = new Map<
    string,
    { toolName: string; label: string | null }
  >();
  const completedToolCalls = new Set<string>();
  const approvalRequests = new Map<string, { toolName: string }>();
  const items: ConversationReplayItem[] = [];

  for (const event of orderedEvents) {
    const base: ReplayItemBase = {
      eventId: event.id,
      runId: event.runId,
      sequence: event.sequence,
      createdAt: event.createdAt,
    };

    switch (event.eventType) {
      case "user_message":
      case "assistant_message":
        items.push({
          ...base,
          kind: "message",
          role: event.eventType === "user_message" ? "user" : "assistant",
          content: stringValue(event.payload.content),
        });
        break;

      case "tool_call": {
        const toolCallId = stringValue(event.payload.toolCallId);
        const toolName = stringValue(event.payload.toolName);
        const label = nullableString(event.payload.label);
        calls.set(toolCallId, { toolName, label });
        completedToolCalls.delete(toolCallId);
        items.push({
          ...base,
          kind: "tool_call",
          toolCallId,
          toolName,
          input: event.payload.input,
          label,
          collapsed: true,
        });
        break;
      }

      case "tool_result": {
        const toolCallId = stringValue(event.payload.toolCallId);
        if (completedToolCalls.has(toolCallId)) {
          break;
        }
        completedToolCalls.add(toolCallId);
        const call = calls.get(toolCallId);
        const output = event.payload.output;
        items.push({
          ...base,
          kind: "tool_result",
          toolCallId,
          toolName: call?.toolName ?? null,
          output,
          label: nullableString(event.payload.label) ?? call?.label ?? null,
          orphaned: call === undefined,
          collapsed: true,
          truncation: {
            truncated: event.payload.truncated === true,
            persistedLength: serializedLength(output),
            originalLength: nonNegativeInteger(event.payload.originalLength),
          },
        });
        break;
      }

      case "approval_requested": {
        const requestId = stringValue(event.payload.requestId);
        const toolName = stringValue(event.payload.toolName);
        const resolution = approvalResolutions.get(requestId);
        approvalRequests.set(requestId, { toolName });
        items.push({
          ...base,
          kind: "approval_requested",
          requestId,
          toolName,
          input: event.payload.input,
          status: resolution ? "resolved" : "pending",
          decision: resolution?.decision ?? null,
          interaction: "informational",
          grantsAuthority: false,
          executesTool: false,
        });
        break;
      }

      case "approval_resolved": {
        const requestId = stringValue(event.payload.requestId);
        const request = approvalRequests.get(requestId);
        items.push({
          ...base,
          kind: "approval_resolved",
          requestId,
          decision: stringValue(event.payload.decision),
          toolName: request?.toolName ?? null,
          orphaned: request === undefined,
          interaction: "informational",
          grantsAuthority: false,
          executesTool: false,
        });
        break;
      }

      case "steering_message": {
        const steeringId = stringValue(event.payload.steeringId);
        const outcome = steeringOutcomes.get(steeringId);
        items.push({
          ...base,
          kind: "steering_message",
          steeringId,
          content: stringValue(event.payload.content),
          status: outcome?.status ?? "queued",
          discardReason: outcome?.reason ?? null,
        });
        break;
      }

      case "steering_injected":
      case "steering_discarded":
        break;

      case "run_error":
        items.push({
          ...base,
          kind: "run_status",
          status: "error",
          message: stringValue(event.payload.message),
        });
        break;

      case "run_cancelled":
        items.push({
          ...base,
          kind: "run_status",
          status: "cancelled",
          message: stringValue(event.payload.reason, "Cancelled."),
        });
        break;
    }
  }

  return items;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function serializedLength(value: unknown): number | null {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value)?.length ?? null;
  } catch {
    return null;
  }
}
