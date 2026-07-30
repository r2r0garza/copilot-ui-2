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
  scopePath: string;
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
  scopePath: string;
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

interface GithubCustomizationScope {
  scopePath: string;
  githubDirectory: string;
}

const RECURSIVE_DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".pnpm-store",
  ".turbo",
  ".cache",
  ".venv",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);

export async function discoverProjectCustomizations(
  workspaceRoot: string,
): Promise<ProjectCustomizations> {
  const state: MutableDiscovery = { diagnostics: [] };
  const scopes = await discoverGithubCustomizationScopes(workspaceRoot);
  const agents = (
    await Promise.all(
      scopes.map((scope) =>
        discoverAgents(
          workspaceRoot,
          scope,
          join(scope.githubDirectory, "agents"),
          state,
        )
      ),
    )
  ).flat().sort((left, right) => left.id.localeCompare(right.id));
  const skills = (
    await Promise.all(
      scopes.map((scope) =>
        discoverSkills(
          workspaceRoot,
          scope,
          join(scope.githubDirectory, "skills"),
          state,
        )
      ),
    )
  ).flat().sort(compareSkills);
  validateAgentSkillReferences(workspaceRoot, agents, skills, state);
  const githubRoot = join(workspaceRoot, ".github");
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
  scope: GithubCustomizationScope,
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

    const localId = entry.name.slice(0, -".agent.md".length);
    const id = qualifiedCustomizationName(scope.scopePath, localId);
    const name =
      optionalString(parsed.metadata.name, "name", displayPath, state) ??
      localId;
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
      scopePath: scope.scopePath,
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
  scope: GithubCustomizationScope,
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
      scopePath: scope.scopePath,
      directoryPath,
      filePath,
      name,
      description,
      body: parsed.body,
      metadata: parsed.metadata,
    });
  }

  return skills.sort(compareSkills);
}

export function resolveProjectAgentSkills(
  agent: Pick<ProjectAgentDefinition, "scopePath" | "skills">,
  availableSkills: readonly ProjectSkillDefinition[],
): ProjectSkillDefinition[] {
  if (agent.skills === undefined) {
    return effectiveDefaultSkills(agent.scopePath, availableSkills);
  }
  const resolved: ProjectSkillDefinition[] = [];
  const seen = new Set<string>();
  for (const configuredReference of agent.skills) {
    const skill = resolveSkillReference(
      agent.scopePath,
      configuredReference,
      availableSkills,
    );
    if (!skill) {
      continue;
    }
    const qualifiedName = qualifiedSkillName(skill).toLocaleLowerCase();
    if (!seen.has(qualifiedName)) {
      seen.add(qualifiedName);
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
  for (const agent of agents) {
    const seen = new Set<string>();
    for (const configuredName of agent.skills ?? []) {
      const normalizedName = configuredName.trim().toLocaleLowerCase();
      if (
        !normalizedName ||
        seen.has(normalizedName) ||
        resolveSkillReference(agent.scopePath, configuredName, skills)
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

function effectiveDefaultSkills(
  agentScopePath: string,
  availableSkills: readonly ProjectSkillDefinition[],
): ProjectSkillDefinition[] {
  const effectiveScopes = agentScopePath
    ? [agentScopePath, ""]
    : [""];
  const resolved: ProjectSkillDefinition[] = [];
  const seenNames = new Set<string>();
  for (const scopePath of effectiveScopes) {
    for (const skill of availableSkills) {
      const normalizedName = skill.name.toLocaleLowerCase();
      if (
        skill.scopePath === scopePath &&
        !seenNames.has(normalizedName)
      ) {
        seenNames.add(normalizedName);
        resolved.push(skill);
      }
    }
  }
  return resolved;
}

function resolveSkillReference(
  agentScopePath: string,
  configuredReference: string,
  availableSkills: readonly ProjectSkillDefinition[],
): ProjectSkillDefinition | undefined {
  const normalizedReference = normalizeCustomizationReference(
    configuredReference,
  );
  if (!normalizedReference) {
    return undefined;
  }
  if (normalizedReference.includes("/")) {
    return availableSkills.find(
      (skill) =>
        qualifiedSkillName(skill).toLocaleLowerCase() ===
        normalizedReference.toLocaleLowerCase(),
    );
  }
  const effectiveScopes = agentScopePath
    ? [agentScopePath, ""]
    : [""];
  for (const scopePath of effectiveScopes) {
    const skill = availableSkills.find(
      (candidate) =>
        candidate.scopePath === scopePath &&
        candidate.name.toLocaleLowerCase() ===
          normalizedReference.toLocaleLowerCase(),
    );
    if (skill) {
      return skill;
    }
  }
  return undefined;
}

export function qualifiedSkillName(
  skill: Pick<ProjectSkillDefinition, "scopePath" | "name">,
): string {
  return qualifiedCustomizationName(skill.scopePath, skill.name);
}

function compareSkills(
  left: ProjectSkillDefinition,
  right: ProjectSkillDefinition,
): number {
  return (
    left.scopePath.localeCompare(right.scopePath) ||
    left.name.localeCompare(right.name)
  );
}

async function discoverGithubCustomizationScopes(
  workspaceRoot: string,
): Promise<GithubCustomizationScope[]> {
  const scopes: GithubCustomizationScope[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = (await readDirectoryIfPresent(directory))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const childPath = join(directory, entry.name);
      if (entry.name === ".github") {
        const scopePath = normalizeProjectRelativePath(
          relative(workspaceRoot, directory),
        );
        scopes.push({ scopePath, githubDirectory: childPath });
        continue;
      }
      if (RECURSIVE_DISCOVERY_EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await visit(childPath);
    }
  };

  await visit(workspaceRoot);
  return scopes.sort(
    (left, right) =>
      left.scopePath.localeCompare(right.scopePath),
  );
}

function qualifiedCustomizationName(
  scopePath: string,
  localName: string,
): string {
  return scopePath ? `${scopePath}/${localName}` : localName;
}

function normalizeCustomizationReference(reference: string): string {
  return reference.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function normalizeProjectRelativePath(path: string): string {
  return path === "." ? "" : path.replaceAll("\\", "/");
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
