import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import type {
  ProjectAgentDefinition,
  ProjectCustomizations,
} from "./projectCustomizations";

export interface ProjectAgentDelegationDiagnostic {
  severity: "warning";
  code:
    | "delegation.unknown-agent"
    | "delegation.model-invocation-disabled"
    | "delegation.cycle"
    | "delegation.depth-limited";
  agentId: string;
  childId: string;
  message: string;
}

export interface ProjectAgentDelegation {
  children: ProjectAgentDefinition[];
  diagnostics: ProjectAgentDelegationDiagnostic[];
}

export const PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT = [
  "Use the task tool only when a listed project agent is well suited to a bounded part of the user's request.",
  "Give the child a complete, self-contained description of the work and incorporate its result into your response.",
  "Only the project agents listed by the task tool are available.",
].join("\n");

export const PROJECT_AGENT_TASK_DESCRIPTION =
  "Delegate a bounded task to one of this project's explicitly allowed agents.";

export function createProjectAgentDelegationGuardMiddleware(
  allowedAgentIds: Iterable<string>,
) {
  const allowed = new Map(
    [...allowedAgentIds].map((agentId) => [
      agentId.toLocaleLowerCase(),
      agentId,
    ]),
  );
  return createMiddleware({
    name: "ProjectAgentDelegationGuard",
    wrapToolCall(request, handler) {
      if (request.toolCall.name !== "task") {
        return handler(request);
      }
      const requestedAgent =
        typeof request.toolCall.args === "object" &&
        request.toolCall.args !== null &&
        "subagent_type" in request.toolCall.args &&
        typeof request.toolCall.args.subagent_type === "string"
          ? request.toolCall.args.subagent_type
          : "";
      if (allowed.has(requestedAgent.toLocaleLowerCase())) {
        return handler(request);
      }
      const allowedDescription =
        [...allowed.values()].map((agentId) => `"${agentId}"`).join(", ") ||
        "none";
      return new ToolMessage({
        content: `Project agent "${requestedAgent || "<missing>"}" is not available for delegation. Allowed project agents: ${allowedDescription}.`,
        tool_call_id: request.toolCall.id ?? "missing-tool-call-id",
        name: "task",
        status: "error",
      });
    },
  });
}

/**
 * Resolve the direct children exposed by an agent's task tool.
 *
 * Delegation is intentionally bounded to one level. A child may be hidden from
 * the user-facing picker, but it must be model-invocable and must not lead back
 * to the parent through its own declarations.
 */
export function resolveProjectAgentDelegation(
  agent: ProjectAgentDefinition,
  customizations: Pick<ProjectCustomizations, "agents">,
): ProjectAgentDelegation {
  const agentsById = new Map(
    customizations.agents.map((candidate) => [
      candidate.id.toLocaleLowerCase(),
      candidate,
    ]),
  );
  const children: ProjectAgentDefinition[] = [];
  const diagnostics: ProjectAgentDelegationDiagnostic[] = [];
  const seen = new Set<string>();

  for (const configuredChildId of agent.agents ?? []) {
    const normalizedChildId = configuredChildId.trim().toLocaleLowerCase();
    if (!normalizedChildId || seen.has(normalizedChildId)) {
      continue;
    }
    seen.add(normalizedChildId);

    const child = agentsById.get(normalizedChildId);
    if (!child) {
      diagnostics.push({
        severity: "warning",
        code: "delegation.unknown-agent",
        agentId: agent.id,
        childId: configuredChildId,
        message: `Agent "${agent.id}" declares unknown child agent "${configuredChildId}".`,
      });
      continue;
    }
    if (child.disableModelInvocation) {
      diagnostics.push({
        severity: "warning",
        code: "delegation.model-invocation-disabled",
        agentId: agent.id,
        childId: child.id,
        message: `Child agent "${child.id}" has disable-model-invocation enabled and cannot be delegated to.`,
      });
      continue;
    }
    if (
      child.id.toLocaleLowerCase() === agent.id.toLocaleLowerCase() ||
      reachesAgent(child, agent.id, agentsById, new Set())
    ) {
      diagnostics.push({
        severity: "warning",
        code: "delegation.cycle",
        agentId: agent.id,
        childId: child.id,
        message: `Delegation from "${agent.id}" to "${child.id}" would create a cycle.`,
      });
      continue;
    }

    children.push(child);
    if ((child.agents?.length ?? 0) > 0) {
      diagnostics.push({
        severity: "warning",
        code: "delegation.depth-limited",
        agentId: agent.id,
        childId: child.id,
        message: `Child agent "${child.id}" is available, but its own agents list is not exposed because delegation is limited to one level.`,
      });
    }
  }

  return { children, diagnostics };
}

function reachesAgent(
  current: ProjectAgentDefinition,
  targetId: string,
  agentsById: ReadonlyMap<string, ProjectAgentDefinition>,
  visited: Set<string>,
): boolean {
  const currentId = current.id.toLocaleLowerCase();
  if (visited.has(currentId)) {
    return false;
  }
  visited.add(currentId);

  for (const configuredChildId of current.agents ?? []) {
    const childId = configuredChildId.trim().toLocaleLowerCase();
    if (childId === targetId.toLocaleLowerCase()) {
      return true;
    }
    const child = agentsById.get(childId);
    if (child && reachesAgent(child, targetId, agentsById, visited)) {
      return true;
    }
  }
  return false;
}
