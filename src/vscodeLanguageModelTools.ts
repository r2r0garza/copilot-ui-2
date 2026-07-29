import * as vscode from "vscode";

export interface RegisteredLanguageModelToolInventoryEntry {
  name: string;
  description: string;
  tags: readonly string[];
  inputSchema: unknown;
  contributingExtensions: readonly string[];
}

export interface LanguageModelToolContributor {
  extensionId: string;
  version: string;
  declaredToolNames: readonly string[];
}

export interface RegisteredLanguageModelToolInventory {
  vscodeVersion: string;
  capturedAt: string;
  tools: readonly RegisteredLanguageModelToolInventoryEntry[];
  contributors: readonly LanguageModelToolContributor[];
}

export type NormalizedLanguageModelToolResultPart =
  | { type: "text"; text: string }
  | { type: "prompt-tsx"; value: unknown }
  | { type: "unknown"; value: unknown };

export type LanguageModelToolInvocationFailureCode =
  | "cancelled"
  | "unavailable"
  | "permission-denied"
  | "provider-failure";

export class LanguageModelToolInvocationError extends Error {
  constructor(
    readonly code: LanguageModelToolInvocationFailureCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "LanguageModelToolInvocationError";
  }
}

export function snapshotRegisteredLanguageModelTools(
  capturedAt = new Date(),
): RegisteredLanguageModelToolInventory {
  return collectRegisteredLanguageModelTools(
    vscode.lm.tools,
    vscode.extensions.all,
    vscode.version,
    capturedAt,
  );
}

export function collectRegisteredLanguageModelTools(
  tools: readonly vscode.LanguageModelToolInformation[],
  extensions: readonly vscode.Extension<unknown>[],
  vscodeVersion: string,
  capturedAt = new Date(),
): RegisteredLanguageModelToolInventory {
  const contributors = extensions
    .map(readLanguageModelToolContributor)
    .filter(
      (contributor): contributor is LanguageModelToolContributor =>
        contributor !== undefined,
    )
    .sort((left, right) =>
      left.extensionId.localeCompare(right.extensionId),
    );

  const inventoryTools = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => {
      const contributingExtensions = contributors
        .filter((contributor) =>
          contributor.declaredToolNames.includes(tool.name),
        )
        .map(
          (contributor) =>
            `${contributor.extensionId}@${contributor.version}`,
        );
      return Object.freeze({
        name: tool.name,
        description: tool.description,
        tags: Object.freeze([...tool.tags]),
        inputSchema: cloneDiagnosticValue(tool.inputSchema),
        contributingExtensions: Object.freeze(contributingExtensions),
      });
    });

  return Object.freeze({
    vscodeVersion,
    capturedAt: capturedAt.toISOString(),
    tools: Object.freeze(inventoryTools),
    contributors: Object.freeze(contributors),
  });
}

export function renderRegisteredLanguageModelToolInventory(
  inventory: RegisteredLanguageModelToolInventory,
): string {
  const lines = [
    "Sensitive diagnostic: registered tool metadata only; no tools were invoked.",
    `VS Code: ${inventory.vscodeVersion}`,
    `Captured: ${inventory.capturedAt}`,
    "",
    `Registered tools (${inventory.tools.length})`,
  ];

  for (const tool of inventory.tools) {
    lines.push(`- ${tool.name}`);
    lines.push(`  description=${JSON.stringify(tool.description)}`);
    lines.push(`  tags=${JSON.stringify(tool.tags)}`);
    lines.push(`  inputSchema=${stringifyDiagnosticValue(tool.inputSchema)}`);
    lines.push(
      `  contributors=${JSON.stringify(tool.contributingExtensions)}`,
    );
  }

  lines.push("", `Contributing extension manifests (${inventory.contributors.length})`);
  for (const contributor of inventory.contributors) {
    lines.push(
      `- ${contributor.extensionId}@${contributor.version} tools=${JSON.stringify(contributor.declaredToolNames)}`,
    );
  }

  const unattributed = inventory.tools
    .filter((tool) => tool.contributingExtensions.length === 0)
    .map((tool) => tool.name);
  lines.push("", `Unattributed registered tools (${unattributed.length})`);
  for (const name of unattributed) {
    lines.push(`- ${name}`);
  }
  if (unattributed.length > 0) {
    lines.push(
      "No owning extension or provider kind is exposed by LanguageModelToolInformation; do not infer one from the name.",
    );
  }

  return lines.join("\n");
}

export async function invokeRegisteredLanguageModelTool(
  providerName: string,
  input: object,
  signal?: AbortSignal,
): Promise<readonly NormalizedLanguageModelToolResultPart[]> {
  if (!vscode.lm.tools.some((tool) => tool.name === providerName)) {
    throw new LanguageModelToolInvocationError(
      "unavailable",
      [
        `Registered language-model tool "${providerName}" is unavailable and was not invoked.`,
        "The provider may be stopped, disabled, untrusted, or absent from VS Code's current registered-tool cache.",
        "Do not retry unchanged in this run; start/trust the provider or refresh its registered tools first.",
      ].join(" "),
    );
  }
  if (signal?.aborted) {
    throw new LanguageModelToolInvocationError(
      "cancelled",
      `Invocation of "${providerName}" was cancelled before it started.`,
    );
  }

  const cancellation = new vscode.CancellationTokenSource();
  const abort = () => cancellation.cancel();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const result = await vscode.lm.invokeTool(
      providerName,
      {
        input,
        toolInvocationToken: undefined,
      },
      cancellation.token,
    );
    return Object.freeze(
      result.content.map(normalizeLanguageModelToolResultPart),
    );
  } catch (error) {
    if (
      signal?.aborted ||
      error instanceof vscode.CancellationError
    ) {
      throw new LanguageModelToolInvocationError(
        "cancelled",
        `Invocation of "${providerName}" was cancelled.`,
        { cause: error },
      );
    }
    if (!vscode.lm.tools.some((tool) => tool.name === providerName)) {
      throw new LanguageModelToolInvocationError(
        "unavailable",
        [
          `Registered language-model tool "${providerName}" became unavailable during invocation.`,
          "Do not retry unchanged until the provider is started/trusted and its registered tools are refreshed.",
        ].join(" "),
        { cause: error },
      );
    }
    if (hasErrorCode(error, "NoPermissions")) {
      throw new LanguageModelToolInvocationError(
        "permission-denied",
        [
          `Permission was denied for registered language-model tool "${providerName}"; it was not authorized to complete.`,
          "Do not retry unchanged until the user grants permission or trusts the provider.",
        ].join(" "),
        { cause: error },
      );
    }
    throw new LanguageModelToolInvocationError(
      "provider-failure",
      `Registered language-model tool "${providerName}" failed: ${formatError(error)}`,
      { cause: error },
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    cancellation.dispose();
  }
}

function readLanguageModelToolContributor(
  extension: vscode.Extension<unknown>,
): LanguageModelToolContributor | undefined {
  const packageJson = isRecord(extension.packageJSON)
    ? extension.packageJSON
    : undefined;
  const contributes = isRecord(packageJson?.contributes)
    ? packageJson.contributes
    : undefined;
  const declarations = Array.isArray(contributes?.languageModelTools)
    ? contributes.languageModelTools
    : [];
  const declaredToolNames = declarations
    .filter(isRecord)
    .map((declaration) => declaration.name)
    .filter((name): name is string => typeof name === "string")
    .sort();
  if (declaredToolNames.length === 0) {
    return undefined;
  }

  return Object.freeze({
    extensionId: extension.id,
    version:
      typeof packageJson?.version === "string"
        ? packageJson.version
        : "<unknown>",
    declaredToolNames: Object.freeze(declaredToolNames),
  });
}

function normalizeLanguageModelToolResultPart(
  part: vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | unknown,
): NormalizedLanguageModelToolResultPart {
  if (part instanceof vscode.LanguageModelTextPart) {
    return Object.freeze({ type: "text", text: part.value });
  }
  if (part instanceof vscode.LanguageModelPromptTsxPart) {
    return Object.freeze({
      type: "prompt-tsx",
      value: cloneDiagnosticValue(part.value),
    });
  }
  return Object.freeze({
    type: "unknown",
    value: cloneDiagnosticValue(part),
  });
}

function cloneDiagnosticValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return structuredClone(value);
  } catch {
    return Object.freeze({
      unsupportedValueType: Object.prototype.toString.call(value),
    });
  }
}

function stringifyDiagnosticValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      unsupportedValueType: Object.prototype.toString.call(value),
    });
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
