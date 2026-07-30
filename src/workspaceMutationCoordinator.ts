import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";
import { createMiddleware, type ToolCallRequest } from "langchain";

const DEFAULT_APPROVAL_RESERVATION_MS = 5 * 60 * 1_000;
const MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "execute_command",
]);

interface FileObservation {
  contentHash: string | null;
  workspaceEpoch: number;
}

interface MutationTicket {
  key: string;
  runId: string;
  toolCallId: string;
  resolveReady: () => void;
  ready: Promise<void>;
  expiration?: NodeJS.Timeout;
  expired: boolean;
}

export interface MutationRunHooks {
  onWaiting(): void;
  onRunning(): void;
  onApprovalExpired(toolCallId: string): void;
}

export interface ApprovalMutationAction {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export class WorkspaceMutationCoordinator {
  private readonly queue: MutationTicket[] = [];
  private readonly tickets = new Map<string, MutationTicket>();
  private readonly observations = new Map<
    string,
    Map<string, FileObservation>
  >();
  private active: MutationTicket | undefined;
  private workspaceEpoch = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly approvalReservationMs =
      DEFAULT_APPROVAL_RESERVATION_MS,
  ) {}

  createMiddleware(input: {
    runId: string;
    hooks: MutationRunHooks;
  }) {
    return createMiddleware({
      name: "WorkspaceMutationCoordinator",
      wrapToolCall: async (request, handler) => {
        const toolName = request.toolCall.name;
        if (toolName === "read_file") {
          const path = this.toolPath(request);
          const epochBeforeRead = this.workspaceEpoch;
          const hashBeforeRead = path ? await fileHash(path) : null;
          const result = await handler(request);
          if (!isErrorToolMessage(result) && path) {
            const hashAfterRead = await fileHash(path);
            if (
              epochBeforeRead === this.workspaceEpoch &&
              hashBeforeRead === hashAfterRead
            ) {
              this.recordRead(
                input.runId,
                path,
                hashAfterRead,
                epochBeforeRead,
              );
            }
          }
          return result;
        }
        if (!MUTATION_TOOLS.has(toolName)) {
          return handler(request);
        }

        const toolCallId =
          request.toolCall.id ?? `${input.runId}:${toolName}:missing-id`;
        const ticket = await this.acquire(
          input.runId,
          toolCallId,
          input.hooks,
        );
        if (ticket.expired) {
          this.tickets.delete(ticket.key);
          input.hooks.onRunning();
          return mutationError(
            request,
            "The five-minute mutation approval reservation expired. Read the affected file again and propose a fresh operation.",
          );
        }

        const path = this.toolPath(request);
        const freshnessError =
          toolName === "execute_command"
            ? undefined
            : await this.freshnessError(input.runId, toolName, path);
        if (freshnessError) {
          this.release(ticket);
          input.hooks.onRunning();
          return mutationError(request, freshnessError);
        }

        try {
          const result = await handler(request);
          if (toolName === "execute_command") {
            await this.recordMutation(toolName, path);
          } else if (!isErrorToolMessage(result)) {
            await this.recordMutation(toolName, path);
          }
          this.release(ticket);
          input.hooks.onRunning();
          return result;
        } catch (error) {
          if (isGraphInterrupt(error)) {
            this.holdForApproval(ticket, input.hooks);
            throw error;
          }
          if (toolName === "execute_command") {
            await this.recordMutation(toolName, path);
          }
          this.release(ticket);
          input.hooks.onRunning();
          throw error;
        }
      },
    });
  }

  async reserveApproval(
    runId: string,
    actions: ApprovalMutationAction[],
    hooks: MutationRunHooks,
  ): Promise<string | undefined> {
    const mutationActions = actions.filter((action) =>
      MUTATION_TOOLS.has(action.name)
    );
    if (mutationActions.length === 0) {
      return undefined;
    }
    const tickets = mutationActions.map((action) =>
      this.enqueue(runId, action.toolCallId),
    );
    const first = tickets[0];
    if (this.active !== first) {
      hooks.onWaiting();
      await first.ready;
    }
    hooks.onRunning();

    for (const action of mutationActions) {
      if (action.name === "execute_command") {
        continue;
      }
      const path = this.actionPath(action.args);
      const error = await this.freshnessError(
        runId,
        action.name,
        path,
      );
      if (error) {
        this.releaseAll(tickets);
        return error;
      }
    }

    if (first.expiration) {
      clearTimeout(first.expiration);
    }
    first.expiration = setTimeout(() => {
      first.expiration = undefined;
      for (const ticket of tickets) {
        ticket.expired = true;
      }
      this.releaseAll(tickets);
      for (const action of mutationActions) {
        hooks.onApprovalExpired(action.toolCallId);
      }
    }, this.approvalReservationMs);
    first.expiration.unref();
    return undefined;
  }

  resolveApproval(
    runId: string,
    toolCallIds: string[],
    approved: boolean,
  ): void {
    const tickets = toolCallIds
      .map((toolCallId) => this.tickets.get(`${runId}:${toolCallId}`))
      .filter((ticket): ticket is MutationTicket => Boolean(ticket));
    if (tickets[0]?.expiration) {
      clearTimeout(tickets[0].expiration);
      tickets[0].expiration = undefined;
    }
    if (!approved) {
      this.releaseAll(tickets);
    }
  }

  releaseRun(runId: string): void {
    this.releaseAll(
      [...this.tickets.values()].filter((ticket) => ticket.runId === runId),
    );
    this.observations.delete(runId);
  }

  private async acquire(
    runId: string,
    toolCallId: string,
    hooks: MutationRunHooks,
  ): Promise<MutationTicket> {
    const key = `${runId}:${toolCallId}`;
    const existing = this.tickets.get(key);
    if (existing) {
      if (existing.expiration) {
        clearTimeout(existing.expiration);
        existing.expiration = undefined;
      }
      if (this.active !== existing && !existing.expired) {
        hooks.onWaiting();
        await existing.ready;
      }
      hooks.onRunning();
      return existing;
    }

    const ticket = this.enqueue(runId, toolCallId);
    if (this.active !== ticket) {
      hooks.onWaiting();
      await ticket.ready;
    }
    hooks.onRunning();
    return ticket;
  }

  private enqueue(runId: string, toolCallId: string): MutationTicket {
    const key = `${runId}:${toolCallId}`;
    const existing = this.tickets.get(key);
    if (existing) {
      return existing;
    }
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolveReadyPromise) => {
      resolveReady = resolveReadyPromise;
    });
    const ticket: MutationTicket = {
      key,
      runId,
      toolCallId,
      resolveReady,
      ready,
      expired: false,
    };
    this.tickets.set(key, ticket);
    this.queue.push(ticket);
    this.pump();
    return ticket;
  }

  private pump(): void {
    if (this.active) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.active = next;
    next.resolveReady();
  }

  private release(ticket: MutationTicket): void {
    if (ticket.expiration) {
      clearTimeout(ticket.expiration);
      ticket.expiration = undefined;
    }
    this.tickets.delete(ticket.key);
    if (this.active === ticket) {
      this.active = undefined;
      this.pump();
      return;
    }
    const index = this.queue.indexOf(ticket);
    if (index >= 0) {
      this.queue.splice(index, 1);
      ticket.expired = true;
      ticket.resolveReady();
    }
  }

  private releaseAll(tickets: MutationTicket[]): void {
    for (const ticket of tickets) {
      this.release(ticket);
    }
  }

  private holdForApproval(
    ticket: MutationTicket,
    hooks: MutationRunHooks,
  ): void {
    if (ticket.expiration) {
      clearTimeout(ticket.expiration);
    }
    ticket.expiration = setTimeout(() => {
      ticket.expiration = undefined;
      ticket.expired = true;
      if (this.active === ticket) {
        this.active = undefined;
        this.pump();
      }
      hooks.onApprovalExpired(ticket.toolCallId);
    }, this.approvalReservationMs);
    ticket.expiration.unref();
  }

  private recordRead(
    runId: string,
    path: string,
    contentHash: string | null,
    workspaceEpoch: number,
  ): void {
    const runObservations =
      this.observations.get(runId) ?? new Map<string, FileObservation>();
    runObservations.set(path, {
      contentHash,
      workspaceEpoch,
    });
    this.observations.set(runId, runObservations);
  }

  private async freshnessError(
    runId: string,
    toolName: string,
    path: string | undefined,
  ): Promise<string | undefined> {
    if (!path) {
      return `${toolName} is missing a valid workspace file path.`;
    }
    const currentHash = await fileHash(path);
    const observation = this.observations.get(runId)?.get(path);
    if (toolName === "write_file" && currentHash === null && !observation) {
      return undefined;
    }
    if (
      !observation ||
      observation.workspaceEpoch !== this.workspaceEpoch ||
      observation.contentHash !== currentHash
    ) {
      return [
        `The workspace file changed before ${toolName} could execute.`,
        "Call read_file on the path again, then generate and submit a fresh edit.",
        "The stale operation was not executed.",
      ].join(" ");
    }
    return undefined;
  }

  private async recordMutation(
    toolName: string,
    path: string | undefined,
  ): Promise<void> {
    if (toolName === "execute_command") {
      this.workspaceEpoch += 1;
      this.observations.clear();
      return;
    }
    if (!path) {
      return;
    }
    for (const observations of this.observations.values()) {
      observations.delete(path);
    }
  }

  private toolPath(request: ToolCallRequest): string | undefined {
    const args = request.toolCall.args;
    if (!args || typeof args !== "object") {
      return undefined;
    }
    return this.actionPath(args);
  }

  private actionPath(args: Record<string, unknown>): string | undefined {
    const rawPath =
      "file_path" in args && typeof args.file_path === "string"
        ? args.file_path
        : "path" in args && typeof args.path === "string"
          ? args.path
          : undefined;
    if (!rawPath) {
      return undefined;
    }
    const resolved = isAbsolute(rawPath)
      ? resolve(this.workspaceRoot, `.${rawPath}`)
      : resolve(this.workspaceRoot, rawPath);
    const workspaceRelative = relative(this.workspaceRoot, resolved);
    if (
      workspaceRelative === ".." ||
      workspaceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(workspaceRelative)
    ) {
      return undefined;
    }
    return resolved;
  }
}

async function fileHash(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      return null;
    }
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function isErrorToolMessage(value: unknown): boolean {
  return ToolMessage.isInstance(value) && value.status === "error";
}

function mutationError(
  request: ToolCallRequest,
  message: string,
): ToolMessage {
  return new ToolMessage({
    content: `Error: ${message}`,
    tool_call_id: request.toolCall.id ?? "missing-tool-call-id",
    name: request.toolCall.name,
    status: "error",
  });
}
