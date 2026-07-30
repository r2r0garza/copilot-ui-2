import * as vscode from "vscode";
import { relative } from "node:path";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import {
  createDeepAgent,
  createSubAgentMiddleware,
  FilesystemBackend,
  type CompiledSubAgent,
} from "deepagents";
import {
  createExecuteCommandTool,
  validateExecuteCommandInput,
} from "./executeCommandTool";
import { WorkbenchSidebarProvider } from "./sidebarProvider";
import {
  VsCodeChatModel,
  type AdapterEvent,
  type ModelPromptSnapshot,
} from "./vscodeChatModel";
import { PersistenceService } from "./persistence/PersistenceService";
import {
  projectConversationEvents,
  type ConversationReplayItem,
} from "./persistence/ConversationReplayProjection";
import { CURRENT_GRAPH_COMPATIBILITY_VERSION } from "./persistence/RecoveryService";
import {
  classifyToolEffect,
  createToolExecutionLedgerMiddleware,
  encodeToolResult,
  hashToolInput,
} from "./toolExecutionLedger";
import {
  discoverProjectCustomizations,
  type ProjectAgentDefinition,
  type ProjectCustomizations,
} from "./projectCustomizations";
import {
  createAgentToolPolicyMiddleware,
  resolveAgentToolPolicy,
  type AgentToolPolicy,
} from "./agentToolPolicy";
import { ProjectAgentRegistry } from "./projectAgentRegistry";
import {
  createProjectAgentDelegationGuardMiddleware,
  PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
  PROJECT_AGENT_TASK_DESCRIPTION,
  resolveProjectAgentDelegation,
} from "./projectAgentDelegation";
import { configureDeepAgentSystemPrompt } from "./deepAgentSystemPrompt";
import { createProjectSkillsMiddleware } from "./projectSkillsMiddleware";
import {
  renderRegisteredLanguageModelToolInventory,
  snapshotRegisteredLanguageModelTools,
} from "./vscodeLanguageModelTools";
import {
  createAllowedVscodeMcpTools,
  resolveVscodeMcpTools,
} from "./vscodeMcpTools";
import {
  createAllowedVscodeWebBrowserTools,
  resolveVscodeWebBrowserTools,
} from "./vscodeWebBrowserTools";
import { resolveComposerControlState } from "./composerState";
import {
  createSteeringMiddleware,
  pendingSteeringEntriesFromEvents,
  SteeringQueue,
  type SteeringEntry,
  type SteeringInjection,
} from "./steeringQueue";
import { createRepeatedToolFailureMiddleware } from "./repeatedToolFailure";
import {
  collectRuntimeDiagnostics,
  renderRuntimeDiagnostics,
} from "./runtimeDiagnostics";
import {
  WorkspaceMutationCoordinator,
  type MutationRunHooks,
} from "./workspaceMutationCoordinator";
import { renderMarkdown } from "./markdownRenderer";

let currentPanel: DeepAgentsChatPanel | undefined;
const processAllowedTools = new Map<string, Set<string>>();
const RUN_LEASE_MS = 30_000;
const RUN_HEARTBEAT_MS = 10_000;
const MAX_ACTIVE_CONVERSATIONS = 3;
const INCLUDE_DEEPAGENTS_DEFAULT_SYSTEM_PROMPT = false;

export function activate(context: vscode.ExtensionContext): void {
  let persistence: PersistenceService | undefined;
  const processInstanceId = crypto.randomUUID();
  const customizationsOutput = vscode.window.createOutputChannel(
    "Deep Agents Customizations",
  );
  const modelCallsOutput = vscode.window.createOutputChannel(
    "Deep Agents Model Calls",
  );
  const runtimeToolsOutput = vscode.window.createOutputChannel(
    "Deep Agents Runtime Tools",
  );
  const openWorkbench = async (): Promise<void> => {
    if (currentPanel) {
      currentPanel.reveal();
      return;
    }

    const models = await selectCopilotModels();
    if (models.length === 0) {
      return;
    }

    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri || !context.storageUri) {
      void vscode.window.showErrorMessage(
        "Deep Agents persistence requires an open workspace.",
      );
      return;
    }
    if (!persistence) {
      try {
        persistence = await PersistenceService.open(
          context.storageUri,
          workspaceUri,
        );
        await persistence.recovery.recoverExpiredAttempts(
          new Date(),
          processInstanceId,
        );
        context.subscriptions.push({
          dispose: () => persistence?.close(),
        });
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }

    try {
      const customizations = await discoverProjectCustomizations(
        workspaceUri.fsPath,
      );
      currentPanel = new DeepAgentsChatPanel(
        context,
        models,
        persistence,
        processInstanceId,
        workspaceUri.fsPath,
        customizations,
        modelCallsOutput,
        () => {
          currentPanel = undefined;
        },
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to load project agents: ${formatError(error)}`,
      );
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("deepagentsSpike.openChat", openWorkbench),
    vscode.commands.registerCommand(
      "deepagentsSpike.inspectProjectCustomizations",
      async () => {
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            "Open a workspace before inspecting Deep Agents customizations.",
          );
          return;
        }

        try {
          const discovered =
            await discoverProjectCustomizations(workspaceRoot);
          renderProjectCustomizations(customizationsOutput, discovered);
          customizationsOutput.show(true);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to inspect project customizations: ${formatError(error)}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "deepagentsSpike.inspectRegisteredTools",
      () => {
        runtimeToolsOutput.clear();
        runtimeToolsOutput.appendLine(
          renderRegisteredLanguageModelToolInventory(
            snapshotRegisteredLanguageModelTools(),
          ),
        );
        runtimeToolsOutput.show(true);
      },
    ),
    vscode.commands.registerCommand(
      "deepagentsSpike.inspectRuntimeDiagnostics",
      async () => {
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            "Open a workspace before inspecting Deep Agents runtime diagnostics.",
          );
          return;
        }
        try {
          const [models, customizations] = await Promise.all([
            vscode.lm.selectChatModels({ vendor: "copilot" }),
            discoverProjectCustomizations(workspaceRoot),
          ]);
          runtimeToolsOutput.clear();
          runtimeToolsOutput.appendLine(
            renderRuntimeDiagnostics(
              collectRuntimeDiagnostics({
                models,
                registeredTools: vscode.lm.tools,
                extensions: vscode.extensions.all,
                vscodeVersion: vscode.version,
                mcpConfiguration: customizations.mcp,
              }),
            ),
          );
          runtimeToolsOutput.show(true);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to inspect runtime diagnostics: ${formatError(error)}`,
          );
        }
      },
    ),
    vscode.window.registerWebviewViewProvider(
      WorkbenchSidebarProvider.viewType,
      new WorkbenchSidebarProvider(openWorkbench),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    customizationsOutput,
    modelCallsOutput,
    runtimeToolsOutput,
  );
}

export function deactivate(): void {}

function renderProjectCustomizations(
  output: vscode.OutputChannel,
  discovered: ProjectCustomizations,
): void {
  output.clear();
  output.appendLine(`Workspace: ${discovered.workspaceRoot}`);
  output.appendLine("");
  const serverNames = Object.keys(discovered.mcp?.servers ?? {}).sort();
  const policyDiagnosticLines: string[] = [];
  output.appendLine(`Agents (${discovered.agents.length})`);
  for (const agent of discovered.agents) {
    const configuredTools =
      agent.tools === undefined ? "<omitted>" : JSON.stringify(agent.tools);
    const policy = resolveAgentToolPolicy(agent.tools, {
      mcpServerNames: serverNames,
    });
    output.appendLine(
      `- ${agent.name} [${agent.id}] configured=${configuredTools} resolved=${JSON.stringify(policy.resolvedTools)} children=${JSON.stringify(resolveProjectAgentDelegation(agent, discovered).children.map((child) => child.id))}`,
    );
    for (const diagnostic of policy.diagnostics) {
      policyDiagnosticLines.push(
        `- ${diagnostic.severity.toUpperCase()} ${relative(discovered.workspaceRoot, agent.filePath)} [${diagnostic.code}] ${diagnostic.message}`,
      );
    }
    for (const diagnostic of resolveProjectAgentDelegation(agent, discovered)
      .diagnostics) {
      policyDiagnosticLines.push(
        `- ${diagnostic.severity.toUpperCase()} ${relative(discovered.workspaceRoot, agent.filePath)} [${diagnostic.code}] ${diagnostic.message}`,
      );
    }
  }
  output.appendLine("");
  output.appendLine(`Skills (${discovered.skills.length})`);
  for (const skill of discovered.skills) {
    output.appendLine(`- ${skill.name}: ${skill.description}`);
  }
  output.appendLine("");
  output.appendLine(`MCP servers (${serverNames.length})`);
  for (const serverName of serverNames) {
    const source = discovered.mcp?.sources[serverName];
    const sourcePath = source
      ? relative(discovered.workspaceRoot, source.filePath)
      : "<unknown>";
    output.appendLine(`- ${serverName} (${sourcePath})`);
  }
  const runtimeMcp = resolveVscodeMcpTools(discovered.mcp);
  output.appendLine("");
  output.appendLine(`MCP runtime tools (${runtimeMcp.tools.length})`);
  for (const tool of runtimeMcp.tools) {
    output.appendLine(`- ${tool.canonicalName} -> ${tool.providerName}`);
  }
  for (const diagnostic of runtimeMcp.diagnostics) {
    policyDiagnosticLines.push(
      `- ${diagnostic.severity.toUpperCase()} [${diagnostic.code}] ${diagnostic.message}`,
    );
  }
  const runtimeWebBrowser = resolveVscodeWebBrowserTools();
  output.appendLine("");
  output.appendLine(
    `Web/browser runtime tools (${runtimeWebBrowser.tools.length})`,
  );
  for (const tool of runtimeWebBrowser.tools) {
    output.appendLine(
      `- ${tool.canonicalName} -> ${tool.providerName}${tool.requiresApproval ? " (approval required)" : ""}`,
    );
  }
  for (const diagnostic of runtimeWebBrowser.diagnostics) {
    policyDiagnosticLines.push(
      `- ${diagnostic.severity.toUpperCase()} [${diagnostic.code}] ${diagnostic.message}`,
    );
  }
  output.appendLine("");
  output.appendLine(
    `Diagnostics (${discovered.diagnostics.length + policyDiagnosticLines.length})`,
  );
  for (const diagnostic of discovered.diagnostics) {
    output.appendLine(
      `- ${diagnostic.severity.toUpperCase()} ${diagnostic.path} [${diagnostic.code}] ${diagnostic.message}`,
    );
  }
  for (const diagnosticLine of policyDiagnosticLines) {
    output.appendLine(diagnosticLine);
  }
}

async function selectCopilotModels(): Promise<vscode.LanguageModelChat[]> {
  const family = vscode.workspace
    .getConfiguration("deepagentsSpike")
    .get<string>("modelFamily", "")
    .trim();

  const models = await vscode.lm.selectChatModels({
    vendor: "copilot",
    ...(family ? { family } : {}),
  });

  if (models.length === 0) {
    void vscode.window.showErrorMessage(
      family
        ? `No Copilot model is available for family "${family}".`
        : "No Copilot language model is available. Check that GitHub Copilot is installed and signed in.",
    );
    return [];
  }
  return models;
}

interface ChatSession {
  id: string;
  threadId: string;
  title: string;
  selectedModelKey: string;
  selectedAgentId: string | null;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  allowedTools: Set<string>;
}

type ConversationRunPhase =
  | "running"
  | "waiting_mutation"
  | "waiting_approval";

interface PendingConversationApproval {
  requestId: string;
  allowSession: boolean;
  actions: ApprovalAction[];
  toolCallIds: string[];
  resolve: (decision: ApprovalResolution) => void;
}

interface ConversationRunController {
  runId: string;
  sessionId: string;
  cancellation: AbortController;
  steeringQueue: SteeringQueue;
  toolCalls: Map<string, { name: string; input: Record<string, unknown> }>;
  phase: ConversationRunPhase;
  liveDraft: string;
  pendingApproval?: PendingConversationApproval;
  expiredApprovalToolCallIds: Set<string>;
}

class DeepAgentsChatPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaceRoot: string;
  private readonly models: vscode.LanguageModelChat[];
  private readonly persistence: PersistenceService;
  private readonly processInstanceId: string;
  private readonly modelCallsOutput: vscode.OutputChannel;
  private customizations: ProjectCustomizations;
  private agentRegistry: ProjectAgentRegistry;
  private readonly sessions: ChatSession[] = [];
  private readonly activeRuns = new Map<string, ConversationRunController>();
  private readonly startingSessions = new Set<string>();
  private readonly mutationCoordinator: WorkspaceMutationCoordinator;
  private currentSessionId: string;

  constructor(
    context: vscode.ExtensionContext,
    models: vscode.LanguageModelChat[],
    persistence: PersistenceService,
    processInstanceId: string,
    workspaceRoot: string,
    customizations: ProjectCustomizations,
    modelCallsOutput: vscode.OutputChannel,
    onDispose: () => void,
  ) {
    this.models = models;
    this.persistence = persistence;
    this.processInstanceId = processInstanceId;
    this.workspaceRoot = workspaceRoot;
    this.mutationCoordinator = new WorkspaceMutationCoordinator(workspaceRoot);
    this.customizations = customizations;
    this.agentRegistry = new ProjectAgentRegistry(customizations);
    this.modelCallsOutput = modelCallsOutput;
    this.sessions.push(
      ...loadSessions(persistence, modelKey(models[0]), processInstanceId),
    );
    if (this.sessions.length === 0) {
      this.sessions.push(
        createSession(persistence, modelKey(models[0]), processInstanceId),
      );
    }
    const initialSession = this.sessions[0];
    this.currentSessionId = initialSession.id;
    this.panel = vscode.window.createWebviewPanel(
      "deepagentsSpike.chat",
      "Deep Agents Spike",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = renderWebview(this.panel.webview, this.workspaceRoot);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleWebviewMessage(message),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(
      () => {
        for (const run of this.activeRuns.values()) {
          run.cancellation.abort();
          this.resolvePendingApproval(run, "deny");
        }
        for (const disposable of this.disposables) {
          disposable.dispose();
        }
        onDispose();
      },
      undefined,
      this.disposables,
    );

    context.subscriptions.push(this.panel);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  private get activeSession(): ChatSession {
    return (
      this.sessions.find((session) => session.id === this.currentSessionId) ??
      this.sessions[0]
    );
  }

  private get activeRun(): ConversationRunController | undefined {
    return this.activeRuns.get(this.activeSession.id);
  }

  private isSessionBusy(sessionId: string): boolean {
    return (
      this.activeRuns.has(sessionId) ||
      this.startingSessions.has(sessionId)
    );
  }

  private get occupiedRunSlots(): number {
    return this.activeRuns.size + this.startingSessions.size;
  }

  private modelForSession(session: ChatSession): vscode.LanguageModelChat {
    return (
      this.models.find(
        (model) => modelKey(model) === session.selectedModelKey,
      ) ??
      this.models[0]
    );
  }

  private get selectedModelKey(): string {
    return this.activeSession.selectedModelKey;
  }

  private promoteSession(sessionId: string): void {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index > 0) {
      const [session] = this.sessions.splice(index, 1);
      this.sessions.unshift(session);
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) {
      return;
    }
    const [deleted] = this.sessions.splice(index, 1);
    processAllowedTools.delete(
      processApprovalGrantKey(this.processInstanceId, sessionId),
    );
    this.persistence.sessions.markDeletingAndQueue(sessionId);
    try {
      await this.persistence.checkpointer.deleteThread(deleted.threadId);
      this.persistence.sessions.hardDelete(sessionId);
      this.persistence.checkpointCleanup.remove(deleted.threadId, "");
    } catch (error) {
      this.persistence.checkpointCleanup.markFailure(
        deleted.threadId,
        "",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (this.sessions.length === 0) {
      this.sessions.push(
        createSession(
          this.persistence,
          modelKey(this.models[0]),
          this.processInstanceId,
        ),
      );
    }
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = this.sessions[Math.min(index, this.sessions.length - 1)].id;
    }
  }

  private async handleWebviewMessage(raw: unknown): Promise<void> {
    if (!isWebviewMessage(raw)) {
      return;
    }
    if (raw.type === "ready") {
      await this.postWorkbenchState(true);
      return;
    }
    if (raw.type === "cancel") {
      const run = this.activeRun;
      run?.cancellation.abort();
      if (run) {
        this.resolvePendingApproval(run, "deny");
      }
      return;
    }
    if (raw.type === "steer") {
      const active = this.activeRun;
      const text = raw.text.trim();
      if (!active || !text) {
        await this.post({
          type: "steeringRejected",
          sessionId: this.activeSession.id,
          requestId: raw.requestId,
          reason: "No active run can accept this steering message.",
        });
        return;
      }
      const result = active.steeringQueue.enqueue(raw.requestId, text);
      if (result.kind === "closed") {
        await this.post({
          type: "steeringRejected",
          sessionId: active.sessionId,
          requestId: raw.requestId,
          reason: "The active run has already reached its final model boundary.",
        });
        return;
      }
      if (result.kind === "accepted") {
        this.persistence.conversationEvents.append({
          sessionId: active.sessionId,
          runId: active.runId,
          eventType: "steering_message",
          payload: {
            schemaVersion: 1,
            steeringId: result.entry.id,
            content: result.entry.text,
          },
        });
      }
      await this.post({
        type: "steeringAccepted",
        sessionId: active.sessionId,
        requestId: result.entry.id,
        text: result.entry.text,
      });
      return;
    }
    if (raw.type === "approval") {
      const run = [...this.activeRuns.values()].find(
        ({ pendingApproval }) =>
          pendingApproval?.requestId === raw.requestId,
      );
      if (run?.pendingApproval) {
        if (
          raw.decision === "session" &&
          !run.pendingApproval.allowSession
        ) {
          return;
        }
        this.resolvePendingApproval(run, raw.decision);
      }
      return;
    }
    if (
      raw.type === "resumePendingApproval" &&
      !this.isSessionBusy(this.activeSession.id) &&
      this.occupiedRunSlots < MAX_ACTIVE_CONVERSATIONS
    ) {
      const session = this.activeSession;
      this.startingSessions.add(session.id);
      await this.postWorkbenchState(false);
      try {
        await this.resumePendingApproval(raw.runId, session);
      } finally {
        this.startingSessions.delete(session.id);
        await this.postWorkbenchState(false);
      }
      return;
    }
    if (
      raw.type === "reconcileRecovery" &&
      !this.isSessionBusy(this.activeSession.id)
    ) {
      const recovery = this.persistence.recovery
        .listForSession(this.activeSession.id)
        .find((item) => item.run.id === raw.runId);
      if (
        !recovery ||
        recovery.recoveryClass !== "needs_review" ||
        !recovery.uncertainToolCallId
      ) {
        return;
      }
      if (raw.decision === "retry") {
        const confirmed = await vscode.window.showWarningMessage(
          "The original operation may already have completed. Retrying later could repeat its side effects.",
          { modal: true },
          "Acknowledge and retry",
        );
        if (confirmed !== "Acknowledge and retry") {
          return;
        }
      }
      if (raw.decision === "abandon") {
        const confirmed = await vscode.window.showWarningMessage(
          "Abandon this interrupted run? Its recovery and tool audit history will be preserved.",
          { modal: true },
          "Abandon run",
        );
        if (confirmed !== "Abandon run") {
          return;
        }
      }
      this.persistence.recoveryDecisions.reconcile({
        runId: recovery.run.id,
        toolCallId: recovery.uncertainToolCallId,
        decision: raw.decision,
        warningAcknowledged: raw.decision === "retry",
        processInstanceId: this.processInstanceId,
      });
      await this.postWorkbenchState(true);
      return;
    }
    if (
      raw.type === "selectModel" &&
      !this.isSessionBusy(this.activeSession.id)
    ) {
      if (this.models.some((model) => modelKey(model) === raw.modelKey)) {
        this.activeSession.selectedModelKey = raw.modelKey;
        this.persistence.sessions.setModel(this.activeSession.id, raw.modelKey);
        this.persistence.conversationEvents.append({
          sessionId: this.activeSession.id,
          eventType: "model_changed",
          payload: { schemaVersion: 1, modelKey: raw.modelKey },
        });
        await this.postWorkbenchState(false);
      }
      return;
    }
    if (
      raw.type === "selectAgent" &&
      !this.isSessionBusy(this.activeSession.id)
    ) {
      const agentId = raw.agentId || null;
      if (
        agentId === null ||
        this.agentRegistry
          .listUserInvocable()
          .some((agent) => agent.id === agentId)
      ) {
        this.activeSession.selectedAgentId = agentId;
        this.persistence.sessions.setAgent(this.activeSession.id, agentId);
        await this.postWorkbenchState(false);
      }
      return;
    }
    if (raw.type === "newSession") {
      const session = createSession(
        this.persistence,
        this.activeSession.selectedModelKey,
        this.processInstanceId,
      );
      this.sessions.unshift(session);
      this.currentSessionId = session.id;
      await this.postWorkbenchState(true);
      return;
    }
    if (raw.type === "selectSession") {
      if (this.sessions.some((session) => session.id === raw.sessionId)) {
        this.currentSessionId = raw.sessionId;
        await this.postWorkbenchState(true);
      }
      return;
    }
    if (raw.type === "renameSession") {
      const session = this.sessions.find((item) => item.id === raw.sessionId);
      const title = sanitizeManualTitle(raw.title);
      if (session && title && !this.isSessionBusy(session.id)) {
        session.title = title;
        this.persistence.sessions.rename(session.id, title);
        this.persistence.conversationEvents.append({
          sessionId: session.id,
          eventType: "title_changed",
          payload: { schemaVersion: 1, title },
        });
        await this.postWorkbenchState(false);
      }
      return;
    }
    if (raw.type === "deleteSession") {
      const session = this.sessions.find((item) => item.id === raw.sessionId);
      if (!session || this.isSessionBusy(session.id)) {
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        `Permanently delete "${session.title}" and its stored conversation?`,
        { modal: true },
        "Delete",
      );
      if (confirmation !== "Delete") {
        return;
      }
      await this.deleteSession(raw.sessionId);
      await this.postWorkbenchState(true);
      return;
    }
    if (
      raw.type === "clear" &&
      !this.isSessionBusy(this.activeSession.id)
    ) {
      this.persistence.sessions.clear(this.activeSession.id);
      const refreshed = this.persistence.sessions.get(this.activeSession.id);
      if (refreshed) this.activeSession.threadId = refreshed.threadId;
      this.activeSession.transcript.length = 0;
      await this.postWorkbenchState(true);
      return;
    }
    if (
      raw.type !== "send" ||
      this.isSessionBusy(this.activeSession.id)
    ) {
      return;
    }

    const prompt = raw.text.trim();
    if (!prompt) {
      return;
    }
    if (this.occupiedRunSlots >= MAX_ACTIVE_CONVERSATIONS) {
      await this.post({
        type: "runRejected",
        sessionId: this.activeSession.id,
        message:
          "Three conversations are already active. Finish or cancel one before starting another.",
      });
      return;
    }
    const session = this.activeSession;
    this.startingSessions.add(session.id);
    await this.postWorkbenchState(false);
    try {
      await this.run(prompt, session);
    } finally {
      this.startingSessions.delete(session.id);
      await this.postWorkbenchState(false);
    }
  }

  private async run(prompt: string, session: ChatSession): Promise<void> {
    const selectedAgent = await this.resolveSelectedAgentForRun(session);
    if (!selectedAgent) {
      await this.post({
        type: "runFailed",
        sessionId: session.id,
        message: "Select an agent before sending a message.",
      });
      return;
    }
    if (
      this.activeRuns.has(session.id) ||
      this.activeRuns.size >= MAX_ACTIVE_CONVERSATIONS
    ) {
      return;
    }
    const model = this.modelForSession(session);
    const { runId, attemptId } = this.persistence.runs.start({
      sessionId: session.id,
      threadId: session.threadId,
      checkpointNamespace: "",
      modelKey: modelKey(model),
      processInstanceId: this.processInstanceId,
      leaseExpiresAt: leaseExpiration(),
      compatibilityVersion: CURRENT_GRAPH_COMPATIBILITY_VERSION,
    });
    const steeringQueue = new SteeringQueue();
    const controller: ConversationRunController = {
      runId,
      sessionId: session.id,
      cancellation: new AbortController(),
      steeringQueue,
      toolCalls: new Map(),
      phase: "running",
      liveDraft: "",
      expiredApprovalToolCallIds: new Set(),
    };
    this.activeRuns.set(session.id, controller);
    this.startingSessions.delete(session.id);
    const heartbeat = setInterval(() => {
      try {
        this.persistence.runs.heartbeat(attemptId, leaseExpiration());
      } catch {
        controller.cancellation.abort();
      }
    }, RUN_HEARTBEAT_MS);
    heartbeat.unref();
    const isFirstMessage = session.transcript.length === 0;
    session.transcript.push({ role: "user", content: prompt });
    this.persistence.conversationEvents.append({
      sessionId: session.id,
      runId,
      eventType: "user_message",
      payload: { schemaVersion: 1, content: prompt },
    });
    this.promoteSession(session.id);
    await this.postWorkbenchState(false);
    if (isFirstMessage) {
      void this.generateSessionTitle(session.id, prompt, model);
    }
    await this.post({ type: "runStarted", sessionId: session.id });

    let streamedFinalText = "";
    const adapter = new VsCodeChatModel({
      model,
      onPrompt: (snapshot) =>
        this.logModelPrompt(
          snapshot,
          runId,
          session,
          selectedAgent.id,
          model,
        ),
      onEvent: (event) => {
        if (event.kind === "text") {
          streamedFinalText += event.text;
          controller.liveDraft += event.text;
        }
        void this.postAdapterEvent(event, controller);
      },
    });

    const agent = this.createAgent(
      adapter,
      session,
      runId,
      selectedAgent,
      steeringQueue,
    );

    try {
      const runConfig = {
        configurable: { thread_id: session.threadId, checkpoint_ns: "" },
        signal: controller.cancellation.signal,
      };
      let result = await agent.invoke(
        {
          messages: [{ role: "user", content: prompt }],
        },
        runConfig,
      );
      await this.recordLatestCheckpoint(runId, session);

      while (true) {
        let approvalRequest = extractApprovalRequest(result);
        while (approvalRequest) {
          const actions = approvalRequest.actions;
          const decisions = await this.reviewApprovalActions(
            actions,
            runId,
            session,
            controller,
          );
          const resume = { decisions };
          result = await agent.invoke(new Command({ resume }), runConfig);
          this.persistence.runs.setExecutionStatus(runId, "running");
          await this.recordLatestCheckpoint(runId, session);
          approvalRequest = extractApprovalRequest(result);
        }
        if (steeringQueue.closeIfEmpty()) {
          break;
        }
        const intermediateMessage = [...(result.messages ?? [])]
          .reverse()
          .find((message) => AIMessage.isInstance(message));
        const intermediateText = intermediateMessage
          ? messageText(intermediateMessage.content)
          : "";
        if (intermediateText) {
          session.transcript.push({
            role: "assistant",
            content: intermediateText,
          });
          this.persistence.conversationEvents.append({
            sessionId: session.id,
            runId,
            eventType: "assistant_message",
            payload: { schemaVersion: 1, content: intermediateText },
          });
        }
        controller.liveDraft = "";
        await this.post({
          type: "modelBoundary",
          sessionId: session.id,
        });
        result = await agent.invoke({ messages: [] }, runConfig);
        await this.recordLatestCheckpoint(runId, session);
      }

      const messages = result.messages ?? [];
      const finalMessage = [...messages].reverse().find((message) => AIMessage.isInstance(message));
      const finalText = finalMessage ? messageText(finalMessage.content) : streamedFinalText;
      session.transcript.push({ role: "assistant", content: finalText });
      this.persistence.conversationEvents.append({
        sessionId: session.id,
        runId,
        eventType: "assistant_message",
        payload: { schemaVersion: 1, content: finalText },
      });
      this.persistence.runs.finish(runId, attemptId, "completed");
      await this.post({
        type: "runCompleted",
        sessionId: session.id,
        text: finalText,
        html: renderMarkdown(finalText),
      });
    } catch (error) {
      const cancelled = controller.cancellation.signal.aborted;
      const message = cancelled ? "Cancelled." : formatError(error);
      await this.discardSteeringQueue(
        controller,
        cancelled ? "cancelled" : "failed",
      );
      session.transcript.push({ role: "assistant", content: message });
      this.persistence.conversationEvents.append({
        sessionId: session.id,
        runId,
        eventType: cancelled ? "run_cancelled" : "run_error",
        payload: cancelled
          ? { schemaVersion: 1, reason: message }
          : { schemaVersion: 1, message },
      });
      this.persistence.runs.finish(
        runId,
        attemptId,
        cancelled ? "cancelled" : "failed",
        message,
      );
      await this.post({
        type: "runFailed",
        sessionId: session.id,
        message,
      });
    } finally {
      clearInterval(heartbeat);
      this.mutationCoordinator.releaseRun(runId);
      if (this.activeRuns.get(session.id) === controller) {
        this.activeRuns.delete(session.id);
      }
      await this.postWorkbenchState(false);
    }
  }

  private async resumePendingApproval(
    runId: string,
    session: ChatSession,
  ): Promise<void> {
    const recovery = this.persistence.recovery
      .listForSession(session.id)
      .find((item) => item.run.id === runId);
    if (!recovery || recovery.recoveryClass !== "waiting_for_approval") {
      return;
    }
    const selectedAgent = await this.resolveSelectedAgentForRun(session);
    if (!selectedAgent) {
      await this.post({
        type: "runFailed",
        sessionId: session.id,
        message: "Select the original agent before resuming this run.",
      });
      return;
    }

    let attemptId: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let controller: ConversationRunController | undefined;
    try {
      const interrupts = await this.persistence.recovery.getPendingInterrupts(
        runId,
      );
      const approvalRequest = extractApprovalRequest({
        __interrupt__: interrupts,
      });
      if (!approvalRequest) {
        throw new Error(
          "The persisted checkpoint does not contain a valid approval request.",
        );
      }

      const resumed = this.persistence.runs.resume({
        runId,
        processInstanceId: this.processInstanceId,
        leaseExpiresAt: leaseExpiration(),
        allowedRecoveryClasses: ["waiting_for_approval"],
      });
      const steeringQueue = new SteeringQueue(
        this.restorePendingSteering(runId, session.id),
      );
      controller = {
        runId,
        sessionId: session.id,
        cancellation: new AbortController(),
        steeringQueue,
        toolCalls: new Map(),
        phase: "running",
        liveDraft: "",
        expiredApprovalToolCallIds: new Set(),
      };
      this.activeRuns.set(session.id, controller);
      this.startingSessions.delete(session.id);
      attemptId = resumed.attemptId;
      heartbeat = setInterval(() => {
        try {
          this.persistence.runs.heartbeat(
            resumed.attemptId,
            leaseExpiration(),
          );
        } catch {
          controller?.cancellation.abort();
        }
      }, RUN_HEARTBEAT_MS);
      heartbeat.unref();

      for (const toolCall of this.persistence.toolExecutions.list(runId)) {
        controller.toolCalls.set(toolCall.toolCallId, {
          name: toolCall.toolName,
          input:
            toolCall.arguments && typeof toolCall.arguments === "object"
              ? toRecord(toolCall.arguments)
              : {},
        });
      }

      const model =
        this.models.find(
          (candidate) => modelKey(candidate) === resumed.run.modelKey,
        ) ?? this.modelForSession(session);
      let streamedFinalText = "";
      const adapter = new VsCodeChatModel({
        model,
        onPrompt: (snapshot) =>
          this.logModelPrompt(
            snapshot,
            runId,
            session,
            selectedAgent.id,
            model,
          ),
        onEvent: (event) => {
          if (event.kind === "text") {
            streamedFinalText += event.text;
            controller!.liveDraft += event.text;
          }
          void this.postAdapterEvent(event, controller!);
        },
      });
      const agent = this.createAgent(
        adapter,
        session,
        runId,
        selectedAgent,
        steeringQueue,
      );
      const runConfig = {
        configurable: {
          thread_id: resumed.run.threadId,
          checkpoint_ns: resumed.run.checkpointNamespace,
        },
        signal: controller.cancellation.signal,
      };

      await this.post({
        type: "runStarted",
        sessionId: session.id,
      });
      const restoredRequestId = this.findPendingApprovalRequestId(
        session.id,
        runId,
      );
      const decisions = await this.reviewApprovalActions(
        approvalRequest.actions,
        runId,
        session,
        controller,
        restoredRequestId
          ? { requestId: restoredRequestId, recordRequest: false }
          : {},
      );
      let result = await agent.invoke(
        new Command({ resume: { decisions } }),
        runConfig,
      );
      this.persistence.runs.setExecutionStatus(runId, "running");
      await this.recordLatestCheckpoint(runId, session);

      while (true) {
        let nextApproval = extractApprovalRequest(result);
        while (nextApproval) {
          const nextDecisions = await this.reviewApprovalActions(
            nextApproval.actions,
            runId,
            session,
            controller,
          );
          result = await agent.invoke(
            new Command({ resume: { decisions: nextDecisions } }),
            runConfig,
          );
          this.persistence.runs.setExecutionStatus(runId, "running");
          await this.recordLatestCheckpoint(runId, session);
          nextApproval = extractApprovalRequest(result);
        }
        if (steeringQueue.closeIfEmpty()) {
          break;
        }
        const intermediateMessage = [...(result.messages ?? [])]
          .reverse()
          .find((message) => AIMessage.isInstance(message));
        const intermediateText = intermediateMessage
          ? messageText(intermediateMessage.content)
          : "";
        if (intermediateText) {
          session.transcript.push({
            role: "assistant",
            content: intermediateText,
          });
          this.persistence.conversationEvents.append({
            sessionId: session.id,
            runId,
            eventType: "assistant_message",
            payload: { schemaVersion: 1, content: intermediateText },
          });
        }
        controller.liveDraft = "";
        await this.post({
          type: "modelBoundary",
          sessionId: session.id,
        });
        result = await agent.invoke({ messages: [] }, runConfig);
        await this.recordLatestCheckpoint(runId, session);
      }

      const messages = result.messages ?? [];
      const finalMessage = [...messages]
        .reverse()
        .find((message) => AIMessage.isInstance(message));
      const finalText = finalMessage
        ? messageText(finalMessage.content)
        : streamedFinalText;
      session.transcript.push({ role: "assistant", content: finalText });
      this.persistence.conversationEvents.append({
        sessionId: session.id,
        runId,
        eventType: "assistant_message",
        payload: { schemaVersion: 1, content: finalText },
      });
      this.persistence.runs.finish(
        runId,
        resumed.attemptId,
        "completed",
      );
      await this.post({
        type: "runCompleted",
        sessionId: session.id,
        text: finalText,
        html: renderMarkdown(finalText),
      });
    } catch (error) {
      const cancelled = controller?.cancellation.signal.aborted ?? false;
      const message = cancelled ? "Cancelled." : formatError(error);
      if (controller) {
        await this.discardSteeringQueue(
          controller,
          cancelled ? "cancelled" : "failed",
        );
      }
      if (attemptId) {
        session.transcript.push({ role: "assistant", content: message });
        this.persistence.conversationEvents.append({
          sessionId: session.id,
          runId,
          eventType: cancelled ? "run_cancelled" : "run_error",
          payload: cancelled
            ? { schemaVersion: 1, reason: message }
            : { schemaVersion: 1, message },
        });
        this.persistence.runs.finish(
          runId,
          attemptId,
          cancelled ? "cancelled" : "failed",
          message,
        );
      }
      await this.post({
        type: "runFailed",
        sessionId: session.id,
        message,
      });
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      this.mutationCoordinator.releaseRun(runId);
      if (
        controller &&
        this.activeRuns.get(session.id) === controller
      ) {
        this.activeRuns.delete(session.id);
      }
      await this.postWorkbenchState(false);
    }
  }

  private recordSteeringInjection(
    runId: string,
    sessionId: string,
    injection: SteeringInjection,
  ): void {
    for (const entry of injection.entries) {
      this.persistence.conversationEvents.append({
        sessionId,
        runId,
        eventType: "steering_injected",
        payload: {
          schemaVersion: 1,
          steeringId: entry.id,
          boundary: injection.boundary,
        },
      });
      void this.post({
        type: "steeringInjected",
        sessionId,
        requestId: entry.id,
        boundary: injection.boundary,
      });
    }
  }

  private async discardSteeringQueue(
    run: ConversationRunController,
    reason: "cancelled" | "failed",
  ): Promise<void> {
    for (const entry of run.steeringQueue.discardPending()) {
      this.persistence.conversationEvents.append({
        sessionId: run.sessionId,
        runId: run.runId,
        eventType: "steering_discarded",
        payload: {
          schemaVersion: 1,
          steeringId: entry.id,
          reason,
        },
      });
      await this.post({
        type: "steeringDiscarded",
        sessionId: run.sessionId,
        requestId: entry.id,
        reason,
      });
    }
  }

  private restorePendingSteering(
    runId: string,
    sessionId: string,
  ): SteeringEntry[] {
    return pendingSteeringEntriesFromEvents(
      this.persistence.conversationEvents.list(sessionId),
      runId,
    );
  }

  private createAgent(
    adapter: VsCodeChatModel,
    session: ChatSession,
    runId: string,
    agentDefinition: ProjectAgentDefinition,
    steeringQueue: SteeringQueue,
  ) {
    const delegation = resolveProjectAgentDelegation(
      agentDefinition,
      this.customizations,
    );
    const subagents: CompiledSubAgent[] = delegation.children.map((child) => ({
      name: child.id,
      description: child.description ?? child.name,
      runnable: this.createProjectAgentRuntime(
        adapter,
        session,
        runId,
        child,
        [],
        false,
        undefined,
      ),
    }));
    return this.createProjectAgentRuntime(
      adapter,
      session,
      runId,
      agentDefinition,
      subagents,
      true,
      steeringQueue,
    );
  }

  private createProjectAgentRuntime(
    adapter: VsCodeChatModel,
    session: ChatSession,
    runId: string,
    agentDefinition: ProjectAgentDefinition,
    subagents: CompiledSubAgent[],
    persistCheckpoints: boolean,
    steeringQueue: SteeringQueue | undefined,
  ) {
    const runController = this.activeRuns.get(session.id);
    if (!runController || runController.runId !== runId) {
      throw new Error(
        `Conversation run "${runId}" is not active for session "${session.id}".`,
      );
    }
    const configuredPolicy = resolveAgentToolPolicy(agentDefinition.tools, {
      mcpServerNames: Object.keys(this.customizations.mcp?.servers ?? {}),
    });
    const policy: AgentToolPolicy = {
      ...configuredPolicy,
      allows(toolName: string): boolean {
        return (
          configuredPolicy.allows(toolName) &&
          (toolName !== "task" || subagents.length > 0)
        );
      },
    };
    const mcp = createAllowedVscodeMcpTools(
      this.customizations.mcp,
      policy,
    );
    const webBrowser = createAllowedVscodeWebBrowserTools(policy);
    const modelNameAliases = new Map([
      ...mcp.modelNameAliases,
      ...webBrowser.modelNameAliases,
    ]);
    const browserApprovalInterrupts = Object.fromEntries(
      webBrowser.approvalProviderNames.map((providerName) => [
        providerName,
        {
          allowedDecisions: ["approve", "reject"],
          description:
            "Review this interactive browser action. It may submit data, confirm an external action, or change remote page state.",
          when: ({ toolCall }: { toolCall: { name: string } }) =>
            !session.allowedTools.has(toolCall.name),
        },
      ]),
    );
    return createDeepAgent({
      model: adapter,
      name: agentDefinition.id,
      tools: [
        ...(policy.allows("execute_command")
          ? [
              createExecuteCommandTool({
                workspaceRoot: this.workspaceRoot,
              }),
            ]
          : []),
        ...mcp.tools,
        ...webBrowser.tools,
      ],
      backend: new FilesystemBackend({
        rootDir: this.workspaceRoot,
        virtualMode: true,
      }),
      middleware: [
        createRepeatedToolFailureMiddleware(),
        createSubAgentMiddleware({
          defaultModel: adapter,
          subagents,
          generalPurposeAgent: false,
          systemPrompt: PROJECT_AGENT_DELEGATION_SYSTEM_PROMPT,
          taskDescription: PROJECT_AGENT_TASK_DESCRIPTION,
        }),
        createProjectAgentDelegationGuardMiddleware(
          subagents.map((subagent) => subagent.name),
        ),
        ...(steeringQueue
          ? [
              createSteeringMiddleware(
                steeringQueue,
                (injection) =>
                  this.recordSteeringInjection(
                    runId,
                    session.id,
                    injection,
                  ),
              ),
            ]
          : []),
        createAgentToolPolicyMiddleware(
          policy,
          modelNameAliases,
        ),
        createProjectSkillsMiddleware(
          this.customizations.skills,
          this.workspaceRoot,
        ),
        this.mutationCoordinator.createMiddleware({
          runId,
          hooks: this.mutationHooks(runController),
        }),
        createToolExecutionLedgerMiddleware({
          repository: this.persistence.toolExecutions,
          runId,
        }),
      ],
      ...(persistCheckpoints
        ? { checkpointer: this.persistence.checkpointer }
        : {}),
      interruptOn: {
        write_file: {
          allowedDecisions: ["approve", "reject"],
          description: "Review the proposed file creation before it is applied.",
          when: ({ toolCall }) => !session.allowedTools.has(toolCall.name),
        },
        edit_file: {
          allowedDecisions: ["approve", "reject"],
          description: "Review the proposed file edit before it is applied.",
          when: ({ toolCall }) => !session.allowedTools.has(toolCall.name),
        },
        execute_command: {
          allowedDecisions: ["approve", "reject"],
          description:
            "Review this command carefully. It runs directly on the host in the current workspace.",
          when: ({ toolCall }) => !session.allowedTools.has(toolCall.name),
        },
        ...browserApprovalInterrupts,
      },
      systemPrompt: configureDeepAgentSystemPrompt(
        agentDefinition.body,
        INCLUDE_DEEPAGENTS_DEFAULT_SYSTEM_PROMPT,
      ),
    });
  }

  private logModelPrompt(
    snapshot: ModelPromptSnapshot,
    runId: string,
    session: ChatSession,
    agentId: string,
    model: vscode.LanguageModelChat,
  ): void {
    this.modelCallsOutput.appendLine(
      `[${new Date().toISOString()}] run=${runId} session=${session.id} agent=${agentId} model=${modelKey(model)}`,
    );
    this.modelCallsOutput.appendLine("===== SYSTEM PROMPT =====");
    this.modelCallsOutput.appendLine(snapshot.systemPrompt);
    this.modelCallsOutput.appendLine("===== USER PROMPT =====");
    this.modelCallsOutput.appendLine(snapshot.userPrompt);
    this.modelCallsOutput.appendLine("===== END MODEL CALL =====");
    this.modelCallsOutput.appendLine("");
    this.modelCallsOutput.show(true);
  }

  private async resolveSelectedAgentForRun(
    session: ChatSession,
  ): Promise<
    ProjectAgentDefinition | undefined
  > {
    this.customizations = await discoverProjectCustomizations(
      this.workspaceRoot,
    );
    this.agentRegistry = new ProjectAgentRegistry(this.customizations);
    await this.postWorkbenchState(false);
    const agent = this.agentRegistry.get(session.selectedAgentId);
    return agent?.userInvocable ? agent : undefined;
  }

  private async reviewApprovalActions(
    actions: ApprovalAction[],
    runId: string,
    session: ChatSession,
    controller: ConversationRunController,
    presentation: ApprovalPresentation = {},
  ): Promise<GraphApprovalDecision[]> {
    await this.recordLatestCheckpoint(runId, session);
    const approvalToolCallIds = this.matchApprovalToolCalls(runId, actions);
    const commandGuardError = getCommandGuardError(
      actions,
      this.workspaceRoot,
    );
    let decisions: GraphApprovalDecision[];
    if (commandGuardError) {
      decisions = actions.map(() => ({
        type: "reject" as const,
        message: [
          commandGuardError,
          "Do not retry with another outside-path representation such as /, /root, ~, $HOME, or an absolute home path.",
          "If operating on the workspace is acceptable, retry at most once with the path argument omitted or with '.' exactly.",
          "Otherwise, explain that the requested path is outside the allowed workspace and stop.",
        ].join(" "),
      }));
    } else {
      const freshnessError = await this.mutationCoordinator.reserveApproval(
        runId,
        actions.map((action, index) => ({
          toolCallId: approvalToolCallIds[index],
          name: action.name,
          args: action.args,
        })),
        this.mutationHooks(controller),
      );
      if (freshnessError) {
        decisions = actions.map(() => ({
          type: "reject" as const,
          message: freshnessError,
        }));
      } else {
        this.persistence.runs.setExecutionStatus(runId, "waiting_approval");
        this.setRunPhase(controller, "waiting_approval");
        for (const toolCallId of approvalToolCallIds) {
          this.persistence.toolExecutions.transition(
            runId,
            toolCallId,
            "waiting_approval",
          );
        }
        const decision = await this.requestApproval(
          actions,
          approvalToolCallIds,
          runId,
          session.id,
          controller,
          presentation,
        );
        const approved = decision === "once" || decision === "session";
        this.mutationCoordinator.resolveApproval(
          runId,
          approvalToolCallIds,
          approved,
        );
        if (decision === "session") {
          for (const action of actions) {
            session.allowedTools.add(action.name);
          }
        }
        decisions = actions.map(() =>
          approved
            ? { type: "approve" as const }
            : {
                type: "reject" as const,
                message:
                  decision === "expired"
                    ? "The five-minute mutation approval reservation expired. Read the affected file again before proposing another edit."
                    : "The user denied this tool operation for now.",
              },
        );
      }
    }

    decisions.forEach((decision, index) => {
      const toolCallId = approvalToolCallIds[index];
      const action = actions[index];
      if (decision.type === "approve") {
        if (action.name === "write_file") {
          this.persistence.toolExecutions.setEffectClass(
            runId,
            toolCallId,
            "idempotent_write",
          );
        }
        this.persistence.toolExecutions.transition(
          runId,
          toolCallId,
          "approved",
        );
      } else {
        this.persistence.toolExecutions.transition(
          runId,
          toolCallId,
          "denied",
          encodeToolResult(new ToolMessage({
            content: decision.message,
            tool_call_id: toolCallId,
            name: action.name,
            status: "error",
          })),
        );
      }
    });
    this.setRunPhase(controller, "running");
    return decisions;
  }

  private mutationHooks(
    controller: ConversationRunController,
  ): MutationRunHooks {
    return {
      onWaiting: () =>
        this.setRunPhase(controller, "waiting_mutation"),
      onRunning: () =>
        this.setRunPhase(controller, "running"),
      onApprovalExpired: (toolCallId) =>
        this.expireMutationApproval(controller, toolCallId),
    };
  }

  private async requestApproval(
    actions: ApprovalAction[],
    toolCallIds: string[],
    runId: string,
    sessionId: string,
    controller: ConversationRunController,
    presentation: ApprovalPresentation = {},
  ): Promise<ApprovalResolution> {
    const requestId = presentation.requestId ?? crypto.randomUUID();
    const allowSession = actions.every(
      (action) =>
        action.name === "write_file" ||
        action.name === "edit_file" ||
        action.name === "execute_command",
    );
    const decisionPromise = new Promise<ApprovalResolution>((resolve) => {
      controller.pendingApproval = {
        requestId,
        allowSession,
        actions,
        toolCallIds,
        resolve,
      };
    });
    await this.post({
      type: "approvalRequested",
      sessionId,
      requestId,
      actions,
      allowSession,
    });
    actions.forEach((action, index) => {
      if (presentation.recordRequest !== false) {
        this.persistence.conversationEvents.append({
          sessionId,
          runId,
          eventType: "approval_requested",
          payload: {
            schemaVersion: 1,
            requestId,
            toolName: action.name,
            input: action.args,
          },
        });
      }
      if (!toolCallIds[index]) {
        throw new Error(`Approval action "${action.name}" has no tool call.`);
      }
    });
    if (
      toolCallIds.some((toolCallId) =>
        controller.expiredApprovalToolCallIds.has(toolCallId),
      )
    ) {
      this.resolvePendingApproval(controller, "expired");
    }
    const decision = await decisionPromise;
    await this.post({
      type: "approvalResolved",
      sessionId,
      requestId,
      decision: decision === "expired" ? "deny" : decision,
    });
    this.setRunPhase(controller, "running");
    actions.forEach((action, index) => {
      const persistedDecision =
        decision === "expired" ? "deny" : decision;
      this.persistence.conversationEvents.append({
        sessionId,
        runId,
        eventType: "approval_resolved",
        payload: {
          schemaVersion: 1,
          requestId,
          decision: persistedDecision,
        },
      });
      this.persistence.approvals.record({
        sessionId,
        runId,
        toolCallId: toolCallIds[index],
        toolName: action.name,
        decision: persistedDecision,
        processInstanceId: this.processInstanceId,
      });
    });
    return decision;
  }

  private setRunPhase(
    controller: ConversationRunController,
    phase: ConversationRunPhase,
  ): void {
    if (
      this.activeRuns.get(controller.sessionId) !== controller ||
      controller.phase === phase
    ) {
      return;
    }
    controller.phase = phase;
    void this.postWorkbenchState(false);
  }

  private expireMutationApproval(
    controller: ConversationRunController,
    toolCallId: string,
  ): void {
    controller.expiredApprovalToolCallIds.add(toolCallId);
    if (
      controller.pendingApproval?.toolCallIds.includes(toolCallId)
    ) {
      this.resolvePendingApproval(controller, "expired");
    }
  }

  private matchApprovalToolCalls(
    runId: string,
    actions: ApprovalAction[],
  ): string[] {
    const used = new Set<string>();
    const durableCalls = this.persistence.toolExecutions.list(runId);
    return actions.map((action) => {
      const inputHash = hashToolInput(action.args);
      for (const toolCall of durableCalls) {
        if (
          !used.has(toolCall.toolCallId) &&
          toolCall.toolName === action.name &&
          toolCall.inputHash === inputHash
        ) {
          used.add(toolCall.toolCallId);
          return toolCall.toolCallId;
        }
      }
      throw new Error(
        `Could not correlate approval action "${action.name}" with a durable tool call.`,
      );
    });
  }

  private findPendingApprovalRequestId(
    sessionId: string,
    runId: string,
  ): string | undefined {
    const pending = [
      ...projectConversationEvents(
        this.persistence.conversationEvents.list(sessionId),
      ),
    ].reverse().find(
      (item) =>
        item.kind === "approval_requested" &&
        item.runId === runId &&
        item.status === "pending",
    );
    return pending?.kind === "approval_requested"
      ? pending.requestId
      : undefined;
  }

  private async recordLatestCheckpoint(
    runId: string,
    session: ChatSession,
  ): Promise<void> {
    const tuple = await this.persistence.checkpointer.getTuple({
      configurable: {
        thread_id: session.threadId,
        checkpoint_ns: "",
      },
    });
    if (tuple?.checkpoint.id) {
      this.persistence.runs.recordCheckpoint(runId, tuple.checkpoint.id);
    }
  }

  private resolvePendingApproval(
    controller: ConversationRunController,
    decision: ApprovalResolution,
  ): void {
    const pending = controller.pendingApproval;
    if (!pending) {
      return;
    }
    controller.pendingApproval = undefined;
    pending.resolve(decision);
  }

  private async generateSessionTitle(
    sessionId: string,
    firstMessage: string,
    model: vscode.LanguageModelChat,
  ): Promise<void> {
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const response = await model.sendRequest(
        [
          vscode.LanguageModelChatMessage.User(
            [
              "Create a concise 5-7 word chat title based on the first user message below.",
              "Use the same language as the user's message.",
              "Return only the title with no quotes, markdown, label, or explanation.",
              "",
              "<first-message>",
              firstMessage.slice(0, 4_000),
              "</first-message>",
            ].join("\n"),
          ),
        ],
        {
          justification:
            "Generate a short title for the in-memory chat session requested by the user.",
        },
        cancellation.token,
      );
      let generated = "";
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          generated += part.value;
        }
      }
      const session = this.sessions.find((item) => item.id === sessionId);
      if (session && session.title === "New chat") {
        session.title = sanitizeGeneratedTitle(generated, firstMessage);
        if (this.persistence.sessions.setGeneratedTitle(session.id, session.title)) {
          this.persistence.conversationEvents.append({
            sessionId: session.id,
            eventType: "title_changed",
            payload: { schemaVersion: 1, title: session.title },
          });
        }
        await this.postWorkbenchState(false);
      }
    } catch {
      const session = this.sessions.find((item) => item.id === sessionId);
      if (session && session.title === "New chat") {
        session.title = fallbackTitle(firstMessage);
        if (this.persistence.sessions.setGeneratedTitle(session.id, session.title)) {
          this.persistence.conversationEvents.append({
            sessionId: session.id,
            eventType: "title_changed",
            payload: { schemaVersion: 1, title: session.title },
          });
        }
        await this.postWorkbenchState(false);
      }
    } finally {
      cancellation.dispose();
    }
  }

  private async postWorkbenchState(replaceMessages: boolean): Promise<void> {
    const active = this.activeSession;
    const activeRun = this.activeRuns.get(active.id);
    const replayItems = replaceMessages
      ? prepareReplayItems(
          projectConversationEvents(
            this.persistence.conversationEvents.list(active.id),
          ),
        ).map((item) =>
          item.kind === "message" && item.role === "assistant"
            ? { ...item, html: renderMarkdown(item.content) }
            : item
        )
      : undefined;
    this.panel.title = active.title === "New chat" ? "Deep Agents Workbench" : active.title;
    await this.post({
      type: "workbenchState",
      replaceMessages,
      currentSessionId: active.id,
      running: Boolean(activeRun) || this.startingSessions.has(active.id),
      activeRunCount: this.occupiedRunSlots,
      maxActiveConversations: MAX_ACTIVE_CONVERSATIONS,
      liveDraft: activeRun?.liveDraft ?? "",
      liveDraftHtml: activeRun?.liveDraft
        ? renderMarkdown(activeRun.liveDraft)
        : "",
      pendingApproval: activeRun?.pendingApproval
        ? {
            requestId: activeRun.pendingApproval.requestId,
            actions: activeRun.pendingApproval.actions,
            allowSession: activeRun.pendingApproval.allowSession,
          }
        : undefined,
      selectedModelKey: this.selectedModelKey,
      selectedAgentId: active.selectedAgentId,
      agents: this.agentRegistry.listUserInvocable().map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        argumentHint: agent.argumentHint,
      })),
      models: this.models.map((model) => ({
        key: modelKey(model),
        name: model.name,
        family: model.family,
        vendor: model.vendor,
      })),
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        activity:
          this.activeRuns.get(session.id)?.phase === "waiting_approval"
            ? "attention"
            : this.isSessionBusy(session.id)
              ? "running"
              : "idle",
      })),
      recoveries: this.persistence.recovery.listForSession(active.id).map(
        (recovery) => ({
          runId: recovery.run.id,
          recoveryClass: recovery.recoveryClass,
          reason: recovery.reason,
          toolCallId: recovery.uncertainToolCallId,
          toolName: recovery.uncertainToolName,
        }),
      ),
      replayItems,
    });
  }

  private async postAdapterEvent(
    event: AdapterEvent,
    controller: ConversationRunController,
  ): Promise<void> {
    const { runId, sessionId } = controller;
    if (event.kind === "text") {
      await this.post({
        type: "textDelta",
        sessionId,
        text: event.text,
        content: controller.liveDraft,
        html: renderMarkdown(controller.liveDraft),
      });
    } else if (event.kind === "toolCall") {
      const input = toRecord(event.input);
      controller.liveDraft = "";
      controller.toolCalls.set(event.id, { name: event.name, input });
      this.persistence.toolExecutions.request({
        runId,
        toolCallId: event.id,
        toolName: event.name,
        arguments: input,
        inputHash: hashToolInput(input),
        effectClass: classifyToolEffect(event.name),
      });
      this.persistence.conversationEvents.append({
        sessionId,
        runId,
        eventType: "tool_call",
        payload: {
          schemaVersion: 1,
          toolCallId: event.id,
          toolName: event.name,
          input,
          label: describeToolActivity(event.name, input, "running"),
        },
      });
      await this.post({
        type: "toolCall",
        sessionId,
        id: event.id,
        name: event.name,
        input,
        label: describeToolActivity(event.name, input, "running"),
      });
    } else {
      controller.liveDraft = "";
      const toolCall = controller.toolCalls.get(event.id);
      const outcome = event.text.trimStart().startsWith("Blocked")
        ? "blocked"
        : event.text.trimStart().startsWith("Error")
          ? "failed"
          : "completed";
      this.persistence.conversationEvents.append({
        sessionId,
        runId,
        eventType: "tool_result",
        payload: {
          schemaVersion: 1,
          toolCallId: event.id,
          output: event.text.slice(0, 100_000),
          truncated: event.text.length > 100_000,
          originalLength: event.text.length,
          retainedLength: Math.min(event.text.length, 100_000),
          label: toolCall
            ? describeToolActivity(toolCall.name, toolCall.input, outcome)
            : undefined,
        },
      });
      await this.post({
        type: "toolResult",
        sessionId,
        id: event.id,
        text: event.text.slice(0, 8_000),
        label: toolCall
          ? describeToolActivity(toolCall.name, toolCall.input, outcome)
          : outcome === "blocked"
            ? "Blocked tool call"
            : outcome === "failed"
              ? "Tool call failed"
              : "Completed tool call",
      });
    }
  }

  private async post(message: Record<string, unknown>): Promise<void> {
    await this.panel.webview.postMessage(message);
  }
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "steer"; requestId: string; text: string }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "selectModel"; modelKey: string }
  | { type: "selectAgent"; agentId: string }
  | { type: "newSession" }
  | { type: "selectSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "deleteSession"; sessionId: string }
  | {
      type: "approval";
      requestId: string;
      decision: ApprovalDecision;
    }
  | {
      type: "reconcileRecovery";
      runId: string;
      decision: "mark_completed" | "retry" | "abandon";
    }
  | { type: "resumePendingApproval"; runId: string };

type ApprovalDecision = "once" | "session" | "deny";
type ApprovalResolution = ApprovalDecision | "expired";
type GraphApprovalDecision =
  | { type: "approve" }
  | { type: "reject"; message: string };

interface ApprovalPresentation {
  requestId?: string;
  recordRequest?: boolean;
}

interface ApprovalAction {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

interface ApprovalRequest {
  actions: ApprovalAction[];
}

function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  const type = (value as { type: unknown }).type;
  if (
    type === "ready" ||
    type === "cancel" ||
    type === "clear" ||
    type === "newSession"
  ) {
    return true;
  }
  if (type === "selectModel") {
    return typeof (value as { modelKey?: unknown }).modelKey === "string";
  }
  if (type === "selectAgent") {
    return typeof (value as { agentId?: unknown }).agentId === "string";
  }
  if (type === "selectSession" || type === "deleteSession") {
    return typeof (value as { sessionId?: unknown }).sessionId === "string";
  }
  if (type === "renameSession") {
    const message = value as { sessionId?: unknown; title?: unknown };
    return typeof message.sessionId === "string" && typeof message.title === "string";
  }
  if (type === "approval") {
    const message = value as {
      requestId?: unknown;
      decision?: unknown;
    };
    return (
      typeof message.requestId === "string" &&
      (message.decision === "once" ||
        message.decision === "session" ||
        message.decision === "deny")
    );
  }
  if (type === "reconcileRecovery") {
    const message = value as { runId?: unknown; decision?: unknown };
    return (
      typeof message.runId === "string" &&
      (message.decision === "mark_completed" ||
        message.decision === "retry" ||
        message.decision === "abandon")
    );
  }
  if (type === "resumePendingApproval") {
    return typeof (value as { runId?: unknown }).runId === "string";
  }
  if (type === "steer") {
    const message = value as { requestId?: unknown; text?: unknown };
    return (
      typeof message.requestId === "string" &&
      typeof message.text === "string"
    );
  }
  return type === "send" && typeof (value as { text?: unknown }).text === "string";
}

function extractApprovalRequest(result: unknown): ApprovalRequest | undefined {
  if (!result || typeof result !== "object" || !("__interrupt__" in result)) {
    return undefined;
  }
  const interrupts = (result as { __interrupt__?: unknown }).__interrupt__;
  if (!Array.isArray(interrupts) || interrupts.length === 0) {
    return undefined;
  }
  const value = (interrupts[0] as { value?: unknown })?.value;
  if (!value || typeof value !== "object" || !("actionRequests" in value)) {
    return undefined;
  }
  const rawActions = (value as { actionRequests?: unknown }).actionRequests;
  if (!Array.isArray(rawActions)) {
    return undefined;
  }
  const actions = rawActions.filter(isApprovalAction);
  return actions.length > 0 ? { actions } : undefined;
}

function isApprovalAction(value: unknown): value is ApprovalAction {
  return Boolean(
    value &&
      typeof value === "object" &&
      "name" in value &&
      typeof value.name === "string" &&
      "args" in value &&
      value.args &&
      typeof value.args === "object",
  );
}

function getCommandGuardError(
  actions: ApprovalAction[],
  workspaceRoot: string,
): string | undefined {
  for (const action of actions) {
    if (action.name !== "execute_command") {
      continue;
    }
    const executable = action.args.executable;
    const args = action.args.args;
    if (
      typeof executable !== "string" ||
      !Array.isArray(args) ||
      !args.every((arg) => typeof arg === "string")
    ) {
      return "Blocked execute_command: invalid executable or argument vector.";
    }
    try {
      validateExecuteCommandInput(
        { executable, args: args as string[] },
        workspaceRoot,
      );
    } catch (error) {
      return `Blocked execute_command before approval: ${formatError(error)}`;
    }
  }
  return undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? "");
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && "text" in part) {
        return String(part.text);
      }
      return "";
    })
    .join("");
}

function formatError(error: unknown): string {
  if (error instanceof vscode.LanguageModelError) {
    return `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

type ToolActivityPhase = "running" | "completed" | "blocked" | "failed";

function describeToolActivity(
  name: string,
  input: Record<string, unknown>,
  phase: ToolActivityPhase,
): string {
  const path = displayToolValue(input.file_path ?? input.path, "workspace");
  const pattern = displayToolValue(input.pattern, "");
  const description = displayToolValue(input.description, "delegated task");
  const command = truncateActivityText(
    [
      displayToolValue(input.executable, "command"),
      ...(Array.isArray(input.args)
        ? input.args.map((arg) => displayToolValue(arg, "")).filter(Boolean)
        : []),
    ].join(" "),
  );

  const labels: Record<string, [string, string, string]> = {
    ls: [`Listing ${path === "workspace" ? "workspace files" : `${path} files`}…`,
      `Listed ${path === "workspace" ? "workspace files" : `${path} files`}`,
      `List ${path === "workspace" ? "workspace files" : `${path} files`}`],
    read_file: [`Reading ${path}…`, `Read ${path}`, `Read ${path}`],
    write_file: [`Writing ${path}…`, `Wrote ${path}`, `Write ${path}`],
    edit_file: [`Editing ${path}…`, `Edited ${path}`, `Edit ${path}`],
    glob: [
      `Finding files${pattern ? ` matching ${pattern}` : ""}…`,
      `Found files${pattern ? ` matching ${pattern}` : ""}`,
      `Find files${pattern ? ` matching ${pattern}` : ""}`,
    ],
    grep: [
      `Searching${pattern ? ` for “${pattern}”` : ""}…`,
      `Searched${pattern ? ` for “${pattern}”` : ""}`,
      `Search${pattern ? ` for “${pattern}”` : ""}`,
    ],
    execute_command: [`Running ${command}…`, `Ran ${command}`, `Run ${command}`],
    task: [
      `Delegating: ${description}…`,
      `Finished delegated task: ${description}`,
      `Delegate: ${description}`,
    ],
    write_todos: ["Updating task list…", "Updated task list", "Update task list"],
  };
  const humanName = name.replaceAll("_", " ");
  const [running, completed, action] = labels[name] ?? [
    `Using ${humanName}…`,
    `Used ${humanName}`,
    `Use ${humanName}`,
  ];

  if (phase === "running") {
    return running;
  }
  if (phase === "blocked") {
    return `Blocked: ${action}`;
  }
  if (phase === "failed") {
    return `Failed: ${action}`;
  }
  return completed;
}

function displayToolValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact || compact === "/" || compact === ".") {
    return fallback;
  }
  const workspaceRelative = compact.startsWith("/") ? compact.slice(1) : compact;
  return workspaceRelative.length > 64
    ? `${workspaceRelative.slice(0, 61)}…`
    : workspaceRelative;
}

function truncateActivityText(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}…` : value;
}

function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function prepareReplayItems(
  items: ConversationReplayItem[],
): ConversationReplayItem[] {
  return items.map((item) => {
    if (item.kind === "tool_call" && !item.label) {
      const input =
        item.input && typeof item.input === "object"
          ? toRecord(item.input)
          : {};
      return {
        ...item,
        label: describeToolActivity(item.toolName, input, "running"),
      };
    }
    if (item.kind === "tool_result" && !item.label) {
      const output = typeof item.output === "string" ? item.output : "";
      const phase = output.trimStart().startsWith("Blocked")
        ? "blocked"
        : output.trimStart().startsWith("Error")
          ? "failed"
          : "completed";
      return {
        ...item,
        label: item.toolName
          ? describeToolActivity(item.toolName, {}, phase)
          : phase === "blocked"
            ? "Blocked tool call"
            : phase === "failed"
              ? "Tool call failed"
              : "Completed tool call",
      };
    }
    return item;
  });
}

function createSession(
  persistence: PersistenceService,
  selectedModelKey: string,
  processInstanceId: string,
): ChatSession {
  const stored = persistence.sessions.create({ selectedModelKey });
  return {
    id: stored.id,
    threadId: stored.threadId,
    title: stored.title,
    selectedModelKey,
    selectedAgentId: null,
    transcript: [],
    allowedTools: allowedToolsForSession(processInstanceId, stored.id),
  };
}

function loadSessions(
  persistence: PersistenceService,
  fallbackModelKey: string,
  processInstanceId: string,
): ChatSession[] {
  return persistence.sessions.list().map((session) => ({
    id: session.id,
    threadId: session.threadId,
    title: session.title,
    selectedModelKey: session.selectedModelKey ?? fallbackModelKey,
    selectedAgentId: session.selectedAgentId,
    transcript: persistence.conversationEvents
      .list(session.id)
      .filter(
        (event) =>
          event.eventType === "user_message" ||
          event.eventType === "assistant_message",
      )
      .map((event) => ({
        role:
          event.eventType === "user_message"
            ? ("user" as const)
            : ("assistant" as const),
        content: String(event.payload.content),
      })),
    allowedTools: allowedToolsForSession(processInstanceId, session.id),
  }));
}

function allowedToolsForSession(
  processInstanceId: string,
  sessionId: string,
): Set<string> {
  const key = processApprovalGrantKey(processInstanceId, sessionId);
  let allowed = processAllowedTools.get(key);
  if (!allowed) {
    allowed = new Set<string>();
    processAllowedTools.set(key, allowed);
  }
  return allowed;
}

function processApprovalGrantKey(
  processInstanceId: string,
  sessionId: string,
): string {
  return `${processInstanceId}:${sessionId}`;
}

function modelKey(model: vscode.LanguageModelChat): string {
  return `${model.vendor}:${model.id}`;
}

function sanitizeManualTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function sanitizeGeneratedTitle(generated: string, firstMessage: string): string {
  const firstLine = generated
    .split(/\r?\n/, 1)[0]
    .replace(/^#+\s*/, "")
    .replace(/^["'`]+|["'`.:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return firstLine || fallbackTitle(firstMessage);
}

function fallbackTitle(firstMessage: string): string {
  const words = firstMessage.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, 7).join(" ").slice(0, 80) || "New chat";
}

function leaseExpiration(): string {
  return new Date(Date.now() + RUN_LEASE_MS).toISOString();
}

function renderWebview(
  webview: vscode.Webview,
  workspaceRoot: string,
): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const escapedRoot = escapeHtml(workspaceRoot);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Deep Agents Spike</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
    }
    body {
      margin: 0;
      overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }
    .workbench {
      height: 100%;
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-columns: 232px minmax(0, 1fr);
    }
    .sessions {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      background: var(--vscode-sideBar-background);
      border-right: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
    }
    .sessions-head {
      padding: 13px 12px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .sessions-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--vscode-sideBarTitle-foreground);
    }
    #new-chat {
      width: 26px;
      height: 26px;
      padding: 0;
      border-radius: 4px;
      font-size: 18px;
      line-height: 1;
    }
    #session-list {
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      padding: 8px;
    }
    .session-row {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px;
      align-items: center;
      margin-bottom: 3px;
      padding: 7px 5px 7px 9px;
      border: 1px solid transparent;
      border-radius: 5px;
      cursor: pointer;
    }
    .session-row:hover { background: var(--vscode-list-hoverBackground); }
    .session-row.active {
      color: var(--vscode-list-activeSelectionForeground);
      background: var(--vscode-list-activeSelectionBackground);
      border-color: var(--vscode-focusBorder);
    }
    .session-name {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 12px;
    }
    .session-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .session-status {
      width: 12px;
      height: 12px;
      flex: 0 0 12px;
    }
    .session-status.spinner {
      border: 2px solid color-mix(in srgb, currentColor 28%, transparent);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: session-spin .75s linear infinite;
    }
    .session-status.attention {
      display: grid;
      place-items: center;
      border-radius: 50%;
      color: var(--vscode-notificationsWarningIcon-foreground, #cca700);
      font-size: 12px;
      font-weight: 800;
    }
    .session-status.attention::before { content: "!"; }
    @keyframes session-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .session-status.spinner { animation-duration: 1.8s; }
    }
    .session-controls { display: flex; opacity: 0; }
    .session-row:hover .session-controls,
    .session-row.active .session-controls { opacity: 1; }
    .icon-button {
      width: 23px;
      height: 23px;
      padding: 0;
      border: 0;
      color: inherit;
      background: transparent;
      border-radius: 3px;
    }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .rename-input {
      width: 100%;
      min-width: 0;
      padding: 3px 5px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder);
      font: inherit;
    }
    .sessions-foot {
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .conversation {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
    }
    header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }
    .meta { min-width: 0; }
    .title { font-weight: 600; }
    .subtitle {
      opacity: .7;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      padding: 6px 10px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled { opacity: .55; cursor: default; }
    #messages {
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message {
      max-width: 88%;
      padding: 10px 12px;
      border-radius: 7px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.45;
    }
    .message.markdown {
      white-space: normal;
    }
    .message.markdown > :first-child { margin-top: 0; }
    .message.markdown > :last-child { margin-bottom: 0; }
    .message.markdown p { margin: 0 0 .75em; }
    .message.markdown h1,
    .message.markdown h2,
    .message.markdown h3,
    .message.markdown h4,
    .message.markdown h5,
    .message.markdown h6 {
      margin: 1em 0 .45em;
      line-height: 1.25;
    }
    .message.markdown h1 { font-size: 1.5em; }
    .message.markdown h2 { font-size: 1.3em; }
    .message.markdown h3 { font-size: 1.15em; }
    .message.markdown ul,
    .message.markdown ol {
      margin: .35em 0 .8em;
      padding-left: 1.75em;
    }
    .message.markdown li + li { margin-top: .25em; }
    .message.markdown pre {
      max-width: 100%;
      margin: .65em 0;
      padding: 9px 10px;
      overflow: auto;
      white-space: pre;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
    }
    .message.markdown code {
      font-family: var(--vscode-editor-font-family);
      font-size: .92em;
    }
    .message.markdown :not(pre) > code {
      padding: .1em .3em;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
    }
    .message.markdown blockquote {
      margin: .65em 0;
      padding-left: .85em;
      color: var(--vscode-descriptionForeground);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
    }
    .message.markdown a {
      color: var(--vscode-textLink-foreground);
    }
    .message.markdown table {
      display: block;
      max-width: 100%;
      overflow: auto;
      border-collapse: collapse;
    }
    .message.markdown th,
    .message.markdown td {
      padding: 5px 8px;
      border: 1px solid var(--vscode-widget-border);
    }
    .user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .assistant {
      align-self: flex-start;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
    }
    .message.steering {
      border: 1px dashed var(--vscode-focusBorder);
    }
    .message.steering::before {
      content: "Steering";
      display: block;
      margin-bottom: 4px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      opacity: .75;
    }
    .message.steering.discarded {
      opacity: .65;
      text-decoration: line-through;
    }
    .activity {
      align-self: stretch;
      border-left: 2px solid var(--vscode-progressBar-background);
      padding: 6px 9px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      background: var(--vscode-textBlockQuote-background);
    }
    .activity summary { cursor: pointer; }
    .activity pre {
      margin: 7px 0 0;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .approval {
      align-self: stretch;
      padding: 12px;
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      background: var(--vscode-inputValidation-warningBackground);
    }
    .approval-title { font-weight: 600; margin-bottom: 8px; }
    .approval details { margin: 6px 0; }
    .approval pre {
      max-height: 260px;
      overflow: auto;
      padding: 8px;
      white-space: pre-wrap;
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .approval-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .approval .deny {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .approval-status { margin-top: 8px; opacity: .8; }
    .recovery {
      align-self: stretch;
      padding: 12px;
      border: 1px solid var(--vscode-inputValidation-infoBorder);
      background: var(--vscode-inputValidation-infoBackground);
    }
    .recovery.needs-review {
      border-color: var(--vscode-inputValidation-warningBorder);
      background: var(--vscode-inputValidation-warningBackground);
    }
    .recovery-title { font-weight: 600; margin-bottom: 6px; }
    .recovery-reason { line-height: 1.4; }
    .recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .recovery .deny {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    #empty { opacity: .65; margin: auto; text-align: center; }
    form {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    textarea {
      width: 100%;
      resize: vertical;
      min-height: 72px;
      max-height: 240px;
      padding: 9px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      font: inherit;
    }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }
    .primary-actions { display: flex; gap: 8px; }
    #primary-action {
      width: 34px;
      height: 30px;
      padding: 0;
      display: inline-grid;
      place-items: center;
      border-radius: 4px;
      font-size: 18px;
      line-height: 1;
    }
    .selectors {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    #model-select, #agent-select {
      max-width: min(340px, 50vw);
      min-width: 150px;
      padding: 5px 24px 5px 7px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      font: inherit;
    }
    @media (max-width: 720px) {
      .workbench { grid-template-columns: 180px minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <div class="workbench">
    <aside class="sessions" aria-label="Chat sessions">
      <div class="sessions-head">
        <span class="sessions-title">Sessions</span>
        <button id="new-chat" type="button" title="New chat" aria-label="New chat">+</button>
      </div>
      <div id="session-list"></div>
      <div class="sessions-foot">Stored in this workspace</div>
    </aside>
    <section class="conversation">
      <header>
        <div class="meta">
          <div class="title">Deep Agents Workbench</div>
          <div id="subtitle" class="subtitle" title="${escapedRoot}">${escapedRoot}</div>
        </div>
        <button id="clear" class="secondary" type="button">Clear</button>
      </header>
      <main id="messages">
        <div id="empty">Start a conversation with a workspace-scoped agent.</div>
      </main>
      <form id="form">
        <textarea id="prompt" aria-label="Message" placeholder="Ask the agent to inspect, build, test, or edit this workspace."></textarea>
        <div class="actions">
          <div class="selectors">
            <select id="agent-select" aria-label="Project agent"></select>
            <select id="model-select" aria-label="Language model"></select>
          </div>
          <div class="primary-actions">
            <button id="primary-action" type="submit" title="Send message" aria-label="Send message">
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </form>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const form = document.getElementById("form");
    const prompt = document.getElementById("prompt");
    const primaryAction = document.getElementById("primary-action");
    const clear = document.getElementById("clear");
    const newChat = document.getElementById("new-chat");
    const sessionList = document.getElementById("session-list");
    const agentSelect = document.getElementById("agent-select");
    const modelSelect = document.getElementById("model-select");
    const subtitle = document.getElementById("subtitle");
    let draft = null;
    let running = false;
    let currentSessionId = "";
    const pendingSteering = new Map();
    const resolveComposerControlState =
      ${resolveComposerControlState.toString()};

    function updateComposerControl() {
      const state = resolveComposerControlState(
        running,
        prompt.value,
        Boolean(agentSelect.value),
      );
      primaryAction.dataset.action = state.action;
      primaryAction.disabled = state.disabled;
      primaryAction.title = state.label;
      primaryAction.setAttribute("aria-label", state.label);
      primaryAction.querySelector("span").textContent = state.icon;
      return state;
    }

    function setMessageContent(element, role, text, html) {
      element.dataset.rawText = text;
      if (role === "assistant" && typeof html === "string") {
        element.classList.add("markdown");
        element.innerHTML = html;
      } else {
        element.classList.remove("markdown");
        element.textContent = text;
      }
    }

    function addMessage(role, text, html) {
      document.getElementById("empty")?.remove();
      const element = document.createElement("div");
      element.className = "message " + role;
      setMessageContent(element, role, text, html);
      messages.appendChild(element);
      messages.scrollTop = messages.scrollHeight;
      return element;
    }

    function addSteeringMessage(requestId, text, status = "queued") {
      let element = document.querySelector(
        '[data-steering-id="' + CSS.escape(requestId) + '"]'
      );
      if (!element) {
        element = addMessage("user steering", text);
        element.dataset.steeringId = requestId;
      } else if (text) {
        element.textContent = text;
      }
      element.classList.toggle("discarded", status === "discarded");
      element.dataset.steeringStatus = status;
      element.title = status === "injected"
        ? "Steering applied at a safe model boundary"
        : status === "discarded"
          ? "Steering was not applied"
          : "Steering queued for the next safe model boundary";
      return element;
    }

    function addActivity(id, title, body) {
      document.getElementById("empty")?.remove();
      let element = document.querySelector('[data-call-id="' + CSS.escape(id) + '"]');
      if (!element) {
        element = document.createElement("details");
        element.className = "activity";
        element.dataset.callId = id;
        const summary = document.createElement("summary");
        element.appendChild(summary);
        const pre = document.createElement("pre");
        element.appendChild(pre);
        messages.appendChild(element);
      }
      element.querySelector("summary").textContent = title;
      element.querySelector("pre").textContent = body;
      messages.scrollTop = messages.scrollHeight;
    }

    function addApproval(requestId, actions, allowSession, interactive = true) {
      document.getElementById("empty")?.remove();
      let element = document.querySelector(
        '[data-approval-id="' + CSS.escape(requestId) + '"]'
      );
      if (!element) {
        element = document.createElement("section");
        element.className = "approval";
        element.dataset.approvalId = requestId;
        const title = document.createElement("div");
        title.className = "approval-title";
        element.appendChild(title);
        messages.appendChild(element);
      }
      if (interactive) {
        for (const details of element.querySelectorAll("details")) {
          details.remove();
        }
      }

      for (const action of actions) {
        const details = document.createElement("details");
        details.open = interactive;
        const summary = document.createElement("summary");
        summary.textContent = action.name;
        details.appendChild(summary);
        if (action.description) {
          const description = document.createElement("div");
          description.textContent = action.description;
          details.appendChild(description);
        }
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(action.args, null, 2);
        details.appendChild(pre);
        element.insertBefore(
          details,
          element.querySelector(".approval-status, .approval-actions"),
        );
      }

      const actionCount = element.querySelectorAll("details").length;
      element.querySelector(".approval-title").textContent = actionCount === 1
        ? "Approval required: " + actions[0].name
        : "Approval required for " + actionCount + " operations";

      if (interactive && !element.querySelector(".approval-actions")) {
        const controls = document.createElement("div");
        controls.className = "approval-actions";
        const choices = [
          ["once", "Allow once", ""],
          ["deny", "Deny for now", "deny"],
        ];
        if (allowSession) {
          choices.splice(1, 0, ["session", "Allow for session", ""]);
        }
        for (const [decision, label, className] of choices) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.className = className;
          button.addEventListener("click", () => {
            for (const control of controls.querySelectorAll("button")) {
              control.disabled = true;
            }
            vscode.postMessage({ type: "approval", requestId, decision });
          });
          controls.appendChild(button);
        }
        element.appendChild(controls);
      }
      messages.scrollTop = messages.scrollHeight;
    }

    function resolveApproval(requestId, decision) {
      const element = document.querySelector(
        '[data-approval-id="' + CSS.escape(requestId) + '"]'
      );
      if (!element) {
        element = document.createElement("section");
        element.className = "approval";
        element.dataset.approvalId = requestId;
        const title = document.createElement("div");
        title.className = "approval-title";
        title.textContent = "Approval decision";
        element.appendChild(title);
        messages.appendChild(element);
      }
      element.querySelector(".approval-actions")?.remove();
      element.querySelector(".approval-status")?.remove();
      const status = document.createElement("div");
      status.className = "approval-status";
      status.textContent = decision === "once"
        ? "Allowed once"
        : decision === "session"
          ? "Allowed for this session"
          : "Denied for now";
      element.appendChild(status);
    }

    function replaceConversation(replayItems) {
      messages.replaceChildren();
      draft = null;
      if (!replayItems?.length) {
        const emptyState = document.createElement("div");
        emptyState.id = "empty";
        emptyState.textContent = "Start a conversation with a workspace-scoped agent.";
        messages.appendChild(emptyState);
        return;
      }
      for (const item of replayItems) {
        if (item.kind === "message") {
          addMessage(item.role, item.content, item.html);
        } else if (item.kind === "steering_message") {
          addSteeringMessage(item.steeringId, item.content, item.status);
        } else if (item.kind === "tool_call") {
          addActivity(
            item.toolCallId,
            item.label || "Tool call",
            JSON.stringify(item.input, null, 2),
          );
        } else if (item.kind === "tool_result") {
          let output = typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output, null, 2);
          if (item.truncation?.truncated) {
            output += "\\n\\n[Persisted output was truncated]";
          }
          addActivity(item.toolCallId, item.label || "Tool result", output);
        } else if (item.kind === "approval_requested") {
          addApproval(item.requestId, [{
            name: item.toolName,
            args: item.input || {},
          }], false, false);
          if (item.status === "resolved") {
            resolveApproval(item.requestId, item.decision);
          }
        } else if (item.kind === "approval_resolved") {
          resolveApproval(item.requestId, item.decision);
        } else if (item.kind === "run_status") {
          addMessage(
            "assistant",
            item.status === "cancelled"
              ? "Cancelled: " + item.message
              : "Error: " + item.message,
          );
        }
      }
      messages.scrollTop = messages.scrollHeight;
    }

    function renderRecoveries(recoveries) {
      for (const recovery of recoveries || []) {
        document.getElementById("empty")?.remove();
        const element = document.createElement("section");
        element.className = "recovery" +
          (recovery.recoveryClass === "needs_review" ? " needs-review" : "");
        const title = document.createElement("div");
        title.className = "recovery-title";
        title.textContent = recovery.recoveryClass === "safe_to_resume"
          ? "Interrupted run is safe to resume"
          : recovery.recoveryClass === "waiting_for_approval"
            ? "Interrupted run is waiting for approval"
            : recovery.recoveryClass === "needs_review"
              ? "Interrupted tool operation needs review"
              : "Interrupted run cannot be resumed";
        element.appendChild(title);
        const reason = document.createElement("div");
        reason.className = "recovery-reason";
        reason.textContent = recovery.reason;
        element.appendChild(reason);
        if (recovery.recoveryClass === "needs_review" && recovery.toolCallId) {
          const actions = document.createElement("div");
          actions.className = "recovery-actions";
          for (const [decision, label, className] of [
            ["mark_completed", "Mark completed", ""],
            ["retry", "Retry", ""],
            ["abandon", "Abandon run", "deny"],
          ]) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.className = className;
            button.addEventListener("click", () => {
              vscode.postMessage({
                type: "reconcileRecovery",
                runId: recovery.runId,
                decision,
              });
            });
            actions.appendChild(button);
          }
          element.appendChild(actions);
        } else if (recovery.recoveryClass === "waiting_for_approval") {
          const actions = document.createElement("div");
          actions.className = "recovery-actions";
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Review pending action";
          button.addEventListener("click", () => {
            vscode.postMessage({
              type: "resumePendingApproval",
              runId: recovery.runId,
            });
          });
          actions.appendChild(button);
          element.appendChild(actions);
        }
        messages.appendChild(element);
      }
    }

    function beginRename(row, session) {
      const name = row.querySelector(".session-name");
      const input = document.createElement("input");
      input.className = "rename-input";
      input.value = session.title;
      name.replaceWith(input);
      input.focus();
      input.select();
      let submitted = false;
      const submit = () => {
        if (submitted) return;
        submitted = true;
        const title = input.value.trim();
        if (title) {
          vscode.postMessage({
            type: "renameSession",
            sessionId: session.id,
            title,
          });
        }
      };
      input.addEventListener("blur", submit);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        } else if (event.key === "Escape") {
          submitted = true;
          vscode.postMessage({ type: "ready" });
        }
      });
    }

    function renderSessions(sessions) {
      sessionList.replaceChildren();
      for (const session of sessions) {
        const row = document.createElement("div");
        row.className = "session-row" + (session.id === currentSessionId ? " active" : "");
        row.title = session.title;
        row.addEventListener("click", () => {
          if (session.id !== currentSessionId) {
            vscode.postMessage({ type: "selectSession", sessionId: session.id });
          }
        });

        const main = document.createElement("span");
        main.className = "session-main";
        if (session.activity !== "idle") {
          const status = document.createElement("span");
          status.className = "session-status " +
            (session.activity === "attention" ? "attention" : "spinner");
          status.title = session.activity === "attention"
            ? "Approval required"
            : "Agent is working";
          status.setAttribute("aria-label", status.title);
          main.appendChild(status);
        }
        const name = document.createElement("span");
        name.className = "session-name";
        name.textContent = session.title;
        main.appendChild(name);
        row.appendChild(main);

        const controls = document.createElement("span");
        controls.className = "session-controls";
        const rename = document.createElement("button");
        rename.className = "icon-button";
        rename.type = "button";
        rename.title = "Rename chat";
        rename.textContent = "✎";
        rename.disabled = session.activity !== "idle";
        rename.addEventListener("click", (event) => {
          event.stopPropagation();
          if (session.activity === "idle") beginRename(row, session);
        });
        const remove = document.createElement("button");
        remove.className = "icon-button";
        remove.type = "button";
        remove.title = "Delete chat";
        remove.textContent = "×";
        remove.disabled = session.activity !== "idle";
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          if (session.activity === "idle") {
            vscode.postMessage({ type: "deleteSession", sessionId: session.id });
          }
        });
        controls.append(rename, remove);
        row.appendChild(controls);
        sessionList.appendChild(row);
      }
    }

    function renderModels(models, selectedModelKey) {
      const existing = Array.from(modelSelect.options).map((option) => option.value);
      const incoming = models.map((model) => model.key);
      if (existing.join("\\n") !== incoming.join("\\n")) {
        modelSelect.replaceChildren();
        for (const model of models) {
          const option = document.createElement("option");
          option.value = model.key;
          option.textContent = model.name + " · " + model.family;
          modelSelect.appendChild(option);
        }
      }
      modelSelect.value = selectedModelKey;
      const selected = models.find((model) => model.key === selectedModelKey);
      subtitle.textContent = selected
        ? selected.name + " · ${escapedRoot}"
        : "${escapedRoot}";
    }

    function renderAgents(agents, selectedAgentId) {
      const existing = Array.from(agentSelect.options).map(
        (option) => option.value,
      );
      const incoming = ["", ...agents.map((agent) => agent.id)];
      if (existing.join("\\n") !== incoming.join("\\n")) {
        agentSelect.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Select an agent";
        agentSelect.appendChild(placeholder);
        for (const agent of agents) {
          const option = document.createElement("option");
          option.value = agent.id;
          option.textContent = agent.name;
          option.title = agent.description || agent.argumentHint || agent.name;
          agentSelect.appendChild(option);
        }
      }
      agentSelect.value = agents.some((agent) => agent.id === selectedAgentId)
        ? selectedAgentId
        : "";
      updateComposerControl();
    }

    function setRunning(value) {
      running = value;
      updateComposerControl();
      clear.disabled = value;
      newChat.disabled = false;
      agentSelect.disabled = value;
      modelSelect.disabled = value;
      if (!value) prompt.focus();
    }

    function activatePrimaryControl() {
      const state = updateComposerControl();
      if (state.disabled) return;
      const text = prompt.value.trim();
      if (state.action === "stop") {
        vscode.postMessage({ type: "cancel" });
      } else if (state.action === "send") {
        addMessage("user", text);
        prompt.value = "";
        updateComposerControl();
        vscode.postMessage({ type: "send", text });
      } else {
        const requestId = crypto.randomUUID();
        pendingSteering.set(requestId, text);
        vscode.postMessage({ type: "steer", requestId, text });
      }
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      activatePrimaryControl();
    });
    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        activatePrimaryControl();
      }
    });
    prompt.addEventListener("input", updateComposerControl);
    clear.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
    newChat.addEventListener("click", () => {
      vscode.postMessage({ type: "newSession" });
    });
    modelSelect.addEventListener("change", () => {
      if (!running) {
        vscode.postMessage({ type: "selectModel", modelKey: modelSelect.value });
      }
    });
    agentSelect.addEventListener("change", () => {
      updateComposerControl();
      if (!running) {
        vscode.postMessage({
          type: "selectAgent",
          agentId: agentSelect.value,
        });
      }
    });

    window.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "workbenchState":
          currentSessionId = data.currentSessionId;
          setRunning(data.running);
          renderSessions(data.sessions);
          renderAgents(data.agents, data.selectedAgentId);
          renderModels(data.models, data.selectedModelKey);
          if (data.replaceMessages) {
            replaceConversation(data.replayItems);
            renderRecoveries(data.recoveries);
            if (data.liveDraft) {
              draft = addMessage(
                "assistant",
                data.liveDraft,
                data.liveDraftHtml,
              );
            }
            if (data.pendingApproval) {
              addApproval(
                data.pendingApproval.requestId,
                data.pendingApproval.actions,
                data.pendingApproval.allowSession,
              );
              draft = null;
            }
          }
          break;
        case "runStarted":
          if (data.sessionId !== currentSessionId) break;
          setRunning(true);
          draft = null;
          break;
        case "textDelta":
          if (data.sessionId !== currentSessionId) break;
          if (!draft) draft = addMessage("assistant", "", "");
          setMessageContent(draft, "assistant", data.content, data.html);
          messages.scrollTop = messages.scrollHeight;
          break;
        case "toolCall":
          if (data.sessionId !== currentSessionId) break;
          addActivity(data.id, data.label, JSON.stringify(data.input, null, 2));
          draft = null;
          break;
        case "toolResult":
          if (data.sessionId !== currentSessionId) break;
          addActivity(data.id, data.label, data.text);
          // A tool result closes the current model/tool segment. The next text
          // belongs to a fresh model response (including parent text after a
          // delegated child's final response), so it needs a new bubble.
          draft = null;
          break;
        case "approvalRequested":
          if (data.sessionId !== currentSessionId) break;
          addApproval(data.requestId, data.actions, data.allowSession);
          draft = null;
          break;
        case "approvalResolved":
          if (data.sessionId !== currentSessionId) break;
          resolveApproval(data.requestId, data.decision);
          break;
        case "steeringAccepted": {
          if (data.sessionId !== currentSessionId) break;
          const submitted = pendingSteering.get(data.requestId);
          pendingSteering.delete(data.requestId);
          addSteeringMessage(data.requestId, data.text, "queued");
          if (submitted && prompt.value.trim() === submitted) {
            prompt.value = "";
            updateComposerControl();
          }
          break;
        }
        case "steeringInjected":
          if (data.sessionId !== currentSessionId) break;
          addSteeringMessage(data.requestId, "", "injected");
          break;
        case "steeringDiscarded":
          if (data.sessionId !== currentSessionId) break;
          addSteeringMessage(data.requestId, "", "discarded");
          break;
        case "steeringRejected":
          if (data.sessionId !== currentSessionId) break;
          pendingSteering.delete(data.requestId);
          primaryAction.title = data.reason;
          primaryAction.setAttribute("aria-label", data.reason);
          break;
        case "modelBoundary":
          if (data.sessionId !== currentSessionId) break;
          draft = null;
          break;
        case "runCompleted":
          if (data.sessionId !== currentSessionId) break;
          if (!draft || draft.dataset.rawText !== data.text) {
            addMessage("assistant", data.text, data.html);
          } else {
            setMessageContent(draft, "assistant", data.text, data.html);
          }
          draft = null;
          setRunning(false);
          break;
        case "runFailed":
          if (data.sessionId !== currentSessionId) break;
          addMessage("assistant", data.message);
          draft = null;
          setRunning(false);
          break;
        case "runRejected":
          if (data.sessionId !== currentSessionId) break;
          addMessage("assistant", data.message);
          break;
      }
    });
    vscode.postMessage({ type: "ready" });
    prompt.focus();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
