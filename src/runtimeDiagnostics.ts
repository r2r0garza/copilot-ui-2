import * as vscode from "vscode";
import type { ProjectMcpConfiguration } from "./projectCustomizations";
import {
  collectRegisteredLanguageModelTools,
  type RegisteredLanguageModelToolInventory,
} from "./vscodeLanguageModelTools";
import { resolveVscodeMcpTools } from "./vscodeMcpTools";
import { resolveVscodeWebBrowserTools } from "./vscodeWebBrowserTools";

export interface RuntimeDiagnosticEntry {
  severity: "warning";
  source: "models" | "registered-tools" | "mcp" | "web-browser";
  code: string;
  message: string;
}

export interface RuntimeDiagnosticSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  vscodeVersion: string;
  safety: {
    containsModelPrompts: false;
    containsToolInputs: false;
    containsToolResults: false;
    containsMcpLaunchConfiguration: false;
  };
  models: readonly {
    id: string;
    name: string;
    vendor: string;
    family: string;
    version: string;
    maxInputTokens: number;
  }[];
  registeredTools: readonly {
    name: string;
    tags: readonly string[];
    contributingExtensions: readonly string[];
    schema: ToolSchemaShape;
  }[];
  resolvedTools: {
    mcp: readonly {
      canonicalName: string;
      providerName: string;
      serverName: string;
    }[];
    webBrowser: readonly {
      kind: "web" | "browser";
      canonicalName: string;
      providerName: string;
      requiresApproval: boolean;
    }[];
  };
  diagnostics: readonly RuntimeDiagnosticEntry[];
}

export interface ToolSchemaShape {
  type: string;
  required: readonly string[];
  properties: readonly {
    name: string;
    type: string;
    required: boolean;
  }[];
}

export function collectRuntimeDiagnostics(input: {
  models: readonly vscode.LanguageModelChat[];
  registeredTools: readonly vscode.LanguageModelToolInformation[];
  extensions: readonly vscode.Extension<unknown>[];
  vscodeVersion: string;
  mcpConfiguration?: ProjectMcpConfiguration;
  capturedAt?: Date;
}): RuntimeDiagnosticSnapshot {
  const capturedAt = input.capturedAt ?? new Date();
  const inventory = collectRegisteredLanguageModelTools(
    input.registeredTools,
    input.extensions,
    input.vscodeVersion,
    capturedAt,
  );
  const mcp = resolveVscodeMcpTools(
    input.mcpConfiguration,
    input.registeredTools,
  );
  const webBrowser = resolveVscodeWebBrowserTools(
    input.registeredTools,
    input.extensions,
  );
  const diagnostics: RuntimeDiagnosticEntry[] = [
    ...modelDiagnostics(input.models),
    ...registeredToolDiagnostics(inventory),
    ...mcp.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      source: "mcp" as const,
      code: diagnostic.code,
      message: diagnostic.message,
    })),
    ...webBrowser.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      source: "web-browser" as const,
      code: diagnostic.code,
      message: diagnostic.message,
    })),
  ];

  return Object.freeze({
    schemaVersion: 1 as const,
    capturedAt: capturedAt.toISOString(),
    vscodeVersion: input.vscodeVersion,
    safety: Object.freeze({
      containsModelPrompts: false as const,
      containsToolInputs: false as const,
      containsToolResults: false as const,
      containsMcpLaunchConfiguration: false as const,
    }),
    models: Object.freeze(
      input.models
        .map((model) =>
          Object.freeze({
            id: model.id,
            name: model.name,
            vendor: model.vendor,
            family: model.family,
            version: model.version,
            maxInputTokens: model.maxInputTokens,
          }),
        )
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
    registeredTools: Object.freeze(
      inventory.tools.map((tool) =>
        Object.freeze({
          name: tool.name,
          tags: Object.freeze([...tool.tags]),
          contributingExtensions: Object.freeze([
            ...tool.contributingExtensions,
          ]),
          schema: summarizeToolSchema(tool.inputSchema),
        }),
      ),
    ),
    resolvedTools: Object.freeze({
      mcp: Object.freeze(
        mcp.tools.map(({ canonicalName, providerName, serverName }) =>
          Object.freeze({ canonicalName, providerName, serverName }),
        ),
      ),
      webBrowser: Object.freeze(
        webBrowser.tools.map(
          ({ kind, canonicalName, providerName, requiresApproval }) =>
            Object.freeze({
              kind,
              canonicalName,
              providerName,
              requiresApproval,
            }),
        ),
      ),
    }),
    diagnostics: Object.freeze(
      diagnostics.sort(
        (left, right) =>
          left.source.localeCompare(right.source) ||
          left.code.localeCompare(right.code) ||
          left.message.localeCompare(right.message),
      ),
    ),
  });
}

export function renderRuntimeDiagnostics(
  snapshot: RuntimeDiagnosticSnapshot,
): string {
  return [
    "Safe runtime diagnostic: registration metadata only.",
    "This report contains no model prompts, tool inputs, tool results, or MCP launch configuration.",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

function modelDiagnostics(
  models: readonly vscode.LanguageModelChat[],
): RuntimeDiagnosticEntry[] {
  if (models.length === 0) {
    return [
      {
        severity: "warning",
        source: "models",
        code: "models.runtime.provider-unavailable",
        message:
          'No VS Code language models are currently registered for vendor "copilot".',
      },
    ];
  }
  const counts = countValues(models.map((model) => model.id));
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([modelId]) => ({
      severity: "warning" as const,
      source: "models" as const,
      code: "models.runtime.duplicate-id",
      message: `More than one registered language model uses ID "${modelId}".`,
    }));
}

function registeredToolDiagnostics(
  inventory: RegisteredLanguageModelToolInventory,
): RuntimeDiagnosticEntry[] {
  const diagnostics: RuntimeDiagnosticEntry[] = [];
  const counts = countValues(inventory.tools.map((tool) => tool.name));
  for (const [toolName, count] of counts) {
    if (count > 1) {
      diagnostics.push({
        severity: "warning",
        source: "registered-tools",
        code: "tools.runtime.duplicate-name",
        message: `More than one registered language-model tool is named "${toolName}".`,
      });
    }
  }
  const unattributedCount = inventory.tools.filter(
    (tool) => tool.contributingExtensions.length === 0,
  ).length;
  if (unattributedCount > 0) {
    diagnostics.push({
      severity: "warning",
      source: "registered-tools",
      code: "tools.runtime.unattributed",
      message: `${unattributedCount} registered language-model tools have no matching contribution-manifest owner. See each tool's contributingExtensions field; VS Code does not expose a direct owner field, so no owner is inferred from tool names.`,
    });
  }
  return diagnostics;
}

function summarizeToolSchema(value: unknown): ToolSchemaShape {
  const schema = asRecord(value);
  const properties = asRecord(schema?.properties);
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );
  return Object.freeze({
    type: schemaType(schema?.type),
    required: Object.freeze([...required].sort()),
    properties: Object.freeze(
      Object.entries(properties ?? {})
        .map(([name, property]) =>
          Object.freeze({
            name,
            type: schemaType(asRecord(property)?.type),
            required: required.has(name),
          }),
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  });
}

function schemaType(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return [...value].sort().join("|");
  }
  return "unknown";
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
