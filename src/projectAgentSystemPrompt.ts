import { SystemMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import {
  renderAgentToolCapabilityPrompt,
  type AgentToolPolicy,
} from "./agentToolPolicy";
import type { ProjectSkillDefinition } from "./projectCustomizations";
import { renderProjectSkillsPrompt } from "./projectSkillsMiddleware";

export interface PromptSubagent {
  name: string;
  description: string;
}

export interface ProjectAgentSystemPromptOptions {
  agentInstructions: string;
  includeDeepAgentCorePrompt: boolean;
  policy: AgentToolPolicy;
  subagents: readonly PromptSubagent[];
  skills: readonly ProjectSkillDefinition[];
  workspaceRoot: string;
  modelNameAliases?: ReadonlyMap<string, string>;
}

const DEEP_AGENT_CORE_PROMPT = [
  "You are a deep agent, an AI assistant that helps users accomplish tasks using tools. You respond with text and tool calls. The user can see your responses and tool outputs in real time.",
  "",
  "## Core Behavior",
  "",
  "- Be concise and direct. Don't over-explain unless asked.",
  '- NEVER add unnecessary preamble ("Sure!", "Great question!", "I\'ll now...").',
  "- Don't say \"I'll now do X\" — just do it.",
  "- If the request is underspecified, ask only the minimum followup needed to take the next useful action.",
  "- If asked how to approach something, explain first, then act.",
  "",
  "## Professional Objectivity",
  "",
  "- Prioritize accuracy over validating the user's beliefs",
  "- Disagree respectfully when the user is incorrect",
  "- Avoid unnecessary superlatives, praise, or emotional validation",
  "",
  "## Doing Tasks",
  "",
  "When the user asks you to do something:",
  "",
  "1. **Understand first** — read relevant files, check existing patterns. Quick but thorough — gather enough evidence to start, then iterate.",
  "2. **Act** — implement the solution. Work quickly but accurately.",
  "3. **Verify** — check your work against what was asked, not against your own output. Your first attempt is rarely correct — iterate.",
  "",
  "Keep working until the task is fully complete. Don't stop partway and explain what you would do — just do it. Only yield back to the user when the task is done or you're genuinely blocked.",
  "",
  "**When things go wrong:**",
  "",
  "- If something fails repeatedly, stop and analyze *why* — don't keep retrying the same approach.",
  "- If you're blocked, tell the user what's wrong and ask for guidance.",
  "",
  "## Clarifying Requests",
  "",
  "- Do not ask for details the user already supplied.",
  "- Use reasonable defaults when the request clearly implies them.",
  "- Prioritize missing semantics like content, delivery, detail level, or alert criteria.",
  "- Avoid opening with a long explanation of tool, scheduling, or integration limitations when a concise blocking followup question would move the task forward.",
  "- Ask domain-defining questions before implementation questions.",
  "- For monitoring or alerting requests, ask what signals, thresholds, or conditions should trigger an alert.",
  "",
  "## Progress Updates",
  "",
  "For longer tasks, provide brief progress updates at reasonable intervals — a concise sentence recapping what you've done and what's next.",
].join("\n");

const FILESYSTEM_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ls: "ls: list files in a directory",
  read_file:
    "read_file: read a file from the filesystem; use offset/limit pagination only when intentionally chunking a known large file or when the previous result returned the full requested limit. If fewer lines were returned, stop.",
  glob: 'glob: find files matching a pattern (for example, "**/*.ts")',
  grep: "grep: search for text within files",
  write_file: "write_file: create or replace a file",
  edit_file: "edit_file: replace exact content in an existing file",
};

const FILESYSTEM_TOOL_ORDER = [
  "ls",
  "read_file",
  "glob",
  "grep",
  "write_file",
  "edit_file",
] as const;

const TODO_PROMPT = [
  "## `write_todos`",
  "",
  "You have access to the `write_todos` tool to help you manage and plan complex objectives.",
  "Use this tool for complex objectives to ensure that you are tracking each necessary step.",
  "This tool is very helpful for planning complex objectives, and for breaking down these larger complex objectives into smaller steps.",
  "",
  "It is critical that you mark todos as completed as soon as you are done with a step. Do not batch up multiple steps before marking them as completed.",
  "For simple objectives that only require a few steps, it is better to just complete the objective directly and NOT use this tool.",
  "Writing todos takes time and tokens, use it when it is helpful for managing complex many-step problems! But not for simple few-step requests.",
  "",
  "## Important To-Do List Usage Notes to Remember",
  "",
  "- The `write_todos` tool should never be called multiple times in parallel.",
  "- Don't be afraid to revise the To-Do list as you go. New information may reveal new tasks that need to be done, or old tasks that are irrelevant.",
  "",
  "## Finishing a task",
  "",
  "When you finish all work, write your final answer in the message AFTER your last `write_todos` call — not in the same turn as that call. Start the final message with the substantive content the user asked for — the data, computation, summary, or analysis. The user wants the result, not confirmation that the work is done.",
].join("\n");

const TASK_PROMPT = [
  "## `task` (subagent spawner)",
  "",
  "You have access to a `task` tool to launch short-lived subagents that handle isolated tasks. These agents are ephemeral — they live only for the duration of the task and return a single result.",
  "",
  "When to use the task tool:",
  "",
  "- When a task is complex and multi-step, and can be fully delegated in isolation",
  "- When a task is independent of other tasks and can run in parallel",
  "- When a task requires focused reasoning or heavy token/context usage that would bloat the orchestrator thread",
  "- When sandboxing improves reliability (e.g. code execution, structured searches, data formatting)",
  "- When you only care about the output of the subagent, and not the intermediate steps (ex. performing a lot of research and then returned a synthesized report, performing a series of computations or lookups to achieve a concise, relevant answer.)",
  "",
  "Subagent lifecycle:",
  "",
  "1. **Spawn** → Provide clear role, instructions, and expected output",
  "2. **Run** → The subagent completes the task autonomously",
  "3. **Return** → The subagent provides a single structured result",
  "4. **Reconcile** → Incorporate or synthesize the result into the main thread",
  "",
  "When NOT to use the task tool:",
  "",
  "- If you need to see the intermediate reasoning or steps after the subagent has completed (the task tool hides them)",
  "- If the task is trivial (a few tool calls or simple lookup)",
  "- If delegating does not reduce token usage, complexity, or context switching",
  "- If splitting would add latency without benefit",
  "",
  "## Important Task Tool Usage Notes to Remember",
  "",
  "- Whenever possible, parallelize the work that you do. This is true for both tool_calls, and for tasks. Whenever you have independent steps to complete - make tool_calls, or kick off tasks (subagents) in parallel to accomplish them faster. This saves time for the user, which is incredibly important.",
  "- Issue multiple independent `task` tool calls in the same model response so they run concurrently.",
  "- Remember to use the `task` tool to silo independent tasks within a multi-part objective.",
  "- You should use the `task` tool whenever you have a complex task that will take multiple steps, and is independent from other tasks that the agent needs to complete. These agents are highly competent and efficient.",
  "- Give every child a complete, self-contained task description and incorporate relevant child results into the response to the user.",
  "- Use only the subagent types listed below.",
].join("\n");

export function createProjectAgentSystemPromptMiddleware(
  options: ProjectAgentSystemPromptOptions,
) {
  return createMiddleware({
    name: "ProjectAgentSystemPrompt",
    wrapModelCall(request, handler) {
      const canonicalName = (name: string): string =>
        options.modelNameAliases?.get(name) ?? name;
      const visibleToolNames = (request.tools ?? [])
        .map((tool) => toolName(tool))
        .filter((name): name is string => name !== undefined)
        .map(canonicalName);
      const prompt = renderProjectAgentSystemPrompt({
        ...options,
        visibleToolNames,
      });
      return handler({
        ...request,
        systemMessage: new SystemMessage(prompt),
      });
    },
  });
}

export function renderProjectAgentSystemPrompt(
  options: ProjectAgentSystemPromptOptions & {
    visibleToolNames: readonly string[];
  },
): string {
  const visible = new Set(options.visibleToolNames);
  const sections: string[] = [];
  const instructions = options.agentInstructions.trim();
  if (instructions) {
    sections.push(instructions);
  }
  if (options.includeDeepAgentCorePrompt) {
    sections.push(DEEP_AGENT_CORE_PROMPT);
  }

  const filesystemTools = FILESYSTEM_TOOL_ORDER.filter((name) =>
    visible.has(name),
  );
  if (filesystemTools.length > 0) {
    sections.push(renderFilesystemPrompt(filesystemTools));
  }
  if (visible.has("read_file")) {
    sections.push(renderLargeToolResultsPrompt(visible.has("grep")));
  }
  if (visible.has("write_todos")) {
    sections.push(TODO_PROMPT);
  }
  if (visible.has("execute_command")) {
    sections.push([
      "## `execute_command`",
      "",
      "Use `execute_command` to run commands, scripts, tests, and builds on the host within the current workspace.",
      "This is Bridgit's controlled command tool, not Deep Agents' sandbox-only `execute` tool.",
    ].join("\n"));
  }
  if (visible.has("task") && options.subagents.length > 0) {
    sections.push(
      [
        TASK_PROMPT,
        "",
        "Available subagent types:",
        "",
        ...options.subagents.map(
          (subagent) => `- ${subagent.name}: ${subagent.description}`,
        ),
      ].join("\n"),
    );
  }

  const skillsPrompt = renderProjectSkillsPrompt(
    options.skills,
    options.workspaceRoot,
  );
  if (skillsPrompt) {
    sections.push(skillsPrompt);
  }
  sections.push(
    renderAgentToolCapabilityPrompt(
      options.policy,
      options.visibleToolNames,
    ),
  );
  return sections.join("\n\n");
}

function renderFilesystemPrompt(toolNames: readonly string[]): string {
  const canEdit =
    toolNames.includes("write_file") || toolNames.includes("edit_file");
  return [
    "## Filesystem Tools",
    "",
    "You have access to the following workspace filesystem tools. All file paths must start with `/`.",
    ...(canEdit
      ? [
          "Read relevant files before editing, and preserve existing style and conventions.",
        ]
      : []),
    "",
    ...toolNames.map((name) => `- ${FILESYSTEM_TOOL_DESCRIPTIONS[name]}`),
  ].join("\n");
}

function renderLargeToolResultsPrompt(canSearch: boolean): string {
  return [
    "## Large Tool Results",
    "",
    "When a tool result is too large, it may be offloaded under `/large_tool_results/` instead of returned inline.",
    "Use the exact path from the replacement tool result and inspect it in chunks with `read_file`.",
    ...(canSearch
      ? [
          "Use `grep` within `/large_tool_results/` when you need to search offloaded results and do not know the exact path.",
        ]
      : []),
  ].join("\n");
}

function toolName(tool: unknown): string | undefined {
  return (
    typeof tool === "object" &&
    tool !== null &&
    "name" in tool &&
    typeof tool.name === "string"
  )
    ? tool.name
    : undefined;
}
