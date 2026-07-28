import * as vscode from "vscode";
import { AIMessage } from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import {
  createExecuteCommandTool,
  validateExecuteCommandInput,
} from "./executeCommandTool";
import { WorkbenchSidebarProvider } from "./sidebarProvider";
import { VsCodeChatModel, type AdapterEvent } from "./vscodeChatModel";

let currentPanel: DeepAgentsChatPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const openWorkbench = async (): Promise<void> => {
    if (currentPanel) {
      currentPanel.reveal();
      return;
    }

    const models = await selectCopilotModels();
    if (models.length === 0) {
      return;
    }

    currentPanel = new DeepAgentsChatPanel(context, models, () => {
      currentPanel = undefined;
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("deepagentsSpike.openChat", openWorkbench),
    vscode.window.registerWebviewViewProvider(
      WorkbenchSidebarProvider.viewType,
      new WorkbenchSidebarProvider(openWorkbench),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

export function deactivate(): void {}

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
  title: string;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  allowedTools: Set<string>;
}

class DeepAgentsChatPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaceRoot: string;
  private readonly models: vscode.LanguageModelChat[];
  private readonly sessions: ChatSession[] = [];
  private readonly toolCalls = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();
  private selectedModelKey: string;
  private currentSessionId: string;
  private cancellation: AbortController | undefined;
  private pendingApproval:
    | {
        requestId: string;
        allowSession: boolean;
        resolve: (decision: ApprovalDecision) => void;
      }
    | undefined;
  private running = false;

  constructor(
    context: vscode.ExtensionContext,
    models: vscode.LanguageModelChat[],
    onDispose: () => void,
  ) {
    this.models = models;
    this.selectedModelKey = modelKey(models[0]);
    const initialSession = createSession();
    this.sessions.push(initialSession);
    this.currentSessionId = initialSession.id;
    this.workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
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
        this.cancellation?.abort();
        this.resolvePendingApproval("deny");
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

  private get selectedModel(): vscode.LanguageModelChat {
    return (
      this.models.find((model) => modelKey(model) === this.selectedModelKey) ??
      this.models[0]
    );
  }

  private deleteSession(sessionId: string): void {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) {
      return;
    }
    this.sessions.splice(index, 1);
    if (this.sessions.length === 0) {
      this.sessions.push(createSession());
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
      this.cancellation?.abort();
      this.resolvePendingApproval("deny");
      return;
    }
    if (raw.type === "approval") {
      if (this.pendingApproval?.requestId === raw.requestId) {
        if (raw.decision === "session" && !this.pendingApproval.allowSession) {
          return;
        }
        this.resolvePendingApproval(raw.decision);
      }
      return;
    }
    if (raw.type === "selectModel" && !this.running) {
      if (this.models.some((model) => modelKey(model) === raw.modelKey)) {
        this.selectedModelKey = raw.modelKey;
        await this.postWorkbenchState(false);
      }
      return;
    }
    if (raw.type === "newSession" && !this.running) {
      const session = createSession();
      this.sessions.unshift(session);
      this.currentSessionId = session.id;
      await this.postWorkbenchState(true);
      return;
    }
    if (raw.type === "selectSession" && !this.running) {
      if (this.sessions.some((session) => session.id === raw.sessionId)) {
        this.currentSessionId = raw.sessionId;
        await this.postWorkbenchState(true);
      }
      return;
    }
    if (raw.type === "renameSession" && !this.running) {
      const session = this.sessions.find((item) => item.id === raw.sessionId);
      const title = sanitizeManualTitle(raw.title);
      if (session && title) {
        session.title = title;
        await this.postWorkbenchState(false);
      }
      return;
    }
    if (raw.type === "deleteSession" && !this.running) {
      this.deleteSession(raw.sessionId);
      await this.postWorkbenchState(true);
      return;
    }
    if (raw.type === "clear" && !this.running) {
      this.activeSession.transcript.length = 0;
      await this.postWorkbenchState(true);
      return;
    }
    if (raw.type !== "send" || this.running) {
      return;
    }

    const prompt = raw.text.trim();
    if (!prompt) {
      return;
    }
    await this.run(prompt);
  }

  private async run(prompt: string): Promise<void> {
    this.running = true;
    this.cancellation = new AbortController();
    this.toolCalls.clear();
    const session = this.activeSession;
    const model = this.selectedModel;
    const isFirstMessage = session.transcript.length === 0;
    session.transcript.push({ role: "user", content: prompt });
    if (isFirstMessage) {
      void this.generateSessionTitle(session.id, prompt, model);
    }
    await this.post({ type: "runStarted" });

    let streamedFinalText = "";
    const adapter = new VsCodeChatModel({
      model,
      onEvent: (event) => {
        if (event.kind === "text") {
          streamedFinalText += event.text;
        }
        void this.postAdapterEvent(event);
      },
    });

    const backend = new FilesystemBackend({
      rootDir: this.workspaceRoot,
      virtualMode: true,
    });
    const executeCommandTool = createExecuteCommandTool({
      workspaceRoot: this.workspaceRoot,
    });

    const agent = createDeepAgent({
      model: adapter,
      tools: [executeCommandTool],
      backend,
      checkpointer: new MemorySaver(),
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
      },
      systemPrompt: [
        "You are a coding agent running inside VS Code.",
        "The virtual filesystem root / is the current VS Code workspace.",
        "Use your filesystem, planning, and execute_command tools when they help answer the user.",
        "Inspect before editing, keep changes scoped, and clearly summarize any files changed.",
        "File writes and edits require user approval unless allowed for this chat session.",
        "execute_command requires user approval unless allowed for this chat session. Pass an executable and argument array; shell syntax is not interpreted.",
        "When a tool requires approval, call it immediately. Never ask for permission in conversational text; the host application owns the approval interaction.",
        "Never use '..', '~', home-directory variables, or absolute paths outside the workspace in command arguments; they are rejected.",
        "For commands targeting the workspace root, omit the path argument or use '.' exactly. After a path guard rejection, do not try alternate forms such as /, /root, ~, or environment variables. Retry at most once with '.' or no path; if that cannot satisfy the request, explain the restriction and stop.",
        "When the user requests command output, include the relevant stdout or stderr in your final response instead of only saying the command ran.",
      ].join("\n"),
    });

    try {
      const runConfig = {
        configurable: { thread_id: crypto.randomUUID() },
        signal: this.cancellation.signal,
      };
      let result = await agent.invoke(
        {
          messages: session.transcript.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
        runConfig,
      );

      let approvalRequest = extractApprovalRequest(result);
      while (approvalRequest) {
        const commandGuardError = getCommandGuardError(
          approvalRequest.actions,
          this.workspaceRoot,
        );
        let decisions: Array<
          | { type: "approve" }
          | { type: "reject"; message: string }
        >;

        if (commandGuardError) {
          decisions = approvalRequest.actions.map(() => ({
            type: "reject" as const,
            message: [
              commandGuardError,
              "Do not retry with another outside-path representation such as /, /root, ~, $HOME, or an absolute home path.",
              "If operating on the workspace is acceptable, retry at most once with the path argument omitted or with '.' exactly.",
              "Otherwise, explain that the requested path is outside the allowed workspace and stop.",
            ].join(" "),
          }));
        } else {
          const decision = await this.requestApproval(approvalRequest.actions);
          if (decision === "session") {
            for (const action of approvalRequest.actions) {
              session.allowedTools.add(action.name);
            }
          }
          decisions = approvalRequest.actions.map(() =>
            decision === "deny"
              ? {
                  type: "reject" as const,
                  message: "The user denied this tool operation for now.",
                }
              : { type: "approve" as const },
          );
        }

        const resume = { decisions };
        result = await agent.invoke(new Command({ resume }), runConfig);
        approvalRequest = extractApprovalRequest(result);
      }

      const messages = result.messages ?? [];
      const finalMessage = [...messages].reverse().find((message) => AIMessage.isInstance(message));
      const finalText = finalMessage ? messageText(finalMessage.content) : streamedFinalText;
      session.transcript.push({ role: "assistant", content: finalText });
      await this.post({ type: "runCompleted", text: finalText });
    } catch (error) {
      const cancelled = this.cancellation.signal.aborted;
      const message = cancelled ? "Cancelled." : formatError(error);
      session.transcript.push({ role: "assistant", content: message });
      await this.post({
        type: "runFailed",
        message,
      });
    } finally {
      this.running = false;
      this.cancellation = undefined;
    }
  }

  private async requestApproval(actions: ApprovalAction[]): Promise<ApprovalDecision> {
    const requestId = crypto.randomUUID();
    const allowSession = actions.every(
      (action) =>
        action.name === "write_file" ||
        action.name === "edit_file" ||
        action.name === "execute_command",
    );
    const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = { requestId, allowSession, resolve };
    });
    await this.post({
      type: "approvalRequested",
      requestId,
      actions,
      allowSession,
    });
    const decision = await decisionPromise;
    await this.post({
      type: "approvalResolved",
      requestId,
      decision,
    });
    return decision;
  }

  private resolvePendingApproval(decision: ApprovalDecision): void {
    const pending = this.pendingApproval;
    if (!pending) {
      return;
    }
    this.pendingApproval = undefined;
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
        await this.postWorkbenchState(false);
      }
    } catch {
      const session = this.sessions.find((item) => item.id === sessionId);
      if (session && session.title === "New chat") {
        session.title = fallbackTitle(firstMessage);
        await this.postWorkbenchState(false);
      }
    } finally {
      cancellation.dispose();
    }
  }

  private async postWorkbenchState(replaceMessages: boolean): Promise<void> {
    const active = this.activeSession;
    this.panel.title = active.title === "New chat" ? "Deep Agents Workbench" : active.title;
    await this.post({
      type: "workbenchState",
      replaceMessages,
      currentSessionId: active.id,
      selectedModelKey: this.selectedModelKey,
      models: this.models.map((model) => ({
        key: modelKey(model),
        name: model.name,
        family: model.family,
        vendor: model.vendor,
      })),
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
      })),
      transcript: replaceMessages ? active.transcript : undefined,
    });
  }

  private async postAdapterEvent(event: AdapterEvent): Promise<void> {
    if (event.kind === "text") {
      await this.post({ type: "textDelta", text: event.text });
    } else if (event.kind === "toolCall") {
      const input = toRecord(event.input);
      this.toolCalls.set(event.id, { name: event.name, input });
      await this.post({
        type: "toolCall",
        id: event.id,
        name: event.name,
        input,
        label: describeToolActivity(event.name, input, "running"),
      });
    } else {
      const toolCall = this.toolCalls.get(event.id);
      const outcome = event.text.trimStart().startsWith("Blocked")
        ? "blocked"
        : event.text.trimStart().startsWith("Error")
          ? "failed"
          : "completed";
      await this.post({
        type: "toolResult",
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
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "selectModel"; modelKey: string }
  | { type: "newSession" }
  | { type: "selectSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "deleteSession"; sessionId: string }
  | {
      type: "approval";
      requestId: string;
      decision: ApprovalDecision;
    };

type ApprovalDecision = "once" | "session" | "deny";

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

function createSession(): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    transcript: [],
    allowedTools: new Set(),
  };
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
    .send-actions { display: flex; gap: 8px; }
    #model-select {
      max-width: min(340px, 50vw);
      min-width: 150px;
      padding: 5px 24px 5px 7px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      font: inherit;
    }
    #cancel { display: none; }
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
      <div class="sessions-foot">In-memory for this spike</div>
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
          <select id="model-select" aria-label="Language model"></select>
          <div class="send-actions">
            <button id="cancel" class="secondary" type="button">Cancel</button>
            <button id="send" type="submit">Send</button>
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
    const send = document.getElementById("send");
    const cancel = document.getElementById("cancel");
    const clear = document.getElementById("clear");
    const newChat = document.getElementById("new-chat");
    const sessionList = document.getElementById("session-list");
    const modelSelect = document.getElementById("model-select");
    const subtitle = document.getElementById("subtitle");
    let draft = null;
    let running = false;
    let currentSessionId = "";

    function addMessage(role, text) {
      document.getElementById("empty")?.remove();
      const element = document.createElement("div");
      element.className = "message " + role;
      element.textContent = text;
      messages.appendChild(element);
      messages.scrollTop = messages.scrollHeight;
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

    function addApproval(requestId, actions, allowSession) {
      document.getElementById("empty")?.remove();
      const element = document.createElement("section");
      element.className = "approval";
      element.dataset.approvalId = requestId;

      const title = document.createElement("div");
      title.className = "approval-title";
      title.textContent = actions.length === 1
        ? "Approval required: " + actions[0].name
        : "Approval required for " + actions.length + " file operations";
      element.appendChild(title);

      for (const action of actions) {
        const details = document.createElement("details");
        details.open = true;
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
        element.appendChild(details);
      }

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
      messages.appendChild(element);
      messages.scrollTop = messages.scrollHeight;
    }

    function resolveApproval(requestId, decision) {
      const element = document.querySelector(
        '[data-approval-id="' + CSS.escape(requestId) + '"]'
      );
      if (!element) return;
      element.querySelector(".approval-actions")?.remove();
      const status = document.createElement("div");
      status.className = "approval-status";
      status.textContent = decision === "once"
        ? "Allowed once"
        : decision === "session"
          ? "Allowed for this session"
          : "Denied for now";
      element.appendChild(status);
    }

    function replaceTranscript(transcript) {
      messages.replaceChildren();
      draft = null;
      if (!transcript?.length) {
        const emptyState = document.createElement("div");
        emptyState.id = "empty";
        emptyState.textContent = "Start a conversation with a workspace-scoped agent.";
        messages.appendChild(emptyState);
        return;
      }
      for (const message of transcript) {
        addMessage(message.role, message.content);
      }
      messages.scrollTop = messages.scrollHeight;
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
          if (!running && session.id !== currentSessionId) {
            vscode.postMessage({ type: "selectSession", sessionId: session.id });
          }
        });

        const name = document.createElement("span");
        name.className = "session-name";
        name.textContent = session.title;
        row.appendChild(name);

        const controls = document.createElement("span");
        controls.className = "session-controls";
        const rename = document.createElement("button");
        rename.className = "icon-button";
        rename.type = "button";
        rename.title = "Rename chat";
        rename.textContent = "✎";
        rename.disabled = running;
        rename.addEventListener("click", (event) => {
          event.stopPropagation();
          if (!running) beginRename(row, session);
        });
        const remove = document.createElement("button");
        remove.className = "icon-button";
        remove.type = "button";
        remove.title = "Delete chat";
        remove.textContent = "×";
        remove.disabled = running;
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          if (!running && confirm('Delete "' + session.title + '"?')) {
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

    function setRunning(value) {
      running = value;
      send.disabled = value;
      clear.disabled = value;
      newChat.disabled = value;
      modelSelect.disabled = value;
      cancel.style.display = value ? "block" : "none";
      prompt.disabled = value;
      for (const button of sessionList.querySelectorAll("button")) {
        button.disabled = value;
      }
      if (!value) prompt.focus();
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = prompt.value.trim();
      if (!text || running) return;
      addMessage("user", text);
      prompt.value = "";
      vscode.postMessage({ type: "send", text });
    });
    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
    clear.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
    newChat.addEventListener("click", () => {
      if (!running) vscode.postMessage({ type: "newSession" });
    });
    modelSelect.addEventListener("change", () => {
      if (!running) {
        vscode.postMessage({ type: "selectModel", modelKey: modelSelect.value });
      }
    });

    window.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "workbenchState":
          currentSessionId = data.currentSessionId;
          renderSessions(data.sessions);
          renderModels(data.models, data.selectedModelKey);
          if (data.replaceMessages) replaceTranscript(data.transcript);
          break;
        case "runStarted":
          setRunning(true);
          draft = null;
          break;
        case "textDelta":
          if (!draft) draft = addMessage("assistant", "");
          draft.textContent += data.text;
          messages.scrollTop = messages.scrollHeight;
          break;
        case "toolCall":
          addActivity(data.id, data.label, JSON.stringify(data.input, null, 2));
          draft = null;
          break;
        case "toolResult":
          addActivity(data.id, data.label, data.text);
          break;
        case "approvalRequested":
          addApproval(data.requestId, data.actions, data.allowSession);
          draft = null;
          break;
        case "approvalResolved":
          resolveApproval(data.requestId, data.decision);
          break;
        case "runCompleted":
          if (!draft || draft.textContent !== data.text) addMessage("assistant", data.text);
          draft = null;
          setRunning(false);
          break;
        case "runFailed":
          addMessage("assistant", data.message);
          draft = null;
          setRunning(false);
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
