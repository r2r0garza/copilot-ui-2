import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  maxChannelVersion,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";

type SqlValue = string | number | bigint | null | Uint8Array;

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
  pending_writes: string;
}

interface PendingWriteRow {
  task_id: string;
  channel: string;
  type: string | null;
  value: string | null;
}

function prepareCheckpointQuery(
  database: DatabaseSync,
  withCheckpointId: boolean,
): StatementSync {
  return database.prepare(`
    SELECT
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      parent_checkpoint_id,
      type,
      checkpoint,
      metadata,
      (
        SELECT json_group_array(
          json_object(
            'task_id', pending.task_id,
            'channel', pending.channel,
            'type', pending.type,
            'value', CAST(pending.value AS TEXT)
          )
        )
        FROM writes AS pending
        WHERE pending.thread_id = checkpoints.thread_id
          AND pending.checkpoint_ns = checkpoints.checkpoint_ns
          AND pending.checkpoint_id = checkpoints.checkpoint_id
      ) AS pending_writes
    FROM checkpoints
    WHERE thread_id = ? AND checkpoint_ns = ?
      ${withCheckpointId ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"}
  `);
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * LangGraph checkpoint saver backed by Node's built-in SQLite runtime.
 *
 * Using `node:sqlite` avoids shipping an Electron-ABI-specific native addon in
 * the VSIX while retaining the synchronous storage semantics of LangGraph's
 * official SQLite saver.
 */
export class NodeSqliteSaver extends BaseCheckpointSaver {
  readonly database: DatabaseSync;
  private isSetup = false;
  private withoutCheckpoint!: StatementSync;
  private withCheckpoint!: StatementSync;

  constructor(database: DatabaseSync, serde?: SerializerProtocol) {
    super(serde);
    this.database = database;
  }

  static fromPath(databasePath: string): NodeSqliteSaver {
    return new NodeSqliteSaver(new DatabaseSync(databasePath));
  }

  close(): void {
    this.database.close();
  }

  private setup(): void {
    if (this.isSetup) {
      return;
    }

    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );

      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `);
    this.withoutCheckpoint = prepareCheckpointQuery(this.database, false);
    this.withCheckpoint = prepareCheckpointQuery(this.database, true);
    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const {
      thread_id: threadId,
      checkpoint_ns: checkpointNamespace = "",
      checkpoint_id: checkpointId,
    } = config.configurable ?? {};
    if (!threadId) {
      throw new Error('Missing "thread_id" field in passed "config.configurable".');
    }

    const row = (
      checkpointId
        ? this.withCheckpoint.get(threadId, checkpointNamespace, checkpointId)
        : this.withoutCheckpoint.get(threadId, checkpointNamespace)
    ) as unknown as CheckpointRow | undefined;
    if (!row) {
      return undefined;
    }

    const resolvedConfig: RunnableConfig = {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
      },
    };
    const pendingWrites = await Promise.all(
      (JSON.parse(row.pending_writes) as PendingWriteRow[]).map(
        async (write) =>
          [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(
              write.type ?? "json",
              write.value ?? "",
            ),
          ] as [string, string, unknown],
      ),
    );
    const checkpoint = await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint,
    );

    if (checkpoint.v < 4 && row.parent_checkpoint_id) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        row.parent_checkpoint_id,
      );
    }

    return {
      checkpoint,
      config: resolvedConfig,
      metadata: await this.serde.loadsTyped(
        row.type ?? "json",
        row.metadata,
      ),
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns;
    const clauses: string[] = [];
    const parameters: SqlValue[] = [];

    if (threadId) {
      clauses.push("thread_id = ?");
      parameters.push(threadId);
    }
    if (checkpointNamespace !== undefined && checkpointNamespace !== null) {
      clauses.push("checkpoint_ns = ?");
      parameters.push(checkpointNamespace);
    }
    if (options?.before?.configurable?.checkpoint_id) {
      clauses.push("checkpoint_id < ?");
      parameters.push(options.before.configurable.checkpoint_id);
    }

    for (const [key, value] of Object.entries(options?.filter ?? {})) {
      if (value === undefined) {
        continue;
      }
      clauses.push(
        "json_extract(CAST(metadata AS TEXT), ?) = json_extract(?, '$')",
      );
      parameters.push(`$.${key}`, JSON.stringify(value));
    }

    const limit = options?.limit
      ? ` LIMIT ${Math.max(0, Math.trunc(options.limit))}`
      : "";
    const sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT json_group_array(
            json_object(
              'task_id', pending.task_id,
              'channel', pending.channel,
              'type', pending.type,
              'value', CAST(pending.value AS TEXT)
            )
          )
          FROM writes AS pending
          WHERE pending.thread_id = checkpoints.thread_id
            AND pending.checkpoint_ns = checkpoints.checkpoint_ns
            AND pending.checkpoint_id = checkpoints.checkpoint_id
        ) AS pending_writes
      FROM checkpoints
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY checkpoint_id DESC${limit}
    `;

    const rows = this.database
      .prepare(sql)
      .all(...parameters) as unknown as CheckpointRow[];
    for (const row of rows) {
      yield (await this.getTuple({
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      }))!;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      throw new Error('Missing "thread_id" field in passed "config.configurable".');
    }

    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";
    const parentCheckpointId = config.configurable?.checkpoint_id ?? null;
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[checkpointType, serializedCheckpoint], [metadataType, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);
    if (checkpointType !== metadataType) {
      throw new Error(
        "Checkpoint and metadata were serialized with different types.",
      );
    }

    this.database
      .prepare(`
        INSERT OR REPLACE INTO checkpoints (
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          parent_checkpoint_id,
          type,
          checkpoint,
          metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        threadId,
        checkpointNamespace,
        checkpoint.id,
        parentCheckpointId,
        checkpointType,
        serializedCheckpoint,
        serializedMetadata,
      );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId || !checkpointId) {
      throw new Error(
        'Missing "thread_id" or "checkpoint_id" in passed "config.configurable".',
      );
    }

    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const statement = this.database.prepare(`
      INSERT ${allSpecial ? "OR REPLACE" : "OR IGNORE"} INTO writes (
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id,
        idx,
        channel,
        type,
        value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, serializedValue] = await this.serde.dumpsTyped(value);
        return [
          threadId,
          config.configurable?.checkpoint_ns ?? "",
          checkpointId,
          taskId,
          WRITES_IDX_MAP[channel] ?? index,
          channel,
          type,
          serializedValue,
        ] as SqlValue[];
      }),
    );

    transaction(this.database, () => {
      for (const row of rows) {
        statement.run(...row);
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    transaction(this.database, () => {
      this.database
        .prepare("DELETE FROM checkpoints WHERE thread_id = ?")
        .run(threadId);
      this.database
        .prepare("DELETE FROM writes WHERE thread_id = ?")
        .run(threadId);
    });
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const row = this.database
      .prepare(`
        SELECT json_group_array(
          json_object(
            'type', pending.type,
            'value', CAST(pending.value AS TEXT)
          )
        ) AS pending_sends
        FROM writes AS pending
        WHERE pending.thread_id = ?
          AND pending.checkpoint_id = ?
          AND pending.channel = ?
        ORDER BY pending.idx
      `)
      .get(threadId, parentCheckpointId, TASKS) as unknown as {
      pending_sends: string;
    };
    const mutableCheckpoint = checkpoint;
    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = await Promise.all(
      (
        JSON.parse(row.pending_sends) as Array<{
          type: string;
          value: string;
        }>
      ).map(({ type, value }) => this.serde.loadsTyped(type, value)),
    );
    mutableCheckpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}
