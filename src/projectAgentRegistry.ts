import type {
  ProjectAgentDefinition,
  ProjectCustomizations,
} from "./projectCustomizations";

export class ProjectAgentRegistry {
  private readonly byId: ReadonlyMap<string, ProjectAgentDefinition>;

  constructor(customizations: ProjectCustomizations) {
    this.byId = new Map(
      customizations.agents.map((agent) => [agent.id, agent]),
    );
  }

  get(agentId: string | null | undefined): ProjectAgentDefinition | undefined {
    return agentId ? this.byId.get(agentId) : undefined;
  }

  listUserInvocable(): ProjectAgentDefinition[] {
    return [...this.byId.values()]
      .filter((agent) => agent.userInvocable)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
  }
}
