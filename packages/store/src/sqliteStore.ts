import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  FileLocalStore,
  emptyStoreData,
  normalizeProviderActivationRecord,
  normalizeSkillRegistryTrustProfileRecord
} from "./fileStore.js";
import type { LocalStoreData } from "./types.js";

export interface SqliteLocalStoreOptions {
  rootDir: string;
  databaseFile?: string;
}

export class SqliteLocalStore extends FileLocalStore {
  readonly databaseFile: string;
  private databaseHandle?: DatabaseSync;

  constructor(options: SqliteLocalStoreOptions) {
    const databaseFile = options.databaseFile ?? join(options.rootDir, "mniu.db");
    super({ rootDir: options.rootDir, dataFile: join(options.rootDir, ".unused.json") });
    this.databaseFile = databaseFile;
  }

  override async read(): Promise<LocalStoreData> {
    const row = this.database()
      .prepare("select value from local_state where key = ?")
      .get("data") as { value: string } | undefined;
    if (!row) return emptyStoreData();
    const parsed = JSON.parse(row.value) as LocalStoreData;
    return {
      version: 1,
      providers: (parsed.providers ?? []).map(normalizeProviderActivationRecord),
      projections: parsed.projections ?? [],
      proxy: parsed.proxy ?? emptyStoreData().proxy,
      proxyRequestLogs: parsed.proxyRequestLogs ?? [],
      proxyReplayRecords: parsed.proxyReplayRecords ?? [],
      providerHealth: parsed.providerHealth ?? [],
      mcpServers: parsed.mcpServers ?? [],
      promptPresets: parsed.promptPresets ?? [],
      promptActivations: parsed.promptActivations ?? [],
      skills: parsed.skills ?? [],
      skillInstallations: parsed.skillInstallations ?? [],
      skillRegistryTrustProfiles: (parsed.skillRegistryTrustProfiles ?? []).map(
        normalizeSkillRegistryTrustProfileRecord
      )
    };
  }

  override async write(data: LocalStoreData): Promise<void> {
    this.database()
      .prepare(
        `insert into local_state (key, value)
         values (?, ?)
         on conflict(key) do update set value = excluded.value`
      )
      .run("data", JSON.stringify(data));
  }

  close(): void {
    this.databaseHandle?.close();
    this.databaseHandle = undefined;
  }

  private database(): DatabaseSync {
    if (this.databaseHandle) return this.databaseHandle;
    mkdirSync(this.rootDir, { recursive: true });
    const database = new DatabaseSync(this.databaseFile);
    database.exec(`
      create table if not exists local_state (
        key text primary key,
        value text not null
      )
    `);
    this.databaseHandle = database;
    return database;
  }
}
