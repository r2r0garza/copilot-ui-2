import * as vscode from "vscode";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput, ToolDefinition } from "@langchain/core/language_models/base";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages/tool";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { Runnable } from "@langchain/core/runnables";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

export type AdapterEvent =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; id: string; name: string; input: object }
  | { kind: "toolResult"; id: string; text: string };

export interface ModelPromptSnapshot {
  systemPrompt: string;
  userPrompt: string;
}

interface VsCodeChatModelCallOptions extends BaseChatModelCallOptions {
  tools?: ToolDefinition[];
}

interface VsCodeChatModelFields {
  model: vscode.LanguageModelChat;
  onEvent?: (event: AdapterEvent) => void;
  onPrompt?: (snapshot: ModelPromptSnapshot) => void;
  seenToolResults?: Set<string>;
  boundTools?: ToolDefinition[];
}

interface ProviderResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/**
 * LangChain chat-model adapter for vscode.lm.
 *
 * Deep Agents binds its private tools to this model. We translate those schemas
 * into request-local VS Code tools, return tool calls as LangChain AI messages,
 * and leave execution and iteration entirely to Deep Agents.
 */
export class VsCodeChatModel extends BaseChatModel<VsCodeChatModelCallOptions> {
  private readonly vscodeModel: vscode.LanguageModelChat;
  private readonly onEvent?: (event: AdapterEvent) => void;
  private readonly onPrompt?: (snapshot: ModelPromptSnapshot) => void;
  private readonly seenToolResults: Set<string>;
  private readonly boundTools: ToolDefinition[];

  constructor(fields: VsCodeChatModelFields) {
    super({});
    this.vscodeModel = fields.model;
    this.onEvent = fields.onEvent;
    this.onPrompt = fields.onPrompt;
    this.seenToolResults = fields.seenToolResults ?? new Set();
    this.boundTools = fields.boundTools ?? [];
  }

  get profile() {
    return {
      maxInputTokens: this.vscodeModel.maxInputTokens,
      toolCalling: true,
    };
  }

  _llmType(): string {
    return "vscode-lm";
  }

  bindTools(
    tools: Parameters<typeof convertToOpenAITool>[0][],
    _kwargs?: Partial<VsCodeChatModelCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, VsCodeChatModelCallOptions> {
    const converted = tools.map((tool) => convertToOpenAITool(tool));
    return new VsCodeChatModel({
      model: this.vscodeModel,
      onEvent: this.onEvent,
      onPrompt: this.onPrompt,
      seenToolResults: this.seenToolResults,
      boundTools: converted,
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const result = await this.request(messages, options, async (text) => {
      await runManager?.handleLLMNewToken(text);
    });

    return {
      generations: [
        {
          text: result.text,
          message: new AIMessage({
            content: result.text,
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              args: call.args,
              type: "tool_call",
            })),
          }),
        },
      ],
      llmOutput: {
        model: this.vscodeModel.id,
        vendor: this.vscodeModel.vendor,
      },
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.onPrompt?.(extractModelPromptSnapshot(messages));
    const vscodeMessages = this.toVsCodeMessages(messages);
    const tools = this.toVsCodeTools(options.tools ?? this.boundTools);
    const cancellation = this.createCancellation(options.signal);

    try {
      const response = await this.vscodeModel.sendRequest(
        vscodeMessages,
        {
          justification: "Run the Deep Agents coding assistant requested by the user.",
          tools,
          toolMode:
            options.tool_choice === "any"
              ? vscode.LanguageModelChatToolMode.Required
              : vscode.LanguageModelChatToolMode.Auto,
        },
        cancellation.source.token,
      );

      let toolIndex = 0;
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          this.onEvent?.({ kind: "text", text: part.value });
          await runManager?.handleLLMNewToken(part.value);
          yield new ChatGenerationChunk({
            text: part.value,
            message: new AIMessageChunk({ content: part.value }),
          });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          this.onEvent?.({
            kind: "toolCall",
            id: part.callId,
            name: part.name,
            input: part.input,
          });
          yield new ChatGenerationChunk({
            text: "",
            message: new AIMessageChunk({
              content: "",
              tool_call_chunks: [
                {
                  id: part.callId,
                  name: part.name,
                  args: JSON.stringify(part.input),
                  index: toolIndex++,
                  type: "tool_call_chunk",
                },
              ],
            }),
          });
        }
      }
    } finally {
      cancellation.dispose();
    }
  }

  private async request(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    onText?: (text: string) => Promise<void>,
  ): Promise<ProviderResult> {
    this.onPrompt?.(extractModelPromptSnapshot(messages));
    const vscodeMessages = this.toVsCodeMessages(messages);
    const tools = this.toVsCodeTools(options.tools ?? this.boundTools);
    const cancellation = this.createCancellation(options.signal);

    try {
      const response = await this.vscodeModel.sendRequest(
        vscodeMessages,
        {
          justification: "Run the Deep Agents coding assistant requested by the user.",
          tools,
          toolMode:
            options.tool_choice === "any"
              ? vscode.LanguageModelChatToolMode.Required
              : vscode.LanguageModelChatToolMode.Auto,
        },
        cancellation.source.token,
      );

      let text = "";
      const toolCalls: ProviderResult["toolCalls"] = [];
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          this.onEvent?.({ kind: "text", text: part.value });
          await onText?.(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          const args = asRecord(part.input);
          toolCalls.push({ id: part.callId, name: part.name, args });
          this.onEvent?.({
            kind: "toolCall",
            id: part.callId,
            name: part.name,
            input: args,
          });
        }
      }
      return { text, toolCalls };
    } finally {
      cancellation.dispose();
    }
  }

  private toVsCodeMessages(messages: BaseMessage[]): vscode.LanguageModelChatMessage[] {
    const systemInstructions = messages
      .filter((message) => message.getType() === "system")
      .map((message) => contentToText(message.content))
      .filter((text) => text.trim())
      .join("\n\n");
    let latestUserMessageIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.getType() !== "system" &&
        !ToolMessage.isInstance(message) &&
        !AIMessage.isInstance(message)
      ) {
        latestUserMessageIndex = index;
        break;
      }
    }
    let instructionsInjected = false;
    const converted: vscode.LanguageModelChatMessage[] = [];

    for (const [messageIndex, message] of messages.entries()) {
      if (message.getType() === "system") {
        continue;
      }
      const text = contentToText(message.content);

      if (ToolMessage.isInstance(message)) {
        if (!this.seenToolResults.has(message.tool_call_id)) {
          this.seenToolResults.add(message.tool_call_id);
          this.onEvent?.({
            kind: "toolResult",
            id: message.tool_call_id,
            text,
          });
        }
        converted.push(vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(message.tool_call_id, [
            new vscode.LanguageModelTextPart(text),
          ]),
        ]));
        continue;
      }

      if (AIMessage.isInstance(message)) {
        const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
        if (text) {
          parts.push(new vscode.LanguageModelTextPart(text));
        }
        for (const call of message.tool_calls ?? []) {
          parts.push(
            new vscode.LanguageModelToolCallPart(
              call.id ?? crypto.randomUUID(),
              call.name,
              call.args,
            ),
          );
        }
        converted.push(vscode.LanguageModelChatMessage.Assistant(parts));
        continue;
      }

      const content =
        systemInstructions && messageIndex === latestUserMessageIndex
          ? [
              "<custom_instructions>",
              systemInstructions,
              "</custom_instructions>",
              "<user-request>",
              text,
              "</user-request>",
            ].join("\n")
          : text;
      instructionsInjected = true;
      converted.push(vscode.LanguageModelChatMessage.User(content));
    }

    if (systemInstructions && !instructionsInjected) {
      converted.unshift(
        vscode.LanguageModelChatMessage.User(
          `<custom_instructions>\n${systemInstructions}\n</custom_instructions>`,
        ),
      );
    }
    return converted;
  }

  private toVsCodeTools(tools: ToolDefinition[] | undefined): vscode.LanguageModelChatTool[] {
    return (tools ?? []).map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      inputSchema: tool.function.parameters as object | undefined,
    }));
  }

  private createCancellation(signal: AbortSignal | undefined): {
    source: vscode.CancellationTokenSource;
    dispose: () => void;
  } {
    const source = new vscode.CancellationTokenSource();
    const abort = () => source.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    return {
      source,
      dispose: () => {
        signal?.removeEventListener("abort", abort);
        source.dispose();
      },
    };
  }
}

function extractModelPromptSnapshot(
  messages: BaseMessage[],
): ModelPromptSnapshot {
  const systemPrompt = messages
    .filter((message) => message.getType() === "system")
    .map((message) => contentToText(message.content))
    .filter((text) => text.trim())
    .join("\n\n");
  let userPrompt = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.getType() !== "system" &&
      !ToolMessage.isInstance(message) &&
      !AIMessage.isInstance(message)
    ) {
      userPrompt = contentToText(message.content);
      break;
    }
  }
  return { systemPrompt, userPrompt };
}

function asRecord(input: object): Record<string, unknown> {
  return input as Record<string, unknown>;
}

function contentToText(content: BaseMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if ("text" in part && typeof part.text === "string") {
        return part.text;
      }
      return JSON.stringify(part);
    })
    .join("\n");
}
