import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware, type ToolCallRequest } from "langchain";
import { hashToolInput } from "./toolExecutionLedger";

export const DEFAULT_REPEATED_TOOL_FAILURE_LIMIT = 3;

export interface RepeatedToolFailure {
  toolName: string;
  count: number;
  error: string;
}

export class RepeatedToolFailureError extends Error {
  constructor(readonly failure: RepeatedToolFailure) {
    super(renderTerminalInstruction(failure));
    this.name = "RepeatedToolFailureError";
  }
}

/**
 * Bounds identical failures inside one compiled agent runtime.
 *
 * Once the limit is reached, the next model call receives the complete failure
 * context but no tools. That gives the model one chance to explain the
 * capability/input problem without permitting another tool loop.
 */
export function createRepeatedToolFailureMiddleware(
  limit = DEFAULT_REPEATED_TOOL_FAILURE_LIMIT,
) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Repeated tool failure limit must be a positive integer.");
  }

  const counts = new Map<string, number>();
  let terminalFailure: RepeatedToolFailure | undefined;
  let terminalModelCalls = 0;

  return createMiddleware({
    name: "RepeatedToolFailureGuard",
    async wrapToolCall(request, handler) {
      if (terminalFailure) {
        return terminalToolMessage(request, terminalFailure);
      }

      const result = await handler(request);
      if (!ToolMessage.isInstance(result) || result.status !== "error") {
        clearRequestFailures(counts, request);
        return result;
      }

      const error = normalizeFailureText(toolMessageText(result));
      const fingerprint = failureFingerprint(request, error);
      const count = (counts.get(fingerprint) ?? 0) + 1;
      counts.set(fingerprint, count);
      if (count < limit) {
        return result;
      }

      terminalFailure = {
        toolName: request.toolCall.name,
        count,
        error,
      };
      return appendTerminalInstruction(result, terminalFailure);
    },
    wrapModelCall(request, handler) {
      if (!terminalFailure) {
        return handler(request);
      }
      if (terminalModelCalls >= 1) {
        throw new RepeatedToolFailureError(terminalFailure);
      }
      terminalModelCalls += 1;
      return handler({
        ...request,
        tools: [],
        systemMessage: request.systemMessage.concat(
          renderTerminalInstruction(terminalFailure),
        ),
      });
    },
  });
}

function failureFingerprint(
  request: ToolCallRequest,
  normalizedError: string,
): string {
  return [
    request.toolCall.name,
    hashToolInput(request.toolCall.args),
    normalizedError,
  ].join("\n");
}

function requestPrefix(request: ToolCallRequest): string {
  return [
    request.toolCall.name,
    hashToolInput(request.toolCall.args),
    "",
  ].join("\n");
}

function clearRequestFailures(
  counts: Map<string, number>,
  request: ToolCallRequest,
): void {
  const prefix = requestPrefix(request);
  for (const fingerprint of counts.keys()) {
    if (fingerprint.startsWith(prefix)) {
      counts.delete(fingerprint);
    }
  }
}

function appendTerminalInstruction(
  result: ToolMessage,
  failure: RepeatedToolFailure,
): ToolMessage {
  return cloneToolMessage(
    result,
    `${toolMessageText(result)}\n\n${renderTerminalInstruction(failure)}`,
  );
}

function terminalToolMessage(
  request: ToolCallRequest,
  failure: RepeatedToolFailure,
): ToolMessage {
  return new ToolMessage({
    content: renderTerminalInstruction(failure),
    tool_call_id: request.toolCall.id ?? "missing-tool-call-id",
    name: request.toolCall.name,
    status: "error",
  });
}

function cloneToolMessage(result: ToolMessage, content: string): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: result.tool_call_id,
    ...(result.name === undefined ? {} : { name: result.name }),
    ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    additional_kwargs: result.additional_kwargs,
    response_metadata: result.response_metadata,
    ...(result.id === undefined ? {} : { id: result.id }),
    status: "error",
  });
}

function toolMessageText(message: ToolMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return JSON.stringify(message.content);
}

function normalizeFailureText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 4_000);
}

function renderTerminalInstruction(failure: RepeatedToolFailure): string {
  return [
    `Repeated tool failure limit reached: "${failure.toolName}" returned the same error ${failure.count} times for equivalent input.`,
    `Last error: ${failure.error}`,
    "No more tools are available in this agent run. Do not retry the call or an equivalent path spelling.",
    "Explain the capability or input limitation clearly to the user. Preserve any tool effects that already completed.",
  ].join("\n");
}
