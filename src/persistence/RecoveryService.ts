import { INTERRUPT } from "@langchain/langgraph";
import type { NodeSqliteSaver } from "./NodeSqliteSaver";
import type {
  AgentRunRecord,
  RecoveryClass,
  RunRepository,
} from "./RunRepository";
import type { ToolExecutionRepository } from "./ToolExecutionRepository";

export const CURRENT_GRAPH_COMPATIBILITY_VERSION = 1;

export interface RecoveryResult {
  run: AgentRunRecord;
  recoveryClass: RecoveryClass;
  reason: string;
  uncertainToolCallId: string | null;
  uncertainToolName: string | null;
}

export class RecoveryBlockedError extends Error {
  readonly recoverable = true;

  constructor(
    readonly runId: string,
    readonly recoveryClass: RecoveryClass,
    message: string,
  ) {
    super(message);
    this.name = "RecoveryBlockedError";
  }
}

export class RecoveryService {
  constructor(
    private readonly runs: RunRepository,
    private readonly tools: ToolExecutionRepository,
    private readonly checkpointer: NodeSqliteSaver,
  ) {}

  async recoverExpiredAttempts(
    now = new Date(),
    currentProcessInstanceId?: string,
  ): Promise<RecoveryResult[]> {
    const staleRuns = this.runs.interruptExpiredAttempts(
      now.toISOString(),
      "Attempt lease expired or belongs to a previous Extension Host process.",
      currentProcessInstanceId,
    );
    const results: RecoveryResult[] = [];
    for (const run of staleRuns) {
      results.push(await this.classify(run));
    }
    return results;
  }

  listForSession(sessionId: string): RecoveryResult[] {
    return this.runs.listInterruptedForSession(sessionId).map((run) => {
      const uncertain = this.tools
        .listUncertain(run.id)
        .find((tool) => tool.effectClass !== "read_only");
      return {
        run,
        recoveryClass: run.recoveryClass!,
        reason: run.lastError ?? "This run was interrupted.",
        uncertainToolCallId: uncertain?.toolCallId ?? null,
        uncertainToolName: uncertain?.toolName ?? null,
      };
    });
  }

  assertExplicitResumeAllowed(runId: string): AgentRunRecord {
    const run = this.runs.get(runId);
    if (!run || run.status !== "interrupted" || !run.recoveryClass) {
      throw new Error(`Run "${runId}" is not an interrupted recovery run.`);
    }
    if (
      run.recoveryClass === "needs_review" ||
      run.recoveryClass === "not_resumable"
    ) {
      throw new RecoveryBlockedError(
        run.id,
        run.recoveryClass,
        run.lastError ?? "This run is blocked from continuation.",
      );
    }
    return run;
  }

  private async classify(run: AgentRunRecord): Promise<RecoveryResult> {
    if (run.compatibilityVersion !== CURRENT_GRAPH_COMPATIBILITY_VERSION) {
      return this.persistResult(
        run,
        "not_resumable",
        `Checkpoint compatibility version ${run.compatibilityVersion} is not supported; version ${CURRENT_GRAPH_COMPATIBILITY_VERSION} is required.`,
      );
    }

    const tuple = await this.checkpointer.getTuple({
      configurable: {
        thread_id: run.threadId,
        checkpoint_ns: run.checkpointNamespace,
      },
    });
    if (!tuple) {
      return this.persistResult(
        run,
        "not_resumable",
        "The interrupted run has no persisted checkpoint.",
      );
    }

    const uncertain = this.tools.markRunningUncertain(run.id);
    const uncertainSideEffect = uncertain.find(
      (tool) => tool.effectClass !== "read_only",
    );
    if (uncertainSideEffect) {
      return this.persistResult(
        run,
        "needs_review",
        `${uncertainSideEffect.toolName} may have completed before its result was persisted. Review it before resuming.`,
        tuple.checkpoint.id,
        uncertainSideEffect.toolCallId,
        uncertainSideEffect.toolName,
      );
    }

    if (
      tuple.pendingWrites?.some(
        ([, channel, value]) =>
          channel === INTERRUPT &&
          (Array.isArray(value)
            ? value.length > 0
            : value !== null && value !== undefined),
      )
    ) {
      return this.persistResult(
        run,
        "waiting_for_approval",
        "The interrupted run is waiting for a persisted approval decision.",
        tuple.checkpoint.id,
      );
    }

    return this.persistResult(
      run,
      "safe_to_resume",
      "A compatible checkpoint exists and no uncertain side effect blocks explicit resume.",
      tuple.checkpoint.id,
    );
  }

  private persistResult(
    run: AgentRunRecord,
    recoveryClass: RecoveryClass,
    reason: string,
    checkpointId?: string,
    uncertainToolCallId: string | null = null,
    uncertainToolName: string | null = null,
  ): RecoveryResult {
    this.runs.setRecovery(run.id, recoveryClass, reason, checkpointId);
    return {
      run: {
        ...run,
        status: "interrupted",
        recoveryClass,
        lastError: reason,
        lastCheckpointId: checkpointId ?? run.lastCheckpointId,
      },
      recoveryClass,
      reason,
      uncertainToolCallId,
      uncertainToolName,
    };
  }
}
