import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

const CAPABILITY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ["ls", "read_file"],
  search: ["glob", "grep"],
  edit: ["write_file", "edit_file"],
  write: ["write_file", "edit_file"],
  execute: ["execute_command"],
  shell: ["execute_command"],
  bash: ["execute_command"],
  powershell: ["execute_command"],
  agent: ["task"],
  todo: ["write_todos"],
  todos: ["write_todos"],
  "read/readfile": ["read_file"],
  "search/listdirectory": ["ls"],
  "search/filesearch": ["glob"],
  "search/textsearch": ["grep"],
  "edit/createfile": ["write_file"],
  "edit/editfiles": ["edit_file"],
  "execute/runinterminal": ["execute_command"],
  "agent/runsubagent": ["task"],
};

const DIRECT_INTERNAL_TOOLS = new Set([
  "ls",
  "read_file",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "execute_command",
  "task",
  "write_todos",
]);

export interface AgentToolPolicyDiagnostic {
  severity: "warning";
  code: "tools.unknown" | "tools.unknown-mcp-server";
  tool: string;
  message: string;
}

export interface AgentToolPolicy {
  mode: "none" | "all" | "explicit";
  configuredTools?: string[];
  allowedTools: ReadonlySet<string>;
  allowedPrefixes: readonly string[];
  resolvedTools: readonly string[];
  diagnostics: readonly AgentToolPolicyDiagnostic[];
  allows(toolName: string): boolean;
}

export interface ResolveAgentToolPolicyOptions {
  mcpServerNames?: Iterable<string>;
}

export function resolveAgentToolPolicy(
  configuredTools: string[] | undefined,
  options: ResolveAgentToolPolicyOptions = {},
): AgentToolPolicy {
  const normalizedConfigured = configuredTools?.map((tool) => tool.trim()) ?? [];
  if (normalizedConfigured.length === 0) {
    return createPolicy("none", configuredTools, new Set(), [], []);
  }
  if (normalizedConfigured.includes("*")) {
    return createPolicy("all", configuredTools, new Set(), [], []);
  }

  const mcpServers = new Map<string, string>();
  for (const serverName of options.mcpServerNames ?? []) {
    mcpServers.set(serverName.toLocaleLowerCase(), serverName);
  }

  const allowedTools = new Set<string>();
  const allowedPrefixes = new Set<string>();
  const diagnostics: AgentToolPolicyDiagnostic[] = [];

  for (const configuredTool of normalizedConfigured) {
    if (!configuredTool) {
      continue;
    }

    const normalized = configuredTool.toLocaleLowerCase();
    if (normalized === "vscode" || normalized.startsWith("vscode/")) {
      continue;
    }

    const mapped = CAPABILITY_TOOLS[normalized];
    if (mapped) {
      for (const toolName of mapped) {
        allowedTools.add(toolName);
      }
      continue;
    }

    if (DIRECT_INTERNAL_TOOLS.has(normalized)) {
      allowedTools.add(normalized);
      continue;
    }

    if (normalized === "web" || normalized === "web/fetch") {
      allowedTools.add("web/fetch");
      continue;
    }
    if (normalized === "web/*") {
      allowedPrefixes.add("web/");
      continue;
    }
    if (normalized === "browser" || normalized === "browser/*") {
      allowedPrefixes.add("browser/");
      continue;
    }
    if (
      normalized.startsWith("browser/") &&
      normalized.length > "browser/".length
    ) {
      allowedTools.add(normalized);
      continue;
    }

    const separatorIndex = configuredTool.indexOf("/");
    if (separatorIndex > 0) {
      const requestedServer = configuredTool.slice(0, separatorIndex);
      const requestedTool = configuredTool.slice(separatorIndex + 1);
      const canonicalServer = mcpServers.get(
        requestedServer.toLocaleLowerCase(),
      );
      if (!canonicalServer) {
        diagnostics.push({
          severity: "warning",
          code: "tools.unknown-mcp-server",
          tool: configuredTool,
          message: `MCP server "${requestedServer}" is not configured.`,
        });
        continue;
      }
      if (requestedTool === "*") {
        allowedPrefixes.add(`${canonicalServer}/`);
      } else if (requestedTool) {
        allowedTools.add(`${canonicalServer}/${requestedTool}`);
      } else {
        diagnostics.push(unknownToolDiagnostic(configuredTool));
      }
      continue;
    }

    diagnostics.push(unknownToolDiagnostic(configuredTool));
  }

  return createPolicy(
    "explicit",
    configuredTools,
    allowedTools,
    [...allowedPrefixes],
    diagnostics,
  );
}

export function createAgentToolPolicyMiddleware(
  policy: AgentToolPolicy,
  modelNameAliases: ReadonlyMap<string, string> = new Map(),
) {
  const canonicalName = (modelName: string): string =>
    modelNameAliases.get(modelName) ?? modelName;
  return createMiddleware({
    name: "AgentToolPolicy",
    wrapModelCall(request, handler) {
      return handler({
        ...request,
        tools: request.tools?.filter(
          (tool) =>
            !hasToolName(tool) ||
            policy.allows(canonicalName(tool.name)),
        ),
      });
    },
    wrapToolCall(request, handler) {
      if (policy.allows(canonicalName(request.toolCall.name))) {
        return handler(request);
      }
      const policyToolName = canonicalName(request.toolCall.name);
      return new ToolMessage({
        content: `Tool "${policyToolName}" is not allowed by this agent's tools policy.`,
        tool_call_id: request.toolCall.id ?? "missing-tool-call-id",
        name: policyToolName,
        status: "error",
      });
    },
  });
}

function createPolicy(
  mode: AgentToolPolicy["mode"],
  configuredTools: string[] | undefined,
  allowedTools: ReadonlySet<string>,
  allowedPrefixes: readonly string[],
  diagnostics: readonly AgentToolPolicyDiagnostic[],
): AgentToolPolicy {
  const resolvedTools =
    mode === "all"
      ? ["*"]
      : [
          ...allowedTools,
          ...allowedPrefixes.map((prefix) => `${prefix}*`),
        ].sort();
  return {
    mode,
    ...(configuredTools !== undefined
      ? { configuredTools: [...configuredTools] }
      : {}),
    allowedTools,
    allowedPrefixes,
    resolvedTools,
    diagnostics,
    allows(toolName: string): boolean {
      return (
        mode === "all" ||
        allowedTools.has(toolName) ||
        allowedPrefixes.some((prefix) => toolName.startsWith(prefix))
      );
    },
  };
}

function hasToolName(tool: unknown): tool is { name: string } {
  return (
    typeof tool === "object" &&
    tool !== null &&
    "name" in tool &&
    typeof tool.name === "string"
  );
}

function unknownToolDiagnostic(tool: string): AgentToolPolicyDiagnostic {
  return {
    severity: "warning",
    code: "tools.unknown",
    tool,
    message: `Tool or capability "${tool}" is not supported by Bridgit.`,
  };
}
