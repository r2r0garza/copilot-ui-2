import * as vscode from "vscode";
import type { ProjectMcpConfiguration } from "./projectCustomizations";
import { createVsCodeToolAdapter } from "./vscodeToolAdapter";

export interface ResolvedMcpTool {
  serverName: string;
  toolName: string;
  canonicalName: string;
  providerName: string;
}

export interface McpRuntimeDiagnostic {
  severity: "warning";
  code:
    | "mcp.runtime.invalid-server"
    | "mcp.runtime.provider-unavailable"
    | "mcp.runtime.ambiguous-provider"
    | "mcp.runtime.invalid-provider-name";
  serverName?: string;
  providerName?: string;
  message: string;
}

export interface ResolvedMcpTools {
  tools: readonly ResolvedMcpTool[];
  diagnostics: readonly McpRuntimeDiagnostic[];
}

export interface McpToolPolicy {
  allows(toolName: string): boolean;
}

export function resolveVscodeMcpTools(
  configuration: ProjectMcpConfiguration | undefined,
  registeredTools: readonly vscode.LanguageModelToolInformation[] =
    vscode.lm.tools,
): ResolvedMcpTools {
  if (!configuration) {
    return { tools: [], diagnostics: [] };
  }

  const diagnostics: McpRuntimeDiagnostic[] = [];
  const candidateServerNames = Object.entries(configuration.servers)
    .filter(([serverName, definition]) => {
      if (isSupportedServerDefinition(definition)) {
        return true;
      }
      diagnostics.push({
        severity: "warning",
        code: "mcp.runtime.invalid-server",
        serverName,
        message: `MCP server "${serverName}" has no supported stdio or HTTP definition and cannot be activated.`,
      });
      return false;
    })
    .map(([serverName]) => serverName)
    .sort();
  const serverNamesByPrefix = new Map<string, string[]>();
  for (const serverName of candidateServerNames) {
    const prefix = providerPrefix(serverName);
    const names = serverNamesByPrefix.get(prefix) ?? [];
    names.push(serverName);
    serverNamesByPrefix.set(prefix, names);
  }
  const validServerNames = candidateServerNames.filter((serverName) => {
    const collisions = serverNamesByPrefix.get(providerPrefix(serverName)) ?? [];
    if (collisions.length === 1) {
      return true;
    }
    if (collisions[0] === serverName) {
      diagnostics.push({
        severity: "warning",
        code: "mcp.runtime.ambiguous-provider",
        message: `Configured MCP servers ${collisions.join(", ")} share the same VS Code provider prefix "${providerPrefix(serverName)}"; all were skipped.`,
      });
    }
    return false;
  });
  const resolved: ResolvedMcpTool[] = [];
  const matchedServers = new Set<string>();

  for (const provider of registeredTools) {
    if (!provider.tags.includes("mcp")) {
      continue;
    }
    const matches = validServerNames.filter((serverName) =>
      provider.name.startsWith(providerPrefix(serverName)),
    );
    if (matches.length === 0) {
      continue;
    }
    if (matches.length > 1) {
      diagnostics.push({
        severity: "warning",
        code: "mcp.runtime.ambiguous-provider",
        providerName: provider.name,
        message: `Registered tool "${provider.name}" matches multiple configured MCP servers (${matches.join(", ")}); it was skipped.`,
      });
      continue;
    }

    const serverName = matches[0];
    const toolName = provider.name.slice(providerPrefix(serverName).length);
    if (!toolName) {
      diagnostics.push({
        severity: "warning",
        code: "mcp.runtime.invalid-provider-name",
        serverName,
        providerName: provider.name,
        message: `Registered MCP provider name "${provider.name}" does not contain a tool name.`,
      });
      continue;
    }
    matchedServers.add(serverName);
    resolved.push(
      Object.freeze({
        serverName,
        toolName,
        canonicalName: `${serverName}/${toolName}`,
        providerName: provider.name,
      }),
    );
  }

  for (const serverName of validServerNames) {
    if (!matchedServers.has(serverName)) {
      diagnostics.push({
        severity: "warning",
        code: "mcp.runtime.provider-unavailable",
        serverName,
        message: `No registered VS Code language-model tools match configured MCP server "${serverName}". Start and trust the server, then refresh its cached tools.`,
      });
    }
  }

  return Object.freeze({
    tools: Object.freeze(
      resolved.sort((left, right) =>
        left.canonicalName.localeCompare(right.canonicalName),
      ),
    ),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function createAllowedVscodeMcpTools(
  configuration: ProjectMcpConfiguration | undefined,
  policy: McpToolPolicy,
) {
  const resolved = resolveVscodeMcpTools(configuration);
  const allowed = resolved.tools.filter((candidate) =>
    policy.allows(candidate.canonicalName),
  );
  return {
    tools: allowed.map((candidate) =>
      createVsCodeToolAdapter({
        canonicalName: candidate.canonicalName,
        providerName: candidate.providerName,
      }),
    ),
    modelNameAliases: new Map(
      allowed.map((candidate) => [
        candidate.providerName,
        candidate.canonicalName,
      ]),
    ),
    diagnostics: resolved.diagnostics,
  };
}

function providerPrefix(serverName: string): string {
  const component = serverName
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 13);
  return `mcp_${component}_`;
}

function isSupportedServerDefinition(
  definition: Record<string, unknown>,
): boolean {
  const transport = definition.type ?? definition.transport;
  if (
    (transport === undefined || transport === "stdio") &&
    isNonEmptyString(definition.command)
  ) {
    return true;
  }
  return (
    (transport === "http" ||
      transport === "sse" ||
      (transport === undefined && definition.url !== undefined)) &&
    isNonEmptyString(definition.url)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
