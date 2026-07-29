import * as vscode from "vscode";
import { createVsCodeToolAdapter } from "./vscodeToolAdapter";

export interface ResolvedWebBrowserTool {
  kind: "web" | "browser";
  canonicalName: string;
  providerName: string;
  description: string;
  requiresApproval: boolean;
}

export interface WebBrowserRuntimeDiagnostic {
  severity: "warning";
  code:
    | "web.runtime.provider-unavailable"
    | "web.runtime.ambiguous-provider"
    | "web.runtime.incompatible-provider"
    | "web.runtime.search-unavailable"
    | "browser.runtime.provider-unavailable"
    | "browser.runtime.ambiguous-provider"
    | "browser.runtime.incompatible-provider";
  message: string;
}

export interface ResolvedWebBrowserTools {
  tools: readonly ResolvedWebBrowserTool[];
  diagnostics: readonly WebBrowserRuntimeDiagnostic[];
}

export interface WebBrowserToolPolicy {
  allows(toolName: string): boolean;
}

interface BrowserContract {
  canonicalName: string;
  providerName: string;
  description: string;
  requiresApproval: boolean;
  validateSchema(schema: unknown): boolean;
}

const WEB_PROVIDER_NAME = "copilot_fetchWebPage";

const BROWSER_CONTRACTS: readonly BrowserContract[] = [
  {
    canonicalName: "browser/open",
    providerName: "open_browser_page",
    description:
      "Open or reuse an integrated browser page for an interactive browser workflow. Do not use this for simple content retrieval from known URLs; use the web fetch tool instead. The returned pageId is provider-managed and must be passed to other browser tools.",
    requiresApproval: false,
    validateSchema: (schema) =>
      hasObjectSchema(schema) &&
      hasProperty(schema, "url", "string") &&
      hasProperty(schema, "forceNew", "boolean"),
  },
  {
    canonicalName: "browser/read",
    providerName: "read_page",
    description:
      "Read the accessibility state of an already-open integrated browser page. Use this for interactive page state, not for fetching content from a known URL.",
    requiresApproval: false,
    validateSchema: pageIdOnlySchema,
  },
  {
    canonicalName: "browser/navigate",
    providerName: "navigate_page",
    description:
      "Navigate an already-open integrated browser page by URL, history, or reload. This is part of an interactive browser workflow and requires a pageId from browser/open.",
    requiresApproval: false,
    validateSchema: (schema) =>
      pageIdSchema(schema) &&
      hasProperty(schema, "type", "string") &&
      hasProperty(schema, "url", "string"),
  },
  {
    canonicalName: "browser/click",
    providerName: "click_element",
    description:
      "Click an element in an interactive browser page. This can submit forms or trigger external effects and therefore requires host approval.",
    requiresApproval: true,
    validateSchema: (schema) =>
      pageIdSchema(schema) &&
      hasRequiredProperty(schema, "element", "string") &&
      hasProperty(schema, "ref", "string") &&
      hasProperty(schema, "selector", "string"),
  },
  {
    canonicalName: "browser/type",
    providerName: "type_in_page",
    description:
      "Type text or press keys in an interactive browser page. This may disclose or submit data and therefore requires host approval.",
    requiresApproval: true,
    validateSchema: (schema) =>
      pageIdSchema(schema) &&
      hasProperty(schema, "text", "string") &&
      hasProperty(schema, "key", "string"),
  },
  {
    canonicalName: "browser/hover",
    providerName: "hover_element",
    description:
      "Hover over an element in an interactive browser page to reveal transient page state. Requires a pageId from browser/open.",
    requiresApproval: false,
    validateSchema: (schema) =>
      pageIdSchema(schema) &&
      hasRequiredProperty(schema, "element", "string") &&
      hasProperty(schema, "ref", "string") &&
      hasProperty(schema, "selector", "string"),
  },
  {
    canonicalName: "browser/drag",
    providerName: "drag_element",
    description:
      "Drag one element onto another in an interactive browser page. This changes page state and therefore requires host approval.",
    requiresApproval: true,
    validateSchema: (schema) =>
      pageIdSchema(schema) &&
      hasRequiredProperty(schema, "fromElement", "string") &&
      hasRequiredProperty(schema, "toElement", "string"),
  },
  {
    canonicalName: "browser/dialog",
    providerName: "handle_dialog",
    description:
      "Accept, dismiss, or provide input to a browser modal or file chooser. This can confirm external actions or disclose files and therefore requires host approval.",
    requiresApproval: true,
    validateSchema: (schema) =>
      pageIdSchema(schema) &&
      hasProperty(schema, "acceptModal", "boolean") &&
      hasProperty(schema, "promptText", "string") &&
      hasStringArrayProperty(schema, "selectFiles"),
  },
  {
    canonicalName: "browser/screenshot",
    providerName: "screenshot_page",
    description:
      "Capture a screenshot of an already-open integrated browser page. Use browser/read when the next step depends on page elements or actions.",
    requiresApproval: false,
    validateSchema: pageIdOnlySchema,
  },
  {
    canonicalName: "browser/run-code",
    providerName: "run_playwright_code",
    description:
      "Run focused Playwright code against an interactive browser page only when the dedicated browser tools are insufficient. Arbitrary browser automation requires host approval.",
    requiresApproval: true,
    validateSchema: (schema) =>
      pageIdSchema(schema) &&
      hasProperty(schema, "code", "string") &&
      hasProperty(schema, "deferredResultId", "string"),
  },
];

export function resolveVscodeWebBrowserTools(
  registeredTools: readonly vscode.LanguageModelToolInformation[] =
    vscode.lm.tools,
  extensions: readonly vscode.Extension<unknown>[] = vscode.extensions.all,
): ResolvedWebBrowserTools {
  const diagnostics: WebBrowserRuntimeDiagnostic[] = [];
  const tools: ResolvedWebBrowserTool[] = [];

  const fetchProviders = registeredTools.filter(
    (tool) => tool.name === WEB_PROVIDER_NAME,
  );
  if (fetchProviders.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "web.runtime.provider-unavailable",
      message:
        'The explicit-URL web fetch provider "copilot_fetchWebPage" is unavailable.',
    });
  } else if (fetchProviders.length > 1) {
    diagnostics.push({
      severity: "warning",
      code: "web.runtime.ambiguous-provider",
      message:
        'More than one registered tool is named "copilot_fetchWebPage"; web/fetch was skipped.',
    });
  } else if (
    !hasCopilotFetchContribution(extensions) ||
    !isWebFetchSchema(fetchProviders[0].inputSchema)
  ) {
    diagnostics.push({
      severity: "warning",
      code: "web.runtime.incompatible-provider",
      message:
        'The registered "copilot_fetchWebPage" tool does not match the correlated GitHub Copilot Chat explicit-URL fetch contract.',
    });
  } else {
    tools.push({
      kind: "web",
      canonicalName: "web/fetch",
      providerName: WEB_PROVIDER_NAME,
      description:
        "Fetch and analyze content from explicit URLs already supplied or otherwise known. This is not web search and must not be used for open-ended current-information discovery or interactive form/browser work.",
      requiresApproval: false,
    });
  }
  diagnostics.push({
    severity: "warning",
    code: "web.runtime.search-unavailable",
    message:
      "No deterministic general web-search provider is available; web/fetch only retrieves explicit URLs.",
  });

  const browserMatches = new Map<string, vscode.LanguageModelToolInformation[]>();
  for (const contract of BROWSER_CONTRACTS) {
    browserMatches.set(
      contract.providerName,
      registeredTools.filter(
        (tool) => tool.name === contract.providerName,
      ),
    );
  }
  const missing = BROWSER_CONTRACTS.filter(
    (contract) => browserMatches.get(contract.providerName)?.length === 0,
  );
  const ambiguous = BROWSER_CONTRACTS.filter(
    (contract) =>
      (browserMatches.get(contract.providerName)?.length ?? 0) > 1,
  );
  const incompatible = BROWSER_CONTRACTS.filter((contract) => {
    const matches = browserMatches.get(contract.providerName) ?? [];
    return (
      matches.length === 1 &&
      !contract.validateSchema(matches[0].inputSchema)
    );
  });

  if (ambiguous.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "browser.runtime.ambiguous-provider",
      message: `The integrated-browser contract has duplicate registered members (${ambiguous.map((contract) => contract.providerName).join(", ")}); the entire browser family was skipped.`,
    });
  } else if (missing.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "browser.runtime.provider-unavailable",
      message: `Integrated-browser support is incomplete; missing ${missing.map((contract) => contract.providerName).join(", ")}. The entire browser family was skipped.`,
    });
  } else if (incompatible.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "browser.runtime.incompatible-provider",
      message: `The integrated-browser contract has incompatible schemas (${incompatible.map((contract) => contract.providerName).join(", ")}); the entire browser family was skipped.`,
    });
  } else {
    tools.push(
      ...BROWSER_CONTRACTS.map((contract) => ({
        kind: "browser" as const,
        canonicalName: contract.canonicalName,
        providerName: contract.providerName,
        description: contract.description,
        requiresApproval: contract.requiresApproval,
      })),
    );
  }

  return Object.freeze({
    tools: Object.freeze(
      tools.sort((left, right) =>
        left.canonicalName.localeCompare(right.canonicalName),
      ),
    ),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function createAllowedVscodeWebBrowserTools(
  policy: WebBrowserToolPolicy,
) {
  const resolved = resolveVscodeWebBrowserTools();
  const allowed = resolved.tools.filter((candidate) =>
    policy.allows(candidate.canonicalName),
  );
  return {
    tools: allowed.map((candidate) =>
      createVsCodeToolAdapter({
        canonicalName: candidate.canonicalName,
        providerName: candidate.providerName,
        description: candidate.description,
      }),
    ),
    modelNameAliases: new Map(
      allowed.map((candidate) => [
        candidate.providerName,
        candidate.canonicalName,
      ]),
    ),
    approvalProviderNames: Object.freeze(
      allowed
        .filter((candidate) => candidate.requiresApproval)
        .map((candidate) => candidate.providerName),
    ),
    diagnostics: resolved.diagnostics,
  };
}

function hasCopilotFetchContribution(
  extensions: readonly vscode.Extension<unknown>[],
): boolean {
  return extensions.some((extension) => {
    if (extension.id.toLocaleLowerCase() !== "github.copilot-chat") {
      return false;
    }
    const packageJson = asRecord(extension.packageJSON);
    const contributes = asRecord(packageJson?.contributes);
    const declarations = contributes?.languageModelTools;
    return (
      Array.isArray(declarations) &&
      declarations.some(
        (declaration) =>
          asRecord(declaration)?.name === WEB_PROVIDER_NAME,
      )
    );
  });
}

function isWebFetchSchema(schema: unknown): boolean {
  return (
    hasObjectSchema(schema) &&
    hasRequiredProperty(schema, "query", "string") &&
    hasRequiredStringArrayProperty(schema, "urls")
  );
}

function pageIdOnlySchema(schema: unknown): boolean {
  return pageIdSchema(schema);
}

function pageIdSchema(schema: unknown): boolean {
  return (
    hasObjectSchema(schema) &&
    hasRequiredProperty(schema, "pageId", "string")
  );
}

function hasObjectSchema(
  schema: unknown,
): schema is Record<string, unknown> {
  const record = asRecord(schema);
  return record?.type === "object" && asRecord(record.properties) !== undefined;
}

function hasRequiredProperty(
  schema: unknown,
  name: string,
  type: string,
): boolean {
  return hasProperty(schema, name, type) && isRequired(schema, name);
}

function hasProperty(
  schema: unknown,
  name: string,
  type: string,
): boolean {
  const properties = asRecord(asRecord(schema)?.properties);
  return asRecord(properties?.[name])?.type === type;
}

function hasRequiredStringArrayProperty(
  schema: unknown,
  name: string,
): boolean {
  return hasStringArrayProperty(schema, name) && isRequired(schema, name);
}

function hasStringArrayProperty(
  schema: unknown,
  name: string,
): boolean {
  const properties = asRecord(asRecord(schema)?.properties);
  const property = asRecord(properties?.[name]);
  return (
    property?.type === "array" &&
    asRecord(property.items)?.type === "string"
  );
}

function isRequired(schema: unknown, name: string): boolean {
  const required = asRecord(schema)?.required;
  return Array.isArray(required) && required.includes(name);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
