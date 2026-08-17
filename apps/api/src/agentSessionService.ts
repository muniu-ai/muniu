// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants, lstatSync, type Dirent, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  realpath,
  type FileHandle
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createAgentHost, type AgentHost } from "@mn/agent-host";
import {
  SessionId,
  assertAgentErrorResponseV1,
  assertAgentModelBindingV1,
  assertAgentSessionControlResponseV1,
  assertAgentSessionViewV1,
  assertSafePublicControlIdV1,
  createSafeRandomPublicControlIdV1,
  deepFreeze,
  inspectAgentApprovalResponseV1,
  inspectAgentErrorResponseV1,
  inspectAgentSessionControlResponseV1,
  snapshotBoundedJsonValue,
  type AgentApprovalDecisionRequestV1,
  type AgentErrorResponseV1,
  type AgentMessageRequestV1,
  type AgentModelBindingV1,
  type AgentSessionControlRequestV1,
  type AgentSessionControlResponseV1,
  type AgentSessionCreateRequestV1,
  type AgentSessionEventV1,
  type AgentSessionViewStateV1,
  type AgentSessionViewV1,
  type JsonValue,
  type LlmRequest,
  type StreamChunk
} from "@mn/agent-protocol";
import {
  JsonlAgentSessionStore,
  AgentSessionNotFoundError,
  RuntimeOverlayRequiredError,
  projectSession,
  recoverInterruptedSession,
  type AgentSession
} from "@mn/agent-session";

export interface AgentServiceResponse<T extends JsonValue = JsonValue> {
  readonly statusCode: number;
  readonly body: T;
}

export interface AgentSessionEventSubscription {
  readonly pause: () => void;
  readonly resume: () => void;
  readonly unsubscribe: () => void;
}

type AgentSessionViewState = AgentSessionViewStateV1;

interface AgentSessionSubscriptionState {
  readonly session: AgentSession;
  readonly listener: (event: AgentSessionEventV1) => boolean | void;
  cursor: number;
  paused: boolean;
  active: boolean;
}

export class AgentSessionServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AgentSessionServiceError";
  }
}

interface AcceptedJournalRecord {
  readonly schemaVersion: 1;
  readonly state: "accepted";
  readonly clientRequestId: string;
  readonly scope: string;
  readonly sessionId?: string;
  readonly digest: string;
}

interface CompletedJournalRecord {
  readonly schemaVersion: 1;
  readonly state: "completed";
  readonly clientRequestId: string;
  readonly scope: string;
  readonly sessionId?: string;
  readonly receipt: JournalReceipt;
  readonly digest: string;
}

type JournalRecord = AcceptedJournalRecord | CompletedJournalRecord;
type UnsignedJournalRecord =
  | Omit<AcceptedJournalRecord, "digest">
  | Omit<CompletedJournalRecord, "digest">;

interface JournalState {
  readonly scope: string;
  readonly sessionId?: string;
  readonly receipt?: JournalReceipt;
}

interface SessionViewReceipt {
  readonly kind: "session-view-v1";
  readonly statusCode: 200 | 201;
  readonly sessionId: string;
  readonly committedSeq: number;
  readonly committedEventDigest: string;
  readonly state: AgentSessionViewState;
  readonly modelBinding: AgentModelBindingV1;
}

interface InlineReceipt {
  readonly kind: "inline-v1";
  readonly statusCode: number;
  readonly body: JsonValue;
}

type JournalReceipt = SessionViewReceipt | InlineReceipt;

interface IdempotentEffectResult {
  readonly response: AgentServiceResponse;
  readonly receipt: JournalReceipt;
}

interface JournalReservation {
  acceptedBytes: number;
  completedBytes: number;
  records: number;
}

const MOCK_PROVIDER = "mock";
const MOCK_MODEL = "local-mock";
const MOCK_MODEL_BINDING_V1: AgentModelBindingV1 = deepFreeze({
  schemaVersion: 1,
  kind: "agent-model-binding",
  providerId: MOCK_PROVIDER,
  modelId: MOCK_MODEL
});
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_LINE_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_RECORDS = 100_000;
const MAX_COMPLETED_JOURNAL_LINE_BYTES = 4096;
const SESSION_VIEW_STATES = new Set<AgentSessionViewState>([
  "idle",
  "active",
  "waiting-approval",
  "completed",
  "cancelled",
  "budget-exceeded",
  "interrupted",
  "error",
  "closed"
]);

function journalDigest(record: UnsignedJournalRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function assertJournalScope(scope: string, sessionId: string | undefined): void {
  if (sessionId === undefined) {
    if (scope !== "create") throw new Error("agent mutation journal scope is invalid");
    return;
  }
  const fixed = [`message:${sessionId}`, `cancel:${sessionId}`, `close:${sessionId}`];
  if (fixed.includes(scope)) return;
  const approvalPrefix = `approval:${sessionId}:`;
  if (!scope.startsWith(approvalPrefix)) throw new Error("agent mutation journal scope is invalid");
  assertSafePublicControlIdV1(scope.slice(approvalPrefix.length), "approval identifier");
}

function asJournalReceipt(value: unknown): JournalReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent mutation journal contains an invalid receipt");
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.kind === "session-view-v1") {
    const keys = [
      "kind",
      "statusCode",
      "sessionId",
      "committedSeq",
      "committedEventDigest",
      "state",
      "modelBinding"
    ];
    const modelBinding = assertAgentModelBindingV1(receipt.modelBinding);
    if (Reflect.ownKeys(receipt).some((key) => typeof key !== "string" || !keys.includes(key))
      || (receipt.statusCode !== 200 && receipt.statusCode !== 201)
      || typeof receipt.sessionId !== "string"
      || !Number.isSafeInteger(receipt.committedSeq)
      || (receipt.committedSeq as number) < 0
      || typeof receipt.committedEventDigest !== "string"
      || !HEX_DIGEST.test(receipt.committedEventDigest)
      || typeof receipt.state !== "string"
      || !SESSION_VIEW_STATES.has(receipt.state as AgentSessionViewState)) {
      throw new Error("agent mutation journal contains an invalid receipt");
    }
    assertSafePublicControlIdV1(receipt.sessionId, "session identifier");
    return deepFreeze({
      kind: "session-view-v1",
      statusCode: receipt.statusCode,
      sessionId: receipt.sessionId,
      committedSeq: receipt.committedSeq,
      committedEventDigest: receipt.committedEventDigest,
      state: receipt.state,
      modelBinding
    }) as SessionViewReceipt;
  }
  if (receipt.kind === "inline-v1") {
    const keys = ["kind", "statusCode", "body"];
    if (Reflect.ownKeys(receipt).some((key) => typeof key !== "string" || !keys.includes(key))
      || !Number.isInteger(receipt.statusCode)
      || (receipt.statusCode as number) < 100
      || (receipt.statusCode as number) > 599) {
      throw new Error("agent mutation journal contains an invalid receipt");
    }
    return deepFreeze({
      kind: "inline-v1",
      statusCode: receipt.statusCode,
      body: snapshotBoundedJsonValue(receipt.body)
    }) as InlineReceipt;
  }
  throw new Error("agent mutation journal contains an invalid receipt");
}

function asJournalRecord(value: unknown): JournalRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent mutation journal contains an invalid record");
  }
  const record = value as Record<string, unknown>;
  const allowed = record.state === "accepted"
    ? ["schemaVersion", "state", "clientRequestId", "scope", "sessionId", "digest"]
    : ["schemaVersion", "state", "clientRequestId", "scope", "sessionId", "receipt", "digest"];
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error("agent mutation journal contains an invalid record");
  }
  if (record.schemaVersion !== 1
    || (record.state !== "accepted" && record.state !== "completed")
    || typeof record.clientRequestId !== "string"
    || typeof record.scope !== "string"
    || (record.sessionId !== undefined && typeof record.sessionId !== "string")
    || typeof record.digest !== "string"
    || !HEX_DIGEST.test(record.digest)) {
    throw new Error("agent mutation journal contains an invalid record");
  }
  assertSafePublicControlIdV1(record.clientRequestId, "client request identifier");
  if (record.sessionId !== undefined) assertSafePublicControlIdV1(record.sessionId, "session identifier");
  assertJournalScope(record.scope, record.sessionId);
  if (record.state === "completed") {
    let receipt = asJournalReceipt(record.receipt);
    if (receipt.kind === "session-view-v1") {
      if ((record.scope === "create" && record.sessionId !== undefined)
        || (record.scope !== "create" && receipt.sessionId !== record.sessionId)
        || (!record.scope.startsWith("message:") && record.scope !== "create")
        || (record.scope === "create"
          && (receipt.statusCode !== 201 || receipt.committedSeq !== 0 || receipt.state !== "idle"))
        || (record.scope.startsWith("message:") && receipt.statusCode !== 200)) {
        throw new Error("agent mutation journal receipt is not bound to its scope");
      }
    } else {
      let body: JsonValue | undefined;
      if (record.scope.startsWith("message:")) {
        const inspected = inspectAgentErrorResponseV1(receipt.body);
        if (inspected !== undefined && receipt.statusCode >= 400) {
          body = inspected as unknown as JsonValue;
        }
      } else if (record.scope.startsWith("cancel:") || record.scope.startsWith("close:")) {
        const inspected = inspectAgentSessionControlResponseV1(receipt.body);
        const action = record.scope.startsWith("cancel:") ? "cancel" : "close";
        if (inspected !== undefined && receipt.statusCode === 200
          && inspected.sessionId === record.sessionId && inspected.action === action) {
          body = inspected as unknown as JsonValue;
        }
      } else if (record.scope.startsWith("approval:")) {
        const inspected = inspectAgentApprovalResponseV1(receipt.body);
        const approvalId = record.scope.slice(`approval:${record.sessionId}:`.length);
        if (inspected !== undefined && receipt.statusCode === 200
          && inspected.sessionId === record.sessionId && inspected.approvalId === approvalId) {
          body = inspected as unknown as JsonValue;
        }
      }
      if (body === undefined) {
        throw new Error("agent mutation journal receipt is not bound to its scope");
      }
      receipt = deepFreeze({ ...receipt, body });
    }
    record.receipt = receipt;
  }
  const { digest, ...unsigned } = record;
  if (journalDigest(unsigned as UnsignedJournalRecord) !== digest) {
    throw new Error("agent mutation journal integrity check failed");
  }
  return record as unknown as JournalRecord;
}

function safeControlId(value: string, label: string): string {
  try {
    assertSafePublicControlIdV1(value, label);
  } catch {
    throw new AgentSessionServiceError(400, "INVALID_CONTROL_ID", `${label} is invalid`);
  }
  return value;
}

function errorResponse(code: string): AgentErrorResponseV1 {
  return assertAgentErrorResponseV1({
    schemaVersion: 1,
    kind: "agent-error-response",
    error: code
  });
}

function mockText(request: LlmRequest): string {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "user");
  const text = message?.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
  return `Mock response: ${text}`;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openBoundRegularFile(filePath: string): Promise<{ handle: FileHandle; stats: Stats }> {
  let handle: FileHandle;
  try {
    handle = await openFile(
      filePath,
      constants.O_CREAT | constants.O_RDWR | constants.O_APPEND
        | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("agent service durable path must not be a symbolic link");
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    const pathStats = await lstat(filePath);
    if (!stats.isFile() || stats.nlink !== 1 || !pathStats.isFile() || !sameIdentity(stats, pathStats)) {
      throw new Error("agent service durable path is not a bound regular file");
    }
    await handle.chmod(0o600);
    return { handle, stats };
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openBoundDirectory(directoryPath: string): Promise<{ handle: FileHandle; stats: Stats }> {
  let handle: FileHandle;
  try {
    handle = await openFile(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("agent service root must not be a symbolic link");
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    const pathStats = await lstat(directoryPath);
    if (!stats.isDirectory() || !pathStats.isDirectory() || !sameIdentity(stats, pathStats)) {
      throw new Error("agent service root is not a bound directory");
    }
    return { handle, stats };
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export class LocalMockAgentSessionService {
  private readonly store: JsonlAgentSessionStore;
  private readonly journalPath: string;
  private projectionDatabase: DatabaseSync | undefined;
  private projectionIdentity: Stats | undefined;
  private rootDirectoryHandle: FileHandle | undefined;
  private journalHandle: FileHandle | undefined;
  private journalBytes = 0;
  private journalRecords = 0;
  private reservedJournalBytes = 0;
  private reservedJournalRecords = 0;
  private journalFailure: unknown;
  private readonly journal = new Map<string, JournalState>();
  private readonly inflight = new Map<string, {
    readonly scope: string;
    readonly sessionId?: string;
    readonly operation: Promise<AgentServiceResponse>;
  }>();
  private readonly active = new Map<string, AbortController>();
  private readonly subscriptions = new Set<AgentSessionSubscriptionState>();
  private readonly closed = new Set<string>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private journalTail: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private host: AgentHost | undefined;
  private disposed = false;
  private subscriptionPoller: NodeJS.Timeout | undefined;

  constructor(private readonly root: string) {
    this.store = new JsonlAgentSessionStore(root);
    this.journalPath = join(root, "mutations.jsonl");
    this.ready = this.initialize();
  }

  protected beforeJournalDirectorySync(): void | Promise<void> {}

  private async initialize(): Promise<void> {
    const lexicalRoot = resolve(this.root);
    try {
      const existingRoot = await lstat(lexicalRoot);
      if (!existingRoot.isDirectory()) {
        throw new Error("agent service root must be a directory, not a symbolic link");
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(lexicalRoot, { recursive: true, mode: 0o700 });
    }
    const rootStats = await lstat(lexicalRoot);
    if (!rootStats.isDirectory()) throw new Error("agent service root must be a directory, not a symbolic link");
    await chmod(lexicalRoot, 0o700);
    const rootBinding = await openBoundDirectory(lexicalRoot);
    this.rootDirectoryHandle = rootBinding.handle;
    const canonicalRoot = await realpath(lexicalRoot);
    if (!sameIdentity(rootStats, rootBinding.stats)) {
      throw new Error("agent service root identity changed during open");
    }
    const projectionPath = join(this.root, "projection.db");
    const projectionBinding = await openBoundRegularFile(projectionPath);
    try {
      this.projectionDatabase = new DatabaseSync(projectionPath);
      const afterOpen = await lstat(projectionPath);
      if (!afterOpen.isFile() || afterOpen.nlink !== 1
        || !sameIdentity(projectionBinding.stats, afterOpen)
        || await realpath(projectionPath) !== join(canonicalRoot, "projection.db")) {
        throw new Error("agent service projection path identity changed during open");
      }
      this.projectionIdentity = afterOpen;
    } finally {
      await projectionBinding.handle.close();
    }
    this.projectionDatabase.exec(`
      create table if not exists agent_session_projection (
        session_id text primary key,
        last_seq integer not null,
        state text not null,
        projection_json text not null
      )
    `);
    const journalBinding = await openBoundRegularFile(this.journalPath);
    this.journalHandle = journalBinding.handle;
    try {
      const currentRoot = await lstat(lexicalRoot);
      if (!currentRoot.isDirectory()
        || !sameIdentity(rootBinding.stats, currentRoot)
        || await realpath(lexicalRoot) !== canonicalRoot
        || await realpath(this.journalPath) !== join(canonicalRoot, "mutations.jsonl")) {
        throw new Error("agent service root or journal identity changed during open");
      }
      await this.beforeJournalDirectorySync();
      await rootBinding.handle.sync();
      let contents: string;
      const metadata = journalBinding.stats;
      if (metadata.size > MAX_JOURNAL_BYTES) {
        throw new Error("agent mutation journal exceeds the size limit");
      }
      contents = await journalBinding.handle.readFile("utf8");
      if (contents.length > 0 && !contents.endsWith("\n")) {
        throw new Error("agent mutation journal has an incomplete final record");
      }
      for (const line of contents.split("\n")) {
        if (line.length === 0) continue;
        this.journalRecords += 1;
        if (this.journalRecords > MAX_JOURNAL_RECORDS
          || Buffer.byteLength(line, "utf8") > MAX_JOURNAL_LINE_BYTES) {
          throw new Error("agent mutation journal exceeds the record limit");
        }
        const record = asJournalRecord(JSON.parse(line));
        const existing = this.journal.get(record.clientRequestId);
        if (existing === undefined && record.state !== "accepted") {
          throw new Error("agent mutation journal has a terminal record without acceptance");
        }
        if (existing !== undefined
          && (existing.scope !== record.scope || existing.sessionId !== record.sessionId)) {
          throw new Error("agent mutation journal rebinds a client request identifier");
        }
        if (existing?.receipt !== undefined || (existing !== undefined && record.state !== "completed")) {
          throw new Error("agent mutation journal contains an invalid state transition");
        }
        this.journal.set(record.clientRequestId, {
          scope: record.scope,
          ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
          ...(record.state === "completed" ? { receipt: record.receipt } : {})
        });
        if (record.state === "completed" && record.scope === `close:${record.sessionId}` && record.sessionId) {
          this.closed.add(record.sessionId);
        }
      }
      this.journalBytes = metadata.size;
    } catch (error: unknown) {
      await journalBinding.handle.close().catch(() => undefined);
      this.journalHandle = undefined;
      throw error;
    }
    this.host = await createAgentHost({
      sessionStore: this.store,
      adapters: [{
        id: MOCK_PROVIDER,
        async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
          await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
          yield { type: "text-delta", index: 0, text: mockText(request) };
          yield { type: "finish", reason: "stop" };
        }
      }],
      tools: [],
      authorizer: { authorize: async () => ({ decision: "deny" }) }
    });
    await this.recoverPersistedSessions();
  }

  private async recoverPersistedSessions(): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(join(this.root, "sessions"), { withFileTypes: true, encoding: "utf8" });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) throw new Error("durable session storage contains an invalid entry");
      safeControlId(entry.name, "session identifier");
      const session = await this.store.open(SessionId(entry.name));
      await recoverInterruptedSession(session);
      const projection = projectSession(session.events);
      this.persistProjection(
        session.header.sessionId,
        session.events.at(-1)?.seq ?? -1,
        projection.status,
        projection
      );
    }
  }

  private encodeJournal(record: UnsignedJournalRecord): { line: string; bytes: number } {
    const complete = { ...record, digest: journalDigest(record) } as JournalRecord;
    const line = `${JSON.stringify(complete)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_JOURNAL_LINE_BYTES) {
      throw new Error("agent mutation journal record exceeds the size limit");
    }
    return { line, bytes };
  }

  private reserveJournalMutation(record: UnsignedJournalRecord): JournalReservation {
    if (this.journalFailure !== undefined) {
      throw new AgentSessionServiceError(503, "MUTATION_JOURNAL_UNAVAILABLE", "mutation journal is unavailable");
    }
    const acceptedBytes = this.encodeJournal(record).bytes;
    const reservedBytes = acceptedBytes + MAX_COMPLETED_JOURNAL_LINE_BYTES;
    if (this.journalBytes + this.reservedJournalBytes + reservedBytes > MAX_JOURNAL_BYTES
      || this.journalRecords + this.reservedJournalRecords + 2 > MAX_JOURNAL_RECORDS) {
      throw new AgentSessionServiceError(507, "MUTATION_JOURNAL_FULL", "mutation journal capacity is exhausted");
    }
    this.reservedJournalBytes += reservedBytes;
    this.reservedJournalRecords += 2;
    return { acceptedBytes, completedBytes: MAX_COMPLETED_JOURNAL_LINE_BYTES, records: 2 };
  }

  private releaseJournalReservation(reservation: JournalReservation): void {
    this.reservedJournalBytes -= reservation.acceptedBytes + reservation.completedBytes;
    this.reservedJournalRecords -= reservation.records;
    reservation.acceptedBytes = 0;
    reservation.completedBytes = 0;
    reservation.records = 0;
  }

  private async appendJournal(
    record: UnsignedJournalRecord,
    reservation: JournalReservation,
    phase: "accepted" | "completed"
  ): Promise<void> {
    const encoded = this.encodeJournal(record);
    const reservedBytes = phase === "accepted" ? reservation.acceptedBytes : reservation.completedBytes;
    if (encoded.bytes > reservedBytes || reservation.records <= 0) {
      throw new Error("agent mutation journal reservation is insufficient");
    }
    const operation = this.journalTail.then(async () => {
      if (this.journalFailure !== undefined) throw this.journalFailure;
      const handle = this.journalHandle;
      if (!handle) throw new Error("agent mutation journal is unavailable");
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== this.journalBytes) {
          throw new Error("agent mutation journal identity or size changed outside the writer");
        }
        await handle.writeFile(encoded.line, "utf8");
        await handle.sync();
        const after = await handle.stat();
        if (!sameIdentity(before, after) || after.nlink !== 1
          || after.size !== this.journalBytes + encoded.bytes) {
          throw new Error("agent mutation journal write did not preserve its bound identity");
        }
        this.journalBytes += encoded.bytes;
        this.journalRecords += 1;
        this.reservedJournalBytes -= reservedBytes;
        this.reservedJournalRecords -= 1;
        if (phase === "accepted") reservation.acceptedBytes = 0;
        else reservation.completedBytes = 0;
        reservation.records -= 1;
      } catch (error: unknown) {
        this.journalFailure = error;
        throw error;
      }
    });
    this.journalTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async idempotent(
    clientRequestId: string,
    scope: string,
    sessionId: string | undefined,
    effect: () => Promise<IdempotentEffectResult>
  ): Promise<AgentServiceResponse> {
    await this.ready;
    safeControlId(clientRequestId, "client request identifier");
    const prior = this.journal.get(clientRequestId);
    if (prior !== undefined) {
      if (prior.scope !== scope || prior.sessionId !== sessionId) {
        throw new AgentSessionServiceError(409, "IDEMPOTENCY_SCOPE_CONFLICT", "client request identifier is already bound");
      }
      if (prior.receipt !== undefined) return this.materializeReceipt(prior.receipt);
      throw new AgentSessionServiceError(409, "IDEMPOTENT_OPERATION_INTERRUPTED", "mutation was interrupted and was not replayed");
    }
    const active = this.inflight.get(clientRequestId);
    if (active !== undefined) {
      if (active.scope !== scope || active.sessionId !== sessionId) {
        throw new AgentSessionServiceError(409, "IDEMPOTENCY_SCOPE_CONFLICT", "client request identifier is already bound");
      }
      return active.operation;
    }
    const accepted: UnsignedJournalRecord = {
      schemaVersion: 1,
      state: "accepted",
      clientRequestId,
      scope,
      ...(sessionId === undefined ? {} : { sessionId })
    };
    const reservation = this.reserveJournalMutation(accepted);
    const operation = (async () => {
      try {
        await this.appendJournal(accepted, reservation, "accepted");
        this.journal.set(clientRequestId, { scope, ...(sessionId === undefined ? {} : { sessionId }) });
        const result = await effect();
        await this.appendJournal({
          schemaVersion: 1,
          state: "completed",
          clientRequestId,
          scope,
          ...(sessionId === undefined ? {} : { sessionId }),
          receipt: result.receipt
        }, reservation, "completed");
        this.journal.set(clientRequestId, {
          scope,
          ...(sessionId === undefined ? {} : { sessionId }),
          receipt: result.receipt
        });
        return result.response;
      } finally {
        this.releaseJournalReservation(reservation);
      }
    })();
    this.inflight.set(clientRequestId, {
      scope,
      ...(sessionId === undefined ? {} : { sessionId }),
      operation
    });
    try {
      return await operation;
    } finally {
      this.inflight.delete(clientRequestId);
    }
  }

  private enqueueSession<T>(sessionId: string, effect: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(effect);
    this.sessionTails.set(sessionId, operation.then(() => undefined, () => undefined));
    return operation;
  }

  private async open(sessionId: string): Promise<AgentSession> {
    await this.ready;
    safeControlId(sessionId, "session identifier");
    try {
      const session = await this.store.open(SessionId(sessionId));
      return session;
    } catch (error: unknown) {
      if (error instanceof RuntimeOverlayRequiredError) throw error;
      if (error instanceof AgentSessionNotFoundError) {
        throw new AgentSessionServiceError(404, "SESSION_NOT_FOUND", "agent session was not found");
      }
      throw new AgentSessionServiceError(503, "SESSION_UNAVAILABLE", "agent session storage is unavailable");
    }
  }

  private persistProjection(
    sessionId: string,
    lastSeq: number,
    state: AgentSessionViewState,
    projection: ReturnType<typeof projectSession>
  ): void {
    const projectionDatabase = this.projectionDatabase;
    const projectionIdentity = this.projectionIdentity;
    if (!projectionDatabase || !projectionIdentity) {
      throw new Error("agent session projection is unavailable");
    }
    const currentProjection = lstatSync(join(this.root, "projection.db"));
    if (!currentProjection.isFile() || currentProjection.nlink !== 1
      || !sameIdentity(projectionIdentity, currentProjection)) {
      throw new Error("agent session projection path identity changed");
    }
    projectionDatabase.prepare(`
      insert into agent_session_projection (session_id, last_seq, state, projection_json)
      values (?, ?, ?, ?)
      on conflict(session_id) do update set
        last_seq = excluded.last_seq,
        state = excluded.state,
        projection_json = excluded.projection_json
    `).run(sessionId, lastSeq, state, JSON.stringify(projection));
  }

  private view(
    session: AgentSession,
    persistProjection = true,
    events: readonly AgentSessionEventV1[] = session.events,
    includeCurrentClosedState = true,
    stateOverride?: AgentSessionViewState
  ): AgentSessionViewV1 {
    const projection = projectSession(events);
    const state = stateOverride ?? (includeCurrentClosedState && this.closed.has(session.header.sessionId)
      ? "closed"
      : projection.status);
    if (persistProjection) {
      this.persistProjection(
        session.header.sessionId,
        events.at(-1)?.seq ?? -1,
        state,
        projection
      );
    }
    const committed = events.at(-1);
    if (committed === undefined) throw new Error("agent session view has no committed event");
    if (session.header.modelBinding === undefined) {
      throw new AgentSessionServiceError(
        503,
        "MODEL_BINDING_UNAVAILABLE",
        "agent session has no authoritative durable model binding"
      );
    }
    return assertAgentSessionViewV1({
      schemaVersion: 1,
      kind: "agent-session-view",
      sessionId: session.header.sessionId,
      state,
      modelBinding: session.header.modelBinding,
      eventCursor: {
        lastSeq: committed.seq,
        lastDigest: committed.digest
      }
    });
  }

  private sessionViewResult(statusCode: 200 | 201, session: AgentSession): IdempotentEffectResult {
    const body = this.view(session);
    return deepFreeze({
      response: { statusCode, body: body as unknown as JsonValue },
      receipt: {
        kind: "session-view-v1",
        statusCode,
        sessionId: body.sessionId,
        committedSeq: body.eventCursor.lastSeq,
        committedEventDigest: body.eventCursor.lastDigest,
        state: body.state,
        modelBinding: body.modelBinding
      }
    });
  }

  private inlineResult(statusCode: number, body: unknown): IdempotentEffectResult {
    const fixedBody = snapshotBoundedJsonValue(body);
    return deepFreeze({
      response: { statusCode, body: fixedBody },
      receipt: { kind: "inline-v1", statusCode, body: fixedBody }
    });
  }

  private async materializeReceipt(receipt: JournalReceipt): Promise<AgentServiceResponse> {
    if (receipt.kind === "inline-v1") {
      return deepFreeze({ statusCode: receipt.statusCode, body: receipt.body });
    }
    const session = await this.open(receipt.sessionId);
    if (session.header.modelBinding === undefined
      || JSON.stringify(session.header.modelBinding) !== JSON.stringify(receipt.modelBinding)) {
      throw new AgentSessionServiceError(503, "RECEIPT_UNAVAILABLE", "mutation receipt cannot be reconstructed");
    }
    const committed = session.events[receipt.committedSeq];
    if (committed === undefined || committed.seq !== receipt.committedSeq
      || committed.digest !== receipt.committedEventDigest) {
      throw new AgentSessionServiceError(503, "RECEIPT_UNAVAILABLE", "mutation receipt cannot be reconstructed");
    }
    const events = session.events.slice(0, receipt.committedSeq + 1);
    const projectedState = projectSession(events).status;
    if (receipt.state !== "closed" && receipt.state !== projectedState) {
      throw new AgentSessionServiceError(503, "RECEIPT_UNAVAILABLE", "mutation receipt cannot be reconstructed");
    }
    const body = this.view(session, false, events, false, receipt.state);
    return deepFreeze({ statusCode: receipt.statusCode, body: body as unknown as JsonValue });
  }

  create(input: AgentSessionCreateRequestV1): Promise<AgentServiceResponse> {
    if (input.modelBinding.providerId !== MOCK_PROVIDER || input.modelBinding.modelId !== MOCK_MODEL) {
      return Promise.reject(new AgentSessionServiceError(400, "MODEL_UNAVAILABLE", "local mock service supports only its fixed model"));
    }
    const sessionId = SessionId(createSafeRandomPublicControlIdV1("session"));
    return this.idempotent(input.clientRequestId, "create", undefined, async () => {
      const session = await this.store.create({
        sessionId,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.labels === undefined ? {} : { labels: { ...input.labels } }),
        modelBinding: MOCK_MODEL_BINDING_V1
      });
      return this.sessionViewResult(201, session);
    });
  }

  async get(sessionId: string): Promise<AgentSessionViewV1> {
    return this.view(await this.open(sessionId), false);
  }

  eventsAfter(sessionId: string, after: number): Promise<readonly AgentSessionEventV1[]> {
    return this.open(sessionId).then((session) => session.events.filter((event) => event.seq > after));
  }

  get activeSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  async subscribeEvents(
    sessionId: string,
    after: number,
    listener: (event: AgentSessionEventV1) => boolean | void
  ): Promise<AgentSessionEventSubscription> {
    const session = await this.open(sessionId);
    const subscription: AgentSessionSubscriptionState = {
      session,
      listener,
      cursor: after,
      paused: false,
      active: true
    };
    this.subscriptions.add(subscription);
    try {
      this.pumpSubscription(subscription);
    } catch (error: unknown) {
      subscription.active = false;
      this.subscriptions.delete(subscription);
      throw error;
    }
    this.subscriptionPoller ??= setInterval(() => {
      for (const current of this.subscriptions) {
        try {
          this.pumpSubscription(current);
        } catch {
          current.active = false;
          this.subscriptions.delete(current);
        }
      }
      if (this.subscriptions.size === 0 && this.subscriptionPoller) {
        clearInterval(this.subscriptionPoller);
        this.subscriptionPoller = undefined;
      }
    }, 10);
    const unsubscribe = (): void => {
      if (!subscription.active) return;
      subscription.active = false;
      this.subscriptions.delete(subscription);
      if (this.subscriptions.size === 0 && this.subscriptionPoller) {
        clearInterval(this.subscriptionPoller);
        this.subscriptionPoller = undefined;
      }
    };
    return Object.freeze({
      pause: () => {
        if (subscription.active) subscription.paused = true;
      },
      resume: () => {
        if (!subscription.active) return;
        subscription.paused = false;
        this.pumpSubscription(subscription);
      },
      unsubscribe
    });
  }

  private pumpSubscription(subscription: AgentSessionSubscriptionState): void {
    if (!subscription.active || subscription.paused) return;
    for (const event of subscription.session.events) {
      if (event.seq <= subscription.cursor) continue;
      const continueImmediately = subscription.listener(event);
      subscription.cursor = event.seq;
      if (continueImmediately === false) {
        subscription.paused = true;
        return;
      }
    }
  }

  async message(sessionId: string, input: AgentMessageRequestV1): Promise<AgentServiceResponse> {
    safeControlId(sessionId, "session identifier");
    const durableSession = await this.open(sessionId);
    return this.idempotent(input.clientRequestId, `message:${sessionId}`, sessionId, () => {
      return this.enqueueSession(sessionId, async () => {
        if (this.closed.has(sessionId)) {
          return this.inlineResult(409, errorResponse("SESSION_CLOSED"));
        }
        const controller = new AbortController();
        this.active.set(sessionId, controller);
        try {
          const host = this.host;
          if (!host) throw new Error("agent host is unavailable");
          const modelBinding = durableSession.header.modelBinding;
          if (modelBinding === undefined) {
            return this.inlineResult(409, errorResponse("MODEL_BINDING_UNAVAILABLE"));
          }
          const result = await host.resume({
            sessionId: SessionId(sessionId),
            prompt: input.prompt,
            provider: modelBinding.providerId,
            model: modelBinding.modelId,
            signal: controller.signal
          });
          return this.sessionViewResult(200, result.session);
        } catch (error: unknown) {
          if (error instanceof RuntimeOverlayRequiredError) {
            return this.inlineResult(409, errorResponse(error.code));
          }
          throw error;
        } finally {
          if (this.active.get(sessionId) === controller) this.active.delete(sessionId);
        }
      });
    });
  }

  async cancel(sessionId: string, input: AgentSessionControlRequestV1): Promise<AgentServiceResponse> {
    safeControlId(sessionId, "session identifier");
    if (!this.active.has(sessionId)) await this.open(sessionId);
    return this.idempotent(input.clientRequestId, `cancel:${sessionId}`, sessionId, async () => {
      const controller = this.active.get(sessionId);
      if (controller) controller.abort();
      const body: AgentSessionControlResponseV1 = assertAgentSessionControlResponseV1({
        schemaVersion: 1,
        kind: "agent-session-control-response",
        sessionId,
        action: "cancel",
        cancelled: controller !== undefined
      });
      return this.inlineResult(200, body);
    });
  }

  async close(sessionId: string, input: AgentSessionControlRequestV1): Promise<AgentServiceResponse> {
    safeControlId(sessionId, "session identifier");
    if (!this.active.has(sessionId)) await this.open(sessionId);
    return this.idempotent(input.clientRequestId, `close:${sessionId}`, sessionId, async () => {
      const controller = this.active.get(sessionId);
      this.closed.add(sessionId);
      controller?.abort();
      const body: AgentSessionControlResponseV1 = assertAgentSessionControlResponseV1({
        schemaVersion: 1,
        kind: "agent-session-control-response",
        sessionId,
        action: "close",
        state: "closed"
      });
      return this.inlineResult(200, body);
    });
  }

  async approve(
    sessionId: string,
    approvalId: string,
    input: AgentApprovalDecisionRequestV1
  ): Promise<AgentServiceResponse> {
    safeControlId(sessionId, "session identifier");
    safeControlId(approvalId, "approval identifier");
    const session = await this.open(sessionId);
    const approval = projectSession(session.events).pendingApprovals.find(
      (candidate) => candidate.binding.approvalId === approvalId && candidate.state === "requested"
    );
    if (approval === undefined) {
      throw new AgentSessionServiceError(404, "APPROVAL_NOT_FOUND", "approval request was not found");
    }
    throw new AgentSessionServiceError(409, "APPROVAL_DECISION_UNAVAILABLE", "approval decisions are not enabled");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    try {
      await this.ready;
    } catch (error: unknown) {
      failures.push(error);
    }
    for (const controller of this.active.values()) controller.abort();
    for (const subscription of this.subscriptions) {
      subscription.active = false;
      subscription.paused = true;
    }
    this.subscriptions.clear();
    if (this.subscriptionPoller) clearInterval(this.subscriptionPoller);
    this.subscriptionPoller = undefined;
    await Promise.allSettled([...this.sessionTails.values()]);
    const inflightResults = await Promise.allSettled(
      [...this.inflight.values()].map((entry) => entry.operation)
    );
    failures.push(...inflightResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
    try {
      await this.journalTail;
      await this.journalHandle?.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    this.journalHandle = undefined;
    if (this.host) {
      try {
        await this.host.dispose();
      } catch (error: unknown) {
        failures.push(error);
      }
    } else {
      try {
        await this.store.dispose();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    try {
      this.projectionDatabase?.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    this.projectionDatabase = undefined;
    this.projectionIdentity = undefined;
    try {
      await this.rootDirectoryHandle?.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    this.rootDirectoryHandle = undefined;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "agent session service disposal failed", { cause: failures[0] });
    }
  }
}
