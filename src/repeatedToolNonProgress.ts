import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware, type ToolCallRequest } from "langchain";
import { hashToolInput } from "./toolExecutionLedger";

export const DEFAULT_REPEATED_TOOL_NON_PROGRESS_LIMIT = 3;

export interface RepeatedToolNonProgress {
  toolName: string;
  count: number;
  result: string;
}

export class RepeatedToolNonProgressError extends Error {
  constructor(readonly nonProgress: RepeatedToolNonProgress) {
    super(renderTerminalInstruction(nonProgress));
    this.name = "RepeatedToolNonProgressError";
  }
}

/**
 * Bounds consecutive, identical successful tool calls that make no progress.
 *
 * A changed input, changed result, failure, or different tool resets the count.
 * This permits evidence-driven retries and polling whose state changes while
 * stopping exact success-shaped loops such as repeated empty search results.
 */
export function createRepeatedToolNonProgressMiddleware(
  limit = DEFAULT_REPEATED_TOOL_NON_PROGRESS_LIMIT,
) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      "Repeated tool non-progress limit must be a positive integer.",
    );
  }

  let previousFingerprint: string | undefined;
  let repeatedCount = 0;
  let terminalNonProgress: RepeatedToolNonProgress | undefined;
  let terminalModelCalls = 0;

  return createMiddleware({
    name: "RepeatedToolNonProgressGuard",
    async wrapToolCall(request, handler) {
      if (terminalNonProgress) {
        return terminalToolMessage(request, terminalNonProgress);
      }

      const result = await handler(request);
      if (!ToolMessage.isInstance(result) || result.status === "error") {
        previousFingerprint = undefined;
        repeatedCount = 0;
        return result;
      }

      const normalizedResult = normalizeResultText(toolMessageText(result));
      const fingerprint = successFingerprint(request, normalizedResult);
      if (fingerprint === previousFingerprint) {
        repeatedCount += 1;
      } else {
        previousFingerprint = fingerprint;
        repeatedCount = 1;
      }
      if (repeatedCount < limit) {
        return result;
      }

      terminalNonProgress = {
        toolName: request.toolCall.name,
        count: repeatedCount,
        result: normalizedResult,
      };
      return appendTerminalInstruction(result, terminalNonProgress);
    },
    wrapModelCall(request, handler) {
      if (!terminalNonProgress) {
        return handler(request);
      }
      if (terminalModelCalls >= 1) {
        throw new RepeatedToolNonProgressError(terminalNonProgress);
      }
      terminalModelCalls += 1;
      return handler({
        ...request,
        tools: [],
        systemMessage: request.systemMessage.concat(
          renderTerminalInstruction(terminalNonProgress),
        ),
      });
    },
  });
}

function successFingerprint(
  request: ToolCallRequest,
  normalizedResult: string,
): string {
  return [
    request.toolCall.name,
    hashToolInput(request.toolCall.args),
    normalizedResult,
  ].join("\n");
}

function appendTerminalInstruction(
  result: ToolMessage,
  nonProgress: RepeatedToolNonProgress,
): ToolMessage {
  return new ToolMessage({
    content: `${toolMessageText(result)}\n\n${renderTerminalInstruction(nonProgress)}`,
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

function terminalToolMessage(
  request: ToolCallRequest,
  nonProgress: RepeatedToolNonProgress,
): ToolMessage {
  return new ToolMessage({
    content: renderTerminalInstruction(nonProgress),
    tool_call_id: request.toolCall.id ?? "missing-tool-call-id",
    name: request.toolCall.name,
    status: "error",
  });
}

function toolMessageText(message: ToolMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return JSON.stringify(message.content);
}

function normalizeResultText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 4_000);
}

function renderTerminalInstruction(
  nonProgress: RepeatedToolNonProgress,
): string {
  return [
    `Repeated tool non-progress limit reached: "${nonProgress.toolName}" returned an identical result ${nonProgress.count} times for equivalent input.`,
    `Last result: ${nonProgress.result}`,
    "No more tools are available in this agent run. Do not retry the same call.",
    "Explain that the repeated call produced no new information. Use the evidence already available, and do not claim the provider or resource is unavailable unless the result actually established that.",
  ].join("\n");
}
