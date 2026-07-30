import { createHash } from "node:crypto";
import { ToolMessage } from "@langchain/core/messages";
import {
  Command,
  isCommand,
  isGraphInterrupt,
} from "@langchain/langgraph";
import { createMiddleware, type ToolCallRequest } from "langchain";
import {
  ToolExecutionBlockedError,
  ToolExecutionIntegrityError,
  type ToolExecutionRecord,
  type ToolEffectClass,
  type ToolExecutionRepository,
} from "./persistence/ToolExecutionRepository";

const READ_ONLY_TOOLS = new Set(["ls", "read_file", "glob", "grep"]);

export function classifyToolEffect(toolName: string): ToolEffectClass {
  return READ_ONLY_TOOLS.has(toolName) ? "read_only" : "non_idempotent";
}

export function hashToolInput(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function matchPendingApprovalToolCallIds(
  durableCalls: readonly ToolExecutionRecord[],
  actions: readonly {
    name: string;
    args: Record<string, unknown>;
  }[],
): string[] {
  const used = new Set<string>();
  const pendingCalls = durableCalls.filter(
    (toolCall) =>
      toolCall.status === "requested" ||
      toolCall.status === "waiting_approval",
  );
  return actions.map((action) => {
    const inputHash = hashToolInput(action.args);
    for (const toolCall of pendingCalls) {
      if (
        !used.has(toolCall.toolCallId) &&
        toolCall.toolName === action.name &&
        toolCall.inputHash === inputHash
      ) {
        used.add(toolCall.toolCallId);
        return toolCall.toolCallId;
      }
    }
    throw new Error(
      `Could not correlate approval action "${action.name}" with a pending durable tool call.`,
    );
  });
}

export function createToolExecutionLedgerMiddleware(input: {
  repository: ToolExecutionRepository;
  runId: string;
}) {
  return createMiddleware({
    name: "ToolExecutionLedger",
    wrapToolCall: async (request, handler) => {
      const toolCall = request.toolCall;
      const toolCallId = requireToolCallId(toolCall.id);
      const inputHash = hashToolInput(toolCall.args);
      input.repository.request({
        runId: input.runId,
        toolCallId,
        toolName: toolCall.name,
        arguments: toolCall.args,
        inputHash,
        effectClass: classifyToolEffect(toolCall.name),
      });

      try {
        const preparation = input.repository.prepareExecution(
          input.runId,
          toolCallId,
          toolCall.name,
          inputHash,
        );
        if (preparation.kind === "replay") {
          return decodeToolResult(preparation.record.output, toolCall);
        }
        const result = await handler(request);
        input.repository.transition(
          input.runId,
          toolCallId,
          "succeeded",
          encodeToolResult(result),
        );
        return result;
      } catch (error) {
        if (isGraphInterrupt(error)) {
          // An approval interrupt is control flow, not a tool failure. The graph
          // will restart this wrapper when it resumes, so return the durable
          // record to a retryable state and allow the interrupt to bubble up.
          input.repository.transition(
            input.runId,
            toolCallId,
            "requested",
          );
          throw error;
        }
        if (
          error instanceof ToolExecutionIntegrityError ||
          error instanceof ToolExecutionBlockedError
        ) {
          return errorToolMessage(request, error.message);
        }
        const result = errorToolMessage(request, formatError(error));
        input.repository.transition(
          input.runId,
          toolCallId,
          "failed",
          encodeToolResult(result),
        );
        return result;
      }
    },
  });
}

type EncodedToolResult =
  | {
      kind: "tool_message";
      content: ToolMessage["content"];
      toolCallId: string;
      name?: string;
      status?: "success" | "error";
      artifact?: unknown;
      metadata?: Record<string, unknown>;
      additionalKwargs: Record<string, unknown>;
      responseMetadata: Record<string, unknown>;
      id?: string;
    }
  | {
      kind: "command";
      graph?: string;
      update?: unknown;
      resume?: unknown;
      goto?: unknown;
    };

export function encodeToolResult(result: ToolMessage | Command): EncodedToolResult {
  if (ToolMessage.isInstance(result)) {
    return {
      kind: "tool_message",
      content: result.content,
      toolCallId: result.tool_call_id,
      ...(result.name === undefined ? {} : { name: result.name }),
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      additionalKwargs: result.additional_kwargs,
      responseMetadata: result.response_metadata,
      ...(result.id === undefined ? {} : { id: result.id }),
    };
  }
  if (isCommand(result)) {
    return {
      kind: "command",
      ...(result.graph === undefined ? {} : { graph: result.graph }),
      ...(result.update === undefined
        ? {}
        : { update: encodeNestedValue(result.update) }),
      ...(result.resume === undefined
        ? {}
        : { resume: encodeNestedValue(result.resume) }),
      ...(result.goto === undefined
        ? {}
        : { goto: encodeNestedValue(result.goto) }),
    };
  }
  throw new ToolExecutionIntegrityError("Unsupported durable tool result.");
}

function decodeToolResult(
  value: unknown,
  toolCall: ToolCallRequest["toolCall"],
): ToolMessage | Command {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    throw new ToolExecutionIntegrityError(
      `Tool call "${toolCall.id}" has an invalid durable result.`,
    );
  }
  const encoded = value as EncodedToolResult;
  if (encoded.kind === "tool_message") {
    return new ToolMessage({
      content: encoded.content,
      tool_call_id: encoded.toolCallId,
      ...(encoded.name === undefined ? {} : { name: encoded.name }),
      ...(encoded.status === undefined ? {} : { status: encoded.status }),
      ...(encoded.artifact === undefined ? {} : { artifact: encoded.artifact }),
      ...(encoded.metadata === undefined ? {} : { metadata: encoded.metadata }),
      additional_kwargs: encoded.additionalKwargs,
      response_metadata: encoded.responseMetadata,
      ...(encoded.id === undefined ? {} : { id: encoded.id }),
    });
  }
  if (encoded.kind === "command") {
    return new Command({
      ...(encoded.graph === undefined ? {} : { graph: encoded.graph }),
      ...(encoded.update === undefined
        ? {}
        : { update: decodeNestedValue(encoded.update) as Record<string, unknown> }),
      ...(encoded.resume === undefined
        ? {}
        : { resume: decodeNestedValue(encoded.resume) }),
      ...(encoded.goto === undefined
        ? {}
        : { goto: decodeNestedValue(encoded.goto) as string }),
    });
  }
  throw new ToolExecutionIntegrityError(
    `Tool call "${toolCall.id}" has an unknown durable result kind.`,
  );
}

function encodeNestedValue(value: unknown): unknown {
  if (ToolMessage.isInstance(value)) {
    return { __durableType: "tool_message", value: encodeToolResult(value) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeNestedValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeNestedValue(entry)]),
    );
  }
  return value;
}

function decodeNestedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeNestedValue);
  }
  if (value && typeof value === "object") {
    if (
      "__durableType" in value &&
      value.__durableType === "tool_message" &&
      "value" in value
    ) {
      return decodeToolResult(value.value, {
        id: "durable-replay",
        name: "durable-replay",
        args: {},
        type: "tool_call",
      });
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeNestedValue(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}

function errorToolMessage(
  request: ToolCallRequest,
  message: string,
): ToolMessage {
  return new ToolMessage({
    content: `Error: ${message}`,
      tool_call_id: requireToolCallId(request.toolCall.id),
    name: request.toolCall.name,
    status: "error",
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireToolCallId(toolCallId: string | undefined): string {
  if (!toolCallId) {
    throw new ToolExecutionIntegrityError(
      "Tool execution cannot be persisted without a tool call ID.",
    );
  }
  return toolCallId;
}
