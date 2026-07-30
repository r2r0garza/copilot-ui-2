import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parseDocument } from "yaml";

export type CustomizationDiagnosticSeverity = "error" | "warning";

export interface CustomizationDiagnostic {
  severity: CustomizationDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
}

export interface ProjectAgentDefinition {
  id: string;
  filePath: string;
  name: string;
  description?: string;
  argumentHint?: string;
  tools?: string[];
  skills?: string[];
  agents?: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  body: string;
  metadata: Record<string, unknown>;
}

export interface ProjectSkillDefinition {
  directoryPath: string;
  filePath: string;
  name: string;
  description: string;
  body: string;
  metadata: Record<string, unknown>;
}

export interface ProjectMcpConfiguration {
  filePaths: string[];
  servers: Record<string, Record<string, unknown>>;
  sources: Record<string, ProjectMcpServerSource>;
}

export interface ProjectMcpServerSource {
  kind: "github" | "vscode";
  filePath: string;
}

export interface ProjectCustomizations {
  workspaceRoot: string;
  agents: ProjectAgentDefinition[];
  skills: ProjectSkillDefinition[];
  mcp?: ProjectMcpConfiguration;
  diagnostics: CustomizationDiagnostic[];
}

interface FrontmatterDocument {
  metadata: Record<string, unknown>;
  body: string;
}

interface MutableDiscovery {
  diagnostics: CustomizationDiagnostic[];
}

export async function discoverProjectCustomizations(
  workspaceRoot: string,
): Promise<ProjectCustomizations> {
  const state: MutableDiscovery = { diagnostics: [] };
  const githubRoot = join(workspaceRoot, ".github");
  const agents = await discoverAgents(
    workspaceRoot,
    join(githubRoot, "agents"),
    state,
  );
  const skills = await discoverSkills(
    workspaceRoot,
    join(githubRoot, "skills"),
    state,
  );
  validateAgentSkillReferences(workspaceRoot, agents, skills, state);
  const mcp = await discoverMcp(
    workspaceRoot,
    join(githubRoot, "mcp.json"),
    join(workspaceRoot, ".vscode", "mcp.json"),
    state,
  );

  return {
    workspaceRoot,
    agents,
    skills,
    ...(mcp ? { mcp } : {}),
    diagnostics: state.diagnostics.sort(compareDiagnostics),
  };
}

async function discoverAgents(
  workspaceRoot: string,
  agentsDirectory: string,
  state: MutableDiscovery,
): Promise<ProjectAgentDefinition[]> {
  const entries = await readDirectoryIfPresent(agentsDirectory);
  const agents: ProjectAgentDefinition[] = [];
  const names = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".agent.md")) {
      continue;
    }

    const absolutePath = join(agentsDirectory, entry.name);
    const displayPath = projectPath(workspaceRoot, absolutePath);
    const diagnosticStart = state.diagnostics.length;
    const source = await readFile(absolutePath, "utf8");
    const parsed = parseFrontmatter(source, displayPath, state);
    if (!parsed) {
      continue;
    }

    const id = entry.name.slice(0, -".agent.md".length);
    const name =
      optionalString(parsed.metadata.name, "name", displayPath, state) ?? id;
    if (!name.trim()) {
      addDiagnostic(
        state,
        "error",
        "agent.invalid-name",
        displayPath,
        "Agent name must not be empty.",
      );
      continue;
    }

    const tools = optionalStringList(
      parsed.metadata.tools,
      "tools",
      displayPath,
      state,
    );
    const skills = optionalStringList(
      parsed.metadata.skills,
      "skills",
      displayPath,
      state,
    );
    const allowedAgents = optionalStringList(
      parsed.metadata.agents,
      "agents",
      displayPath,
      state,
    );
    const description = optionalString(
      parsed.metadata.description,
      "description",
      displayPath,
      state,
    );
    const argumentHint = optionalString(
      parsed.metadata["argument-hint"],
      "argument-hint",
      displayPath,
      state,
    );
    const userInvocable = optionalBoolean(
      parsed.metadata["user-invocable"],
      "user-invocable",
      true,
      displayPath,
      state,
    );
    const disableModelInvocation = optionalBoolean(
      parsed.metadata["disable-model-invocation"],
      "disable-model-invocation",
      false,
      displayPath,
      state,
    );
    if (
      state.diagnostics
        .slice(diagnosticStart)
        .some((diagnostic) => diagnostic.severity === "error")
    ) {
      continue;
    }

    const normalizedName = name.toLocaleLowerCase();
    const previousPath = names.get(normalizedName);
    if (previousPath) {
      addDiagnostic(
        state,
        "error",
        "agent.duplicate-name",
        displayPath,
        `Agent name "${name}" is already defined by ${previousPath}.`,
      );
      continue;
    }
    names.set(normalizedName, displayPath);

    if (!parsed.body.trim()) {
      addDiagnostic(
        state,
        "warning",
        "agent.empty-body",
        displayPath,
        "Agent has no instruction body.",
      );
    }

    agents.push({
      id,
      filePath: absolutePath,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(argumentHint !== undefined ? { argumentHint } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(allowedAgents !== undefined ? { agents: allowedAgents } : {}),
      userInvocable,
      disableModelInvocation,
      body: parsed.body,
      metadata: parsed.metadata,
    });
  }

  return agents.sort((left, right) => left.id.localeCompare(right.id));
}

async function discoverSkills(
  workspaceRoot: string,
  skillsDirectory: string,
  state: MutableDiscovery,
): Promise<ProjectSkillDefinition[]> {
  const entries = await readDirectoryIfPresent(skillsDirectory);
  const skills: ProjectSkillDefinition[] = [];
  const names = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directoryPath = join(skillsDirectory, entry.name);
    const filePath = join(directoryPath, "SKILL.md");
    let source: string;
    try {
      source = await readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        addDiagnostic(
          state,
          "warning",
          "skill.missing-file",
          projectPath(workspaceRoot, directoryPath),
          "Skill directory does not contain SKILL.md.",
        );
        continue;
      }
      throw error;
    }

    const displayPath = projectPath(workspaceRoot, filePath);
    const parsed = parseFrontmatter(source, displayPath, state);
    if (!parsed) {
      continue;
    }

    const name = requiredString(
      parsed.metadata.name,
      "name",
      displayPath,
      "skill.missing-name",
      state,
    );
    const description = requiredString(
      parsed.metadata.description,
      "description",
      displayPath,
      "skill.missing-description",
      state,
    );
    if (!name || !description) {
      continue;
    }

    const normalizedName = name.toLocaleLowerCase();
    const previousPath = names.get(normalizedName);
    if (previousPath) {
      addDiagnostic(
        state,
        "error",
        "skill.duplicate-name",
        displayPath,
        `Skill name "${name}" is already defined by ${previousPath}.`,
      );
      continue;
    }
    names.set(normalizedName, displayPath);

    skills.push({
      directoryPath,
      filePath,
      name,
      description,
      body: parsed.body,
      metadata: parsed.metadata,
    });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveProjectAgentSkills(
  agent: Pick<ProjectAgentDefinition, "skills">,
  availableSkills: readonly ProjectSkillDefinition[],
): ProjectSkillDefinition[] {
  if (agent.skills === undefined) {
    return [...availableSkills];
  }
  const byName = new Map(
    availableSkills.map((skill) => [
      skill.name.toLocaleLowerCase(),
      skill,
    ]),
  );
  const resolved: ProjectSkillDefinition[] = [];
  const seen = new Set<string>();
  for (const configuredName of agent.skills) {
    const normalizedName = configuredName.trim().toLocaleLowerCase();
    if (!normalizedName || seen.has(normalizedName)) {
      continue;
    }
    seen.add(normalizedName);
    const skill = byName.get(normalizedName);
    if (skill) {
      resolved.push(skill);
    }
  }
  return resolved;
}

function validateAgentSkillReferences(
  workspaceRoot: string,
  agents: readonly ProjectAgentDefinition[],
  skills: readonly ProjectSkillDefinition[],
  state: MutableDiscovery,
): void {
  const availableNames = new Set(
    skills.map((skill) => skill.name.toLocaleLowerCase()),
  );
  for (const agent of agents) {
    const seen = new Set<string>();
    for (const configuredName of agent.skills ?? []) {
      const normalizedName = configuredName.trim().toLocaleLowerCase();
      if (
        !normalizedName ||
        seen.has(normalizedName) ||
        availableNames.has(normalizedName)
      ) {
        continue;
      }
      seen.add(normalizedName);
      addDiagnostic(
        state,
        "warning",
        "agent.unknown-skill",
        projectPath(workspaceRoot, agent.filePath),
        `Agent "${agent.id}" declares unknown skill "${configuredName}".`,
      );
    }
  }
}

async function discoverMcp(
  workspaceRoot: string,
  githubFilePath: string,
  vscodeFilePath: string,
  state: MutableDiscovery,
): Promise<ProjectMcpConfiguration | undefined> {
  const github = await readMcpFile(
    workspaceRoot,
    githubFilePath,
    "github",
    state,
  );
  const vscode = await readMcpFile(
    workspaceRoot,
    vscodeFilePath,
    "vscode",
    state,
  );
  if (!github && !vscode) {
    return undefined;
  }

  const servers: Record<string, Record<string, unknown>> = {};
  const sources: Record<string, ProjectMcpServerSource> = {};
  for (const discovered of [github, vscode]) {
    if (!discovered) {
      continue;
    }
    for (const [serverName, configuration] of Object.entries(
      discovered.servers,
    )) {
      const previous = sources[serverName];
      if (previous) {
        addDiagnostic(
          state,
          "warning",
          "mcp.duplicate-server",
          projectPath(workspaceRoot, discovered.filePath),
          `MCP server "${serverName}" overrides the definition from ${projectPath(workspaceRoot, previous.filePath)}.`,
        );
      }
      servers[serverName] = configuration;
      sources[serverName] = {
        kind: discovered.kind,
        filePath: discovered.filePath,
      };
    }
  }

  return {
    filePaths: [github?.filePath, vscode?.filePath].filter(
      (filePath): filePath is string => filePath !== undefined,
    ),
    servers,
    sources,
  };
}

interface DiscoveredMcpFile {
  kind: ProjectMcpServerSource["kind"];
  filePath: string;
  servers: Record<string, Record<string, unknown>>;
}

async function readMcpFile(
  workspaceRoot: string,
  filePath: string,
  kind: ProjectMcpServerSource["kind"],
  state: MutableDiscovery,
): Promise<DiscoveredMcpFile | undefined> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }

  const displayPath = projectPath(workspaceRoot, filePath);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    addDiagnostic(
      state,
      "error",
      "mcp.invalid-json",
      displayPath,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }

  if (!isRecord(value)) {
    addDiagnostic(
      state,
      "error",
      "mcp.invalid-root",
      displayPath,
      "MCP configuration must be a JSON object.",
    );
    return undefined;
  }

  const candidate =
    kind === "vscode"
      ? value.servers
      : value.mcpServers !== undefined
        ? value.mcpServers
        : value.servers !== undefined
          ? value.servers
          : value;
  if (!isRecord(candidate)) {
    addDiagnostic(
      state,
      "error",
      "mcp.invalid-servers",
      displayPath,
      kind === "vscode"
        ? 'VS Code MCP configuration requires a "servers" object.'
        : 'The "mcpServers" value must be an object.',
    );
    return undefined;
  }

  const servers: Record<string, Record<string, unknown>> = {};
  for (const [serverName, configuration] of Object.entries(candidate)) {
    if (!serverName.trim() || !isRecord(configuration)) {
      addDiagnostic(
        state,
        "error",
        "mcp.invalid-server",
        displayPath,
        `MCP server "${serverName}" must have an object configuration.`,
      );
      continue;
    }
    servers[serverName] = configuration;
  }

  return { kind, filePath, servers };
}

function parseFrontmatter(
  source: string,
  displayPath: string,
  state: MutableDiscovery,
): FrontmatterDocument | undefined {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { metadata: {}, body: normalized.trim() };
  }

  const closingIndex = lines.findIndex(
    (line, index) =>
      index > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  if (closingIndex < 0) {
    addDiagnostic(
      state,
      "error",
      "frontmatter.unclosed",
      displayPath,
      "YAML frontmatter is missing its closing delimiter.",
    );
    return undefined;
  }

  const document = parseDocument(lines.slice(1, closingIndex).join("\n"), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      addDiagnostic(
        state,
        "error",
        "frontmatter.invalid-yaml",
        displayPath,
        error.message,
      );
    }
    return undefined;
  }

  const metadata = document.toJS() as unknown;
  if (metadata !== null && !isRecord(metadata)) {
    addDiagnostic(
      state,
      "error",
      "frontmatter.invalid-root",
      displayPath,
      "YAML frontmatter must contain a mapping.",
    );
    return undefined;
  }

  return {
    metadata: metadata ?? {},
    body: lines.slice(closingIndex + 1).join("\n").trim(),
  };
}

function optionalString(
  value: unknown,
  field: string,
  displayPath: string,
  state: MutableDiscovery,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    addDiagnostic(
      state,
      "error",
      "frontmatter.invalid-field",
      displayPath,
      `"${field}" must be a string.`,
    );
    return undefined;
  }
  return value.trim();
}

function requiredString(
  value: unknown,
  field: string,
  displayPath: string,
  code: string,
  state: MutableDiscovery,
): string | undefined {
  const parsed = optionalString(value, field, displayPath, state);
  if (!parsed) {
    addDiagnostic(
      state,
      "error",
      code,
      displayPath,
      `Skill frontmatter requires a non-empty "${field}" field.`,
    );
    return undefined;
  }
  return parsed;
}

function optionalStringList(
  value: unknown,
  field: string,
  displayPath: string,
  state: MutableDiscovery,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const values =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : undefined;
  if (!values || values.some((entry) => typeof entry !== "string")) {
    addDiagnostic(
      state,
      "error",
      "frontmatter.invalid-field",
      displayPath,
      `"${field}" must be a string or an array of strings.`,
    );
    return undefined;
  }

  return values
    .map((entry) => (entry as string).trim())
    .filter((entry) => entry.length > 0);
}

function optionalBoolean(
  value: unknown,
  field: string,
  defaultValue: boolean,
  displayPath: string,
  state: MutableDiscovery,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    addDiagnostic(
      state,
      "error",
      "frontmatter.invalid-field",
      displayPath,
      `"${field}" must be a boolean.`,
    );
    return defaultValue;
  }
  return value;
}

async function readDirectoryIfPresent(
  directoryPath: string,
): Promise<Dirent[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function projectPath(workspaceRoot: string, absolutePath: string): string {
  const path = relative(workspaceRoot, absolutePath);
  return path || basename(absolutePath);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addDiagnostic(
  state: MutableDiscovery,
  severity: CustomizationDiagnosticSeverity,
  code: string,
  path: string,
  message: string,
): void {
  state.diagnostics.push({ severity, code, path, message });
}

function compareDiagnostics(
  left: CustomizationDiagnostic,
  right: CustomizationDiagnostic,
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}
