import * as vscode from "vscode";
import { tool } from "@langchain/core/tools";
import type { JsonSchema7Type } from "@langchain/core/utils/json_schema";
import {
  LanguageModelToolInvocationError,
  invokeRegisteredLanguageModelTool,
  type NormalizedLanguageModelToolResultPart,
} from "./vscodeLanguageModelTools";

export interface VsCodeToolAdapterDefinition {
  canonicalName: string;
  providerName: string;
  description?: string;
}

export function createVsCodeToolAdapter(
  definition: VsCodeToolAdapterDefinition,
) {
  const provider = vscode.lm.tools.find(
    (candidate) => candidate.name === definition.providerName,
  );
  if (!provider) {
    throw new LanguageModelToolInvocationError(
      "unavailable",
      `Cannot adapt unavailable registered language-model tool "${definition.providerName}".`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(definition.providerName)) {
    throw new Error(
      `Registered language-model tool name "${definition.providerName}" cannot be exposed to a VS Code chat model.`,
    );
  }

  const schema = cloneJsonSchema(provider.inputSchema);
  return tool(
    async (input: unknown, config): Promise<string> => {
      if (!isRecord(input)) {
        throw new Error(
          `Tool "${definition.canonicalName}" requires an object input.`,
        );
      }
      const result = await invokeRegisteredLanguageModelTool(
        definition.providerName,
        input,
        config?.signal,
      );
      return formatNormalizedLanguageModelToolResult(result);
    },
    {
      name: definition.providerName,
      description: definition.description ?? provider.description,
      schema,
      metadata: {
        canonicalName: definition.canonicalName,
        providerName: definition.providerName,
      },
    },
  );
}

export function formatNormalizedLanguageModelToolResult(
  parts: readonly NormalizedLanguageModelToolResultPart[],
): string {
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return `[${part.type}]\n${stringifyResultValue(part.value)}`;
    })
    .join("\n");
}

function cloneJsonSchema(inputSchema: object | undefined): JsonSchema7Type {
  const schema = inputSchema ?? {
    type: "object",
    additionalProperties: true,
  };
  try {
    return structuredClone(schema) as JsonSchema7Type;
  } catch (error) {
    throw new Error(
      `Registered language-model tool has an invalid input schema: ${formatError(error)}`,
      { cause: error },
    );
  }
}

function stringifyResultValue(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
