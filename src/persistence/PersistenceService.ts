import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteSaver } from "./NodeSqliteSaver";
import {
  assertDatabaseHealthy,
  configureDatabase,
  isoNow,
} from "./database";
import { applyMigrations } from "./migrations";
import { ApprovalRepository } from "./ApprovalRepository";
import { CheckpointCleanupRepository } from "./CheckpointCleanupRepository";
import { ConversationEventRepository } from "./ConversationEventRepository";
import { GoalRepository } from "./GoalRepository";
import { RunRepository } from "./RunRepository";
import { RecoveryRepository } from "./RecoveryRepository";
import { RecoveryService } from "./RecoveryService";
import { SessionRepository } from "./SessionRepository";
import { ToolExecutionRepository } from "./ToolExecutionRepository";

export interface UriLike {
  fsPath: string;
  toString(): string;
}

export class PersistenceInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistenceInitializationError";
  }
}

export class PersistenceService {
  readonly database: DatabaseSync;
  readonly checkpointer: NodeSqliteSaver;
  readonly sessions: SessionRepository;
  readonly conversationEvents: ConversationEventRepository;
  readonly goals: GoalRepository;
  readonly runs: RunRepository;
  readonly recovery: RecoveryService;
  readonly recoveryDecisions: RecoveryRepository;
  readonly toolExecutions: ToolExecutionRepository;
  readonly approvals: ApprovalRepository;
  readonly checkpointCleanup: CheckpointCleanupRepository;
  readonly databasePath: string;
  private closed = false;

  private constructor(database: DatabaseSync, databasePath: string) {
    this.database = database;
    this.databasePath = databasePath;
    this.checkpointer = new NodeSqliteSaver(database);
    this.sessions = new SessionRepository(database);
    this.conversationEvents = new ConversationEventRepository(database);
    this.goals = new GoalRepository(database);
    this.runs = new RunRepository(database);
    this.recoveryDecisions = new RecoveryRepository(database);
    this.toolExecutions = new ToolExecutionRepository(database);
    this.approvals = new ApprovalRepository(database);
    this.checkpointCleanup = new CheckpointCleanupRepository(database);
    this.recovery = new RecoveryService(
      this.runs,
      this.toolExecutions,
      this.checkpointer,
    );
  }

  static async open(
    storageUri: UriLike,
    workspaceUri: UriLike,
  ): Promise<PersistenceService> {
    await mkdir(storageUri.fsPath, { recursive: true });
    const databasePath = join(storageUri.fsPath, "deep-agents.sqlite");
    const database = new DatabaseSync(databasePath);

    try {
      assertDatabaseHealthy(database);
      configureDatabase(database);
      applyMigrations(database);
      const now = isoNow();
      database
        .prepare(`
          INSERT INTO workspace_metadata (
            id,
            workspace_uri,
            workspace_root,
            created_at,
            updated_at
          ) VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            workspace_uri = excluded.workspace_uri,
            workspace_root = excluded.workspace_root,
            updated_at = excluded.updated_at
        `)
        .run(
          workspaceUri.toString(),
          workspaceUri.fsPath,
          now,
          now,
        );
      return new PersistenceService(database, databasePath);
    } catch (error) {
      database.close();
      throw new PersistenceInitializationError(
        `Could not initialize persistence at ${databasePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }
}
