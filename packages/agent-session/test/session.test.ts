import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  CallId,
  CandidateId,
  Digest,
  EventId,
  MessageId,
  PROTECTION_POLICY_DIGEST_V1,
  RunId,
  SessionId,
  createAgentSessionEvent,
  createAssistantMessage,
  createModelAttemptStartedV1,
  createModelPricingSnapshotV1,
  createProtectedTextV1,
  createRuntimeEffectCommitmentBinderV1,
  createUserMessage,
  deriveToolEffectKindV1,
  protectAgentSessionPayloadV1,
  verifyAgentSessionEventChain
} from "@mn/agent-protocol";
import {
  InMemoryAgentSessionStore,
  JsonlAgentSessionStore,
  DurableAgentSession,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  projectSession,
  recoverInterruptedSession
} from "../src/index.js";
import type { AgentSessionExclusiveView, AgentSessionHeaderV1 } from "../src/index.js";
import { settleDescriptorLockCommand } from "../src/descriptor-lock.js";
import {
  acquireOsWriterLock,
  resolveEventWriterHelperCommand,
  resolveWriterLockHelper
} from "../src/writer-lock.js";

const CHILD_PROCESS_ENV = { ...process.env };
delete CHILD_PROCESS_ENV.NODE_V8_COVERAGE;
delete CHILD_PROCESS_ENV.NODE_TEST_CONTEXT;

function testSessionHeader(sessionId: SessionId): AgentSessionHeaderV1 {
  return {
    schemaVersion: 1 as const,
    sessionId,
    createdAt: "2026-08-15T00:00:00.000Z",
    protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1
  };
}

function fixedWriterLockRoot(ownerUid: number | undefined): string {
  assert.equal(typeof ownerUid, "number");
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  return path.join(temporaryRoot, `muniu-agent-session-writer-locks-${String(ownerUid)}`);
}

const CHILD_STORE_SCRIPT = String.raw`
const [moduleUrl, root, sessionId, command] = process.argv.slice(1);
const { JsonlAgentSessionStore } = await import(moduleUrl);
const store = new JsonlAgentSessionStore(root, command === "create-hold" ? {
  beforeAppend: async (event) => {
    if (event.type !== "session/created") return;
    process.stdout.write("STAGED\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
  }
} : {});
try {
  if (command === "create-hold") {
    await store.create({ sessionId });
    process.stdout.write("CREATED\n");
  } else {
    await store.open(sessionId);
    process.stdout.write("ACQUIRED\n");
  }
  if (command === "hold") {
    await new Promise((resolve) => process.stdin.once("data", resolve));
  }
  await store.dispose();
} catch (error) {
  process.stderr.write("BLOCKED " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 23;
}
`;

const CHILD_WRITER_LOCK_SCRIPT = String.raw`
const [moduleUrl, identity] = process.argv.slice(1);
const { acquireOsWriterLock } = await import(moduleUrl);
try {
  const lock = await acquireOsWriterLock(identity);
  process.stdout.write("ACQUIRED\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  await lock.release();
} catch (error) {
  process.stderr.write("BLOCKED " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 23;
}
`;

const CHILD_GATED_APPEND_SCRIPT = String.raw`
const [moduleUrl, root, sessionId] = process.argv.slice(1);
const { JsonlAgentSessionStore } = await import(moduleUrl);
const store = new JsonlAgentSessionStore(root, {
  beforeAppend: async (event) => {
    if (event.type !== "turn/start") return;
    process.stdout.write("BEFORE_APPEND\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    setImmediate(() => process.stdout.write("REQUEST_DISPATCHED\n"));
  }
});
try {
  const session = await store.open(sessionId);
  try {
    await session.append("turn/start", { turn: 1 });
    process.stdout.write("APPEND_OK\n");
  } catch (error) {
    process.stdout.write("APPEND_FAILED " + (error instanceof Error ? error.message : String(error)) + "\n");
  }
  await new Promise((resolve) => process.stdin.once("data", resolve));
} catch (error) {
  process.stderr.write("BLOCKED " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 23;
} finally {
  try { await store.dispose(); } catch (error) {
    process.stderr.write("DISPOSE_FAILED " + (error instanceof Error ? error.message : String(error)) + "\n");
  }
}
`;

const CHILD_APPEND_ONCE_SCRIPT = String.raw`
const [moduleUrl, root, sessionId] = process.argv.slice(1);
const { JsonlAgentSessionStore } = await import(moduleUrl);
const store = new JsonlAgentSessionStore(root);
try {
  const session = await store.open(sessionId);
  await session.append("turn/start", { turn: 1 });
  process.stdout.write("APPENDED\n");
} catch (error) {
  process.stderr.write("BLOCKED " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 23;
} finally {
  try { await store.dispose(); } catch {}
}
`;

function spawnStoreProcess(root: string, sessionId: SessionId, command: "create-hold" | "hold" | "try"):
ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    CHILD_STORE_SCRIPT,
    new URL("../src/index.js", import.meta.url).href,
    root,
    sessionId,
    command
  ], { env: CHILD_PROCESS_ENV, stdio: ["pipe", "pipe", "pipe"] });
}

function spawnWriterLockProcess(
  identity: string,
  env: NodeJS.ProcessEnv = CHILD_PROCESS_ENV
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    CHILD_WRITER_LOCK_SCRIPT,
    new URL("../src/writer-lock.js", import.meta.url).href,
    identity
  ], { env, stdio: ["pipe", "pipe", "pipe"] });
}

function spawnGatedAppendProcess(root: string, sessionId: SessionId): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    CHILD_GATED_APPEND_SCRIPT,
    new URL("../src/index.js", import.meta.url).href,
    root,
    sessionId
  ], { env: CHILD_PROCESS_ENV, stdio: ["pipe", "pipe", "pipe"] });
}

function spawnAppendOnceProcess(root: string, sessionId: SessionId): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    CHILD_APPEND_ONCE_SCRIPT,
    new URL("../src/index.js", import.meta.url).href,
    root,
    sessionId
  ], { env: CHILD_PROCESS_ENV, stdio: ["pipe", "pipe", "pipe"] });
}

function processTable(): ReadonlyArray<{ readonly pid: number; readonly parentPid: number; readonly command: string }> {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] as string }];
  });
}

function findDescendantEventWriter(ancestorPid: number): number {
  const rows = processTable();
  const parents = new Map(rows.map((row) => [row.pid, row.parentPid]));
  const candidates = rows.filter((row) => path.basename(row.command.split(" ")[0] as string).startsWith("node")
    && row.command.includes("event-writer-helper.js") && (() => {
    let current = row.parentPid;
    while (current > 1) {
      if (current === ancestorPid) return true;
      current = parents.get(current) ?? 0;
    }
    return false;
  })());
  assert.equal(candidates.length, 1, `expected one event writer below ${String(ancestorPid)}`);
  return candidates[0]?.pid as number;
}

async function pidsWithOpenFile(filePath: string): Promise<number[]> {
  const canonical = await realpath(filePath);
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/sbin/lsof", ["-t", canonical], { encoding: "utf8" });
    if (result.status === 1 && result.stdout.trim() === "") return [];
    assert.equal(result.status, 0, result.stderr);
    return [...new Set(result.stdout.trim().split("\n").filter(Boolean).map(Number))].sort((left, right) => left - right);
  }
  if (process.platform !== "linux") throw new Error(`unsupported test platform: ${process.platform}`);
  const pids: number[] = [];
  for (const processName of await readdir("/proc")) {
    if (!/^\d+$/u.test(processName)) continue;
    let descriptors: string[];
    try {
      descriptors = await readdir(`/proc/${processName}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        if (await readlink(`/proc/${processName}/fd/${descriptor}`) === canonical) {
          pids.push(Number(processName));
          break;
        }
      } catch {
        // The process or descriptor disappeared while taking the diagnostic snapshot.
      }
    }
  }
  return pids.sort((left, right) => left - right);
}

async function descriptorTarget(pid: number, descriptor: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${String(pid)}/fd/${String(descriptor)}`);
    } catch {
      return undefined;
    }
  }
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-a", "-p", String(pid), "-d", String(descriptor), "-Fn"],
    { encoding: "utf8" }
  );
  if (result.status === 1) return undefined;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
}

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function descriptorLockCommand(): Promise<{ readonly executable: string; readonly args: readonly string[] }> {
  if (process.platform === "darwin") {
    return { executable: "/usr/bin/lockf", args: ["-s", "-t", "0", "3"] };
  }
  for (const executable of ["/usr/bin/flock", "/bin/flock"] as const) {
    try {
      await stat(executable);
      return { executable, args: ["-n", "3"] };
    } catch {
      // Try the next fixed operating-system path.
    }
  }
  throw new Error("descriptor lock command is unavailable");
}

async function runDescriptorLockCommand(handle: FileHandle): Promise<number | null> {
  const command = await descriptorLockCommand();
  return spawnSync(command.executable, [...command.args], {
    stdio: ["ignore", "ignore", "pipe", handle.fd]
  }).status;
}

async function waitForProcessDeath(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    if (result.status !== 0 || result.stdout.trim() === "" || result.stdout.trim().startsWith("Z")) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`process ${String(pid)} did not exit within ${String(timeoutMs)}ms`);
}

async function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  stream: "stdout" | "stderr",
  pattern: RegExp,
  timeoutMs = 5_000
): Promise<string> {
  let output = "";
  return new Promise<string>((resolve, reject) => {
    const target = child[stream];
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (pattern.test(output)) finish(() => resolve(output));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => reject(new Error(
        `child exited before ${String(pattern)} (code=${String(code)}, signal=${String(signal)}, output=${output})`
      )));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`timed out waiting for child output ${String(pattern)}: ${output}`)));
    }, timeoutMs);
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      target.off("data", onData);
      child.off("exit", onExit);
      complete();
    };
    target.on("data", onData);
    child.on("exit", onExit);
  });
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return null;
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForChildDecision(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000
): Promise<"acquired" | "blocked"> {
  return new Promise<"acquired" | "blocked">((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (/ACQUIRED/u.test(stdout)) finish(() => resolve("acquired"));
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (/BLOCKED/u.test(stderr)) finish(() => resolve("blocked"));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => reject(new Error(
        `child exited without a lock decision (code=${String(code)}, signal=${String(signal)}, stdout=${stdout}, stderr=${stderr})`
      )));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`timed out waiting for lock decision: stdout=${stdout}, stderr=${stderr}`)));
    }, timeoutMs);
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("close", onClose);
      complete();
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("close", onClose);
  });
}

test("withExclusive serializes inner operations, waits for them, and expires its scoped view", async () => {
  const sessionId = SessionId("exclusive-scope");
  let activeAppends = 0;
  let maximumActiveAppends = 0;
  const session = new DurableAgentSession(testSessionHeader(sessionId), [], {
    commitDurable: async () => {
      activeAppends += 1;
      maximumActiveAppends = Math.max(maximumActiveAppends, activeAppends);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeAppends -= 1;
    },
    flush: async () => {}
  });

  let leakedView: Parameters<Parameters<DurableAgentSession["withExclusive"]>[0]>[0] | undefined;
  const result = await session.withExclusive(async (view) => {
    leakedView = view;
    const created = view.append("session/created", {});
    const turn = view.append("turn/start", { turn: 1 });
    void view.append("step/start", { turn: 1, step: 1 });
    await Promise.all([created, turn]);
    return "complete";
  });

  assert.equal(result, "complete");
  assert.equal(maximumActiveAppends, 1);
  assert.deepEqual(session.events.map((event) => event.seq), [0, 1, 2]);
  assert.doesNotThrow(() => verifyAgentSessionEventChain(session.events));
  const expiredView = leakedView;
  assert.ok(expiredView);
  assert.throws(() => expiredView.append("turn/end", { turn: 1, reason: "completed" }), /expired|exclusive/i);
  assert.throws(() => expiredView.events, /expired|exclusive/i);
});

test("withExclusive drains started work and expires its view when the callback throws synchronously", async () => {
  const session = new DurableAgentSession(testSessionHeader(SessionId("exclusive-sync-throw")), [], {
    commitDurable: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); },
    flush: async () => {}
  });
  let leakedView: Parameters<Parameters<DurableAgentSession["withExclusive"]>[0]>[0] | undefined;

  await assert.rejects(() => session.withExclusive((view: AgentSessionExclusiveView) => {
    leakedView = view;
    void view.append("session/created", {});
    throw new Error("callback failed synchronously");
  }), /callback failed synchronously/i);

  assert.deepEqual(session.events.map((event) => event.type), ["session/created"]);
  const expiredView = leakedView;
  assert.ok(expiredView);
  assert.throws(() => expiredView.events, /expired|exclusive/i);
});

test("withExclusive rejects when unawaited scoped work rejects without an error value", async () => {
  const session = new DurableAgentSession(testSessionHeader(SessionId("exclusive-undefined-rejection")), [], {
    commitDurable: () => Promise.reject(undefined),
    flush: async () => {}
  });

  const [outcome] = await Promise.allSettled([
    session.withExclusive(async (view) => { void view.append("session/created", {}); })
  ]);
  assert.equal(outcome?.status, "rejected");
});

test("stores synchronously snapshot and validate create options with one getter read", async () => {
  const stores = [
    new InMemoryAgentSessionStore(),
    new JsonlAgentSessionStore(await mkdtemp(path.join(os.tmpdir(), "muniu-options-")))
  ];

  for (const [index, store] of stores.entries()) {
    let sessionId = SessionId(`option-session-${index}`);
    let cwd = `/workspace/${index}`;
    let label = `value-${index}`;
    const reads = { sessionId: 0, cwd: 0, labels: 0, label: 0 };
    const labels = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() { reads.label += 1; return label; }
    }) as Record<string, string>;
    const options = {
      get sessionId() { reads.sessionId += 1; return sessionId; },
      get cwd() { reads.cwd += 1; return cwd; },
      get labels() { reads.labels += 1; return labels; }
    };

    const created = store.create(options);
    sessionId = SessionId(`mutated-${index}`);
    cwd = `/mutated/${index}`;
    label = `mutated-${index}`;
    const session = await created;

    assert.equal(session.header.sessionId, SessionId(`option-session-${index}`));
    assert.equal(session.header.protectedCwd?.text, `/workspace/${index}`);
    assert.equal(session.events[0]?.payload.eventType, "session/created");
    assert.match(JSON.stringify(session.events[0]?.payload), new RegExp(`/workspace/${index}`, "u"));
    assert.match(JSON.stringify(session.events[0]?.payload), new RegExp(`value-${index}`, "u"));
    assert.deepEqual(reads, { sessionId: 1, cwd: 1, labels: 1, label: 1 });
    if ("dispose" in store) await store.dispose();
  }

  const invalid = new InMemoryAgentSessionStore();
  let synchronousError: unknown;
  try {
    const pending = invalid.create({ sessionId: SessionId("invalid-options"), cwd: 42 } as never);
    void pending.catch(() => {});
  } catch (error: unknown) {
    synchronousError = error;
  }
  assert.match(String(synchronousError), /cwd.*string|invalid.*cwd/i);
  const retried = await invalid.create({ sessionId: SessionId("invalid-options") });
  assert.deepEqual(retried.events.map((event) => event.type), ["session/created"]);

  const disk = new JsonlAgentSessionStore(await mkdtemp(path.join(os.tmpdir(), "muniu-invalid-session-id-")));
  let unsafeIdError: unknown;
  try {
    const pending = disk.create({ sessionId: SessionId("../escape") });
    void pending.catch(() => {});
  } catch (error: unknown) {
    unsafeIdError = error;
  }
  assert.match(String(unsafeIdError), /session id.*safe/i);
  await disk.dispose();
});

test("session is poisoned after an uncertain persistence failure and never retries", async () => {
  const sessionId = SessionId("poisoned-session");
  let appendAttempts = 0;
  let flushAttempts = 0;
  const session = new DurableAgentSession(testSessionHeader(sessionId), [], {
    commitDurable: async () => {
      appendAttempts += 1;
      throw new Error("write outcome unknown");
    },
    flush: async () => { flushAttempts += 1; }
  });

  const first = session.append("session/created", {});
  const queued = session.append("turn/start", { turn: 1 });
  await assert.rejects(() => first, /write outcome unknown/i);
  await assert.rejects(() => queued, /poisoned|persistence failure/i);
  await assert.rejects(() => session.append("turn/start", { turn: 1 }), /poisoned|persistence failure/i);
  await assert.rejects(() => session.flush(), /poisoned|persistence failure/i);
  assert.equal(appendAttempts, 1);
  assert.equal(flushAttempts, 0);
  assert.equal(session.events.length, 0);
});

test("append snapshots payload synchronously before queued persistence", async () => {
  const session = new DurableAgentSession(testSessionHeader(SessionId("snapshot-session")), [], {
    commitDurable: async () => {},
    flush: async () => {}
  });
  const payload = { turn: 1 };
  const pending = session.append("turn/start", payload);
  payload.turn = 99;
  const event = await pending;
  assert.equal(event.payload.publicControls.turn, 1);
  assert.equal(Object.isFrozen(event.payload), true);
});

test("in-memory store serializes concurrent appends into a verified chain", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("memory-session") });
  await Promise.all(Array.from({ length: 20 }, (_, index) => session.append("turn/start", { turn: index + 1 })));

  assert.deepEqual(session.events.map((event) => event.seq), Array.from({ length: 21 }, (_, index) => index));
  assert.doesNotThrow(() => verifyAgentSessionEventChain(session.events));
  assert.equal(session.events[0]?.type, "session/created");
});

test("JSONL store persists mode 0700/0600 and reopens a verified session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-"));
  await chmod(root, 0o777);
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("disk-session"), cwd: "/tmp/project" });
  const liveHelperPid = findDescendantEventWriter(process.pid);
  await session.append("turn/start", { turn: 1 });
  await session.flush();

  const sessionDir = path.join(root, "sessions", "disk-session");
  assert.equal((await stat(path.join(root, "sessions"))).mode & 0o777, 0o700);
  assert.equal((await stat(sessionDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(sessionDir, "header.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(sessionDir, "events.jsonl"))).mode & 0o777, 0o600);

  await store.dispose();
  await waitForProcessDeath(liveHelperPid);
  const reopenStore = new JsonlAgentSessionStore(root);
  const reopened = await reopenStore.open(SessionId("disk-session"));
  assert.equal(reopened.header.protectedCwd?.text, "/tmp/project");
  assert.deepEqual(reopened.events.map((event) => event.type), ["session/created", "turn/start"]);
  await reopenStore.dispose();
});

test("JSONL persists one authoritative model binding in the header and creation fact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-model-binding-"));
  const sessionId = SessionId("model-binding-session");
  const modelBinding = {
    schemaVersion: 1 as const,
    kind: "agent-model-binding" as const,
    providerId: "mock",
    modelId: "authoritative-mock"
  };
  const store = new JsonlAgentSessionStore(root);
  const created = await store.create({ sessionId, modelBinding });
  assert.deepEqual(created.header.modelBinding, modelBinding);
  assert.deepEqual(
    created.events[0]?.type === "session/created"
      ? created.events[0].payload.publicControls.modelBinding
      : undefined,
    modelBinding
  );
  const headerPath = path.join(root, "sessions", sessionId, "header.json");
  const durableHeader = JSON.parse(await readFile(headerPath, "utf8")) as Record<string, unknown>;
  await store.dispose();

  const reopenedStore = new JsonlAgentSessionStore(root);
  const reopened = await reopenedStore.open(sessionId);
  assert.deepEqual(reopened.header.modelBinding, modelBinding);
  await reopenedStore.dispose();

  await writeFile(headerPath, `${JSON.stringify({
    ...durableHeader,
    modelBinding: { ...modelBinding, modelId: "tampered-model" }
  })}\n`);
  await assert.rejects(
    () => new JsonlAgentSessionStore(root).open(sessionId),
    /model binding.*creation event|creation event.*model binding/iu
  );
});

test("durable sessions reject a header binding that disagrees with the creation fact", () => {
  const sessionId = SessionId("constructor-binding-session");
  const headerBinding = {
    schemaVersion: 1 as const,
    kind: "agent-model-binding" as const,
    providerId: "mock",
    modelId: "header-model"
  };
  const created = createAgentSessionEvent({
    eventId: EventId("constructor-binding-created"),
    sessionId,
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "session/created",
    payload: protectAgentSessionPayloadV1("session/created", {
      modelBinding: { ...headerBinding, modelId: "event-model" }
    })
  });
  assert.throws(() => new DurableAgentSession(
    { ...testSessionHeader(sessionId), modelBinding: headerBinding },
    [created],
    { commitDurable: async () => {}, flush: async () => {} }
  ), /model binding.*creation event|creation event.*model binding/iu);
});

test("JSONL helper serializes concurrent appends and reopens one verified chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-helper-concurrency-"));
  const sessionId = SessionId("helper-concurrency-session");
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId });
  await Promise.all(Array.from(
    { length: 32 },
    (_entry, index) => session.append("turn/start", { turn: index + 1 })
  ));
  await session.flush();
  await store.dispose();

  const reopenedStore = new JsonlAgentSessionStore(root);
  const reopened = await reopenedStore.open(sessionId);
  assert.deepEqual(reopened.events.map((event) => event.seq), Array.from({ length: 33 }, (_entry, index) => index));
  assert.doesNotThrow(() => verifyAgentSessionEventChain(reopened.events));
  await reopenedStore.dispose();
});

test("JSONL load truncates a torn final line but fails closed on middle corruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-tail-"));
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("tail-session") });
  await session.append("turn/start", { turn: 1 });
  const eventsPath = path.join(root, "sessions", "tail-session", "events.jsonl");
  const committed = await readFile(eventsPath);
  await writeFile(eventsPath, Buffer.concat([committed, Buffer.from('{"schemaVersion":1')]));

  await store.dispose();
  const reopenStore = new JsonlAgentSessionStore(root);
  const reopened = await reopenStore.open(SessionId("tail-session"));
  assert.equal(reopened.events.length, 2);
  assert.deepEqual(await readFile(eventsPath), committed);
  await reopenStore.dispose();

  const lines = committed.toString("utf8").trimEnd().split("\n");
  await writeFile(eventsPath, `${lines[0]}\nnot-json\n${lines[1]}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("tail-session")), /corrupt.*line 2/i);
});

test("JSONL load rejects empty logs, a non-creation first event, and header/event id mismatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-binding-"));
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("bound-session") });
  const eventsPath = path.join(root, "sessions", "bound-session", "events.jsonl");
  const headerPath = path.join(root, "sessions", "bound-session", "header.json");
  const originalHeader = JSON.parse(await readFile(headerPath, "utf8")) as Record<string, unknown>;
  const originalEvents = await readFile(eventsPath, "utf8");
  await store.dispose();

  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, unexpected: true })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /invalid session header/i);
  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, createdAt: "2026-08-15" })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /invalid session header/i);
  const tamperedCreatedAt = originalHeader.createdAt === "2000-01-01T00:00:00.000Z"
    ? "2001-01-01T00:00:00.000Z"
    : "2000-01-01T00:00:00.000Z";
  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, createdAt: tamperedCreatedAt })}\n`);
  await assert.rejects(
    () => new JsonlAgentSessionStore(root).open(SessionId("bound-session")),
    /creation time.*creation event/i
  );
  await writeFile(headerPath, `${JSON.stringify({
    ...originalHeader,
    protectedCwd: createProtectedTextV1("/tampered")
  })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /cwd.*creation event/i);
  await writeFile(headerPath, `${JSON.stringify(originalHeader)}\n`);
  await writeFile(eventsPath, originalEvents);

  await writeFile(eventsPath, "");
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /empty event log/i);

  const notCreated = createAgentSessionEvent({
    eventId: EventId("not-created"),
    sessionId: SessionId("bound-session"),
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "turn/start",
    payload: protectAgentSessionPayloadV1("turn/start", { turn: 1 })
  });
  await writeFile(eventsPath, `${JSON.stringify(notCreated)}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /first event.*session\/created/i);

  const mismatched = createAgentSessionEvent({
    eventId: EventId("wrong-session"),
    sessionId: SessionId("another-session"),
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "session/created",
    payload: protectAgentSessionPayloadV1("session/created", {})
  });
  await writeFile(eventsPath, `${JSON.stringify(mismatched)}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /event session id.*header/i);
  assert.equal(session.events.length, 1);
});

test("JSONL stores enforce one canonical in-process writer and coalesce concurrent opens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-lease-"));
  const sessionId = SessionId("leased-session");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  const contender = new JsonlAgentSessionStore(root);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);

  await creator.dispose();
  const reader = new JsonlAgentSessionStore(root);
  const [first, second] = await Promise.all([reader.open(sessionId), reader.open(sessionId)]);
  assert.equal(first, second);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);
  await reader.dispose();
  const transferred = await contender.open(sessionId);
  assert.equal(transferred.header.sessionId, sessionId);
  await contender.dispose();

  const createRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-session-create-"));
  const creating = new JsonlAgentSessionStore(createRoot);
  const results = await Promise.allSettled([
    creating.create({ sessionId: SessionId("concurrent-create") }),
    creating.create({ sessionId: SessionId("concurrent-create") })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await creating.dispose();
});

test("OS writer locks cannot fork when Node processes use different TMPDIR values", async () => {
  assert.match(process.version, /^v22\.19\./u);
  const temporaryA = await mkdtemp(path.join(os.tmpdir(), "muniu-lock-root-a-"));
  const temporaryB = await mkdtemp(path.join(os.tmpdir(), "muniu-lock-root-b-"));
  const identity = `tmpdir-independent:${crypto.randomUUID()}`;
  const environmentFor = (temporary: string): NodeJS.ProcessEnv => ({
    ...CHILD_PROCESS_ENV,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary
  });
  const holder = spawnWriterLockProcess(identity, environmentFor(temporaryA));
  let contender: ChildProcessWithoutNullStreams | undefined;
  try {
    await waitForChildOutput(holder, "stdout", /ACQUIRED/u);
    contender = spawnWriterLockProcess(identity, environmentFor(temporaryB));
    assert.equal(await waitForChildDecision(contender), "blocked");
  } finally {
    holder.stdin.end("release\n");
    contender?.stdin.end("release\n");
    await Promise.allSettled([
      waitForChildExit(holder),
      ...(contender === undefined ? [] : [waitForChildExit(contender)])
    ]);
    holder.kill("SIGKILL");
    contender?.kill("SIGKILL");
  }
});

test("a descriptor lock survives its short acquisition command and releases only when the retained fd closes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-fd-lock-semantics-"));
  const lockPath = path.join(root, "writer.lock");
  const retained = await open(lockPath, "w+", 0o600);
  const contender = await open(lockPath, "r+");
  try {
    assert.equal(await runDescriptorLockCommand(retained), 0);
    assert.notEqual(await runDescriptorLockCommand(contender), 0);
    await retained.close();
    assert.equal(await runDescriptorLockCommand(contender), 0);
  } finally {
    await Promise.allSettled([retained.close(), contender.close()]);
  }
});

test("descriptor lock timeout waits one close observation and preserves the primary timeout", async () => {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    "setInterval(() => {}, 1000)"
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const startedAt = Date.now();
  await assert.rejects(
    () => settleDescriptorLockCommand(child, 10),
    (error: unknown) => {
      assert.match(String(error), /timed out/i);
      assert.equal(error instanceof AggregateError, false);
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("the Node event writer itself owns both the event fd and the inode lock fd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-writer-identity-"));
  const sessionId = SessionId("writer-identity-session");
  const store = new JsonlAgentSessionStore(root);
  try {
    await store.create({ sessionId });
    const eventPath = path.join(root, "sessions", sessionId, "events.jsonl");
    const eventStat = await stat(eventPath);
    const inodeDigest = createHash("sha256")
      .update(`inode:${String(eventStat.dev)}:${String(eventStat.ino)}`)
      .digest("hex");
    const lockPath = path.join(fixedWriterLockRoot(process.getuid?.()), `${inodeDigest}.lock`);
    const writerPid = findDescendantEventWriter(process.pid);

    assert.deepEqual(await pidsWithOpenFile(lockPath), [writerPid]);
    assert.equal(await descriptorTarget(writerPid, 3), await realpath(eventPath));
    assert.equal(await descriptorTarget(writerPid, 4), await realpath(lockPath));
  } finally {
    await store.dispose();
  }
});

test("losing an inode helper cannot let an alias and its former parent fork the event chain", { timeout: 20_000 }, async () => {
  assert.match(process.version, /^v22\.19\./u);
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-helper-loss-"));
  const aliasRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-session-helper-loss-alias-"));
  const sessionId = SessionId("helper-loss-session");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  await creator.dispose();

  const sourceDirectory = path.join(root, "sessions", sessionId);
  const aliasDirectory = path.join(aliasRoot, "sessions", sessionId);
  await mkdir(aliasDirectory, { recursive: true });
  await link(path.join(sourceDirectory, "header.json"), path.join(aliasDirectory, "header.json"));
  await link(path.join(sourceDirectory, "events.jsonl"), path.join(aliasDirectory, "events.jsonl"));
  const eventStat = await stat(path.join(sourceDirectory, "events.jsonl"));
  const inodeIdentity = `inode:${String(eventStat.dev)}:${String(eventStat.ino)}`;
  const inodeDigest = createHash("sha256").update(inodeIdentity).digest("hex");
  const inodeLockPath = path.join(fixedWriterLockRoot(process.getuid?.()), `${inodeDigest}.lock`);

  const original = spawnGatedAppendProcess(root, sessionId);
  let alias: ChildProcessWithoutNullStreams | undefined;
  let writerPid: number | undefined;
  let writerWasLockHolder = false;
  let originalStdout = "";
  let originalStderr = "";
  original.stdout.on("data", (chunk: Buffer) => { originalStdout += chunk.toString("utf8"); });
  original.stderr.on("data", (chunk: Buffer) => { originalStderr += chunk.toString("utf8"); });
  const waitForOriginal = async (pattern: RegExp): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!pattern.test(originalStdout) && Date.now() < deadline) {
      if (original.exitCode !== null || original.signalCode !== null) {
        throw new Error(`original writer exited early: ${originalStdout} ${originalStderr}`);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.match(originalStdout, pattern);
  };

  try {
    await waitForOriginal(/BEFORE_APPEND/u);
    assert.ok(original.pid !== undefined);
    writerPid = findDescendantEventWriter(original.pid);
    const lockHolders = await pidsWithOpenFile(inodeLockPath);
    assert.equal(lockHolders.length, 1);
    const lockHolderPid = lockHolders[0] as number;
    writerWasLockHolder = lockHolderPid === writerPid;

    process.kill(writerPid, "SIGSTOP");
    const stoppedContender = spawnAppendOnceProcess(aliasRoot, sessionId);
    assert.match(await waitForChildOutput(stoppedContender, "stderr", /BLOCKED/u), /BLOCKED/u);
    assert.equal(await waitForChildExit(stoppedContender), 23);
    original.stdin.write("release-append\n");
    await waitForOriginal(/REQUEST_DISPATCHED/u);
    process.kill(original.pid, "SIGSTOP");
    process.kill(lockHolderPid, "SIGKILL");
    await waitForProcessDeath(lockHolderPid);

    alias = spawnAppendOnceProcess(aliasRoot, sessionId);
    const aliasOutput = await waitForChildOutput(alias, "stdout", /APPENDED/u);
    assert.match(aliasOutput, /APPENDED/u);
    assert.equal(await waitForChildExit(alias), 0);

    if (!writerWasLockHolder) {
      signalIfAlive(writerPid, "SIGCONT");
      const oldWriterDeadline = Date.now() + 2_000;
      while (Date.now() < oldWriterDeadline) {
        const rowCount = (await readFile(path.join(sourceDirectory, "events.jsonl"), "utf8")).trimEnd().split("\n").length;
        if (rowCount > 2) break;
        try {
          process.kill(writerPid, 0);
        } catch {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    signalIfAlive(original.pid, "SIGCONT");
    await waitForOriginal(/APPEND_(?:OK|FAILED)/u);
    original.stdin.end("exit\n");
    await waitForChildExit(original);

    const rows = (await readFile(path.join(sourceDirectory, "events.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((event) => event.seq), [0, 1]);
    assert.doesNotThrow(() => verifyAgentSessionEventChain(rows));

    const reopenedStore = new JsonlAgentSessionStore(root);
    const reopened = await reopenedStore.open(sessionId);
    assert.deepEqual(reopened.events.map((event) => event.seq), [0, 1]);
    await reopenedStore.dispose();
  } finally {
    if (writerPid !== undefined && !writerWasLockHolder) signalIfAlive(writerPid, "SIGCONT");
    if (original.pid !== undefined) signalIfAlive(original.pid, "SIGCONT");
    original.kill("SIGKILL");
    alias?.kill("SIGKILL");
  }
});

test("JSONL OS leases admit only one Node 22 writer across path and event-inode aliases and recover after crash", async () => {
  assert.match(process.version, /^v22\.19\./u);
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-process-lease-"));
  const sessionId = SessionId("process-leased-session");
  const children = new Set<ChildProcessWithoutNullStreams>();
  const launch = (childRoot: string, command: "hold" | "try") => {
    const child = spawnStoreProcess(childRoot, sessionId, command);
    children.add(child);
    child.once("exit", () => children.delete(child));
    return child;
  };
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  await creator.dispose();

  try {
    const holder = launch(root, "hold");
    await waitForChildOutput(holder, "stdout", /ACQUIRED/u);
    const ownerUid = process.getuid?.();
    assert.equal(typeof ownerUid, "number");
    const lockRoot = fixedWriterLockRoot(ownerUid);
    const lockRootStat = await stat(lockRoot);
    assert.equal(lockRootStat.mode & 0o777, 0o700);
    assert.equal(lockRootStat.uid, ownerUid);
    const sessionDirectory = path.join(root, "sessions", sessionId);
    const canonicalSessionDirectory = await realpath(sessionDirectory);
    const eventStat = await stat(path.join(sessionDirectory, "events.jsonl"));
    const identities = [
      `path:${canonicalSessionDirectory}`,
      `inode:${String(eventStat.dev)}:${String(eventStat.ino)}`
    ];
    for (const identity of identities) {
      const digest = createHash("sha256").update(identity).digest("hex");
      const lockStat = await stat(path.join(lockRoot, `${digest}.lock`));
      assert.equal(lockStat.mode & 0o777, 0o600);
      assert.equal(lockStat.uid, ownerUid);
      assert.equal(lockStat.nlink, 1);
      assert.equal(lockStat.isFile(), true);
    }

    const pathContender = launch(root, "try");
    const pathContenderExit = waitForChildExit(pathContender);
    const pathBlocked = await waitForChildOutput(pathContender, "stderr", /BLOCKED/u);
    assert.match(pathBlocked, /lease|writer/i);
    assert.equal(await pathContenderExit, 23);

    const holderExit = waitForChildExit(holder);
    holder.kill("SIGKILL");
    assert.equal(await holderExit, null);

    const recovered = launch(root, "try");
    const recoveredExit = waitForChildExit(recovered);
    assert.match(await waitForChildOutput(recovered, "stdout", /ACQUIRED/u), /ACQUIRED/u);
    assert.equal(await recoveredExit, 0);

    const aliasRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-session-process-alias-"));
    const aliasDirectory = path.join(aliasRoot, "sessions", sessionId);
    const sourceDirectory = path.join(root, "sessions", sessionId);
    await mkdir(aliasDirectory, { recursive: true });
    await link(path.join(sourceDirectory, "header.json"), path.join(aliasDirectory, "header.json"));
    await link(path.join(sourceDirectory, "events.jsonl"), path.join(aliasDirectory, "events.jsonl"));

    const inodeHolder = launch(root, "hold");
    await waitForChildOutput(inodeHolder, "stdout", /ACQUIRED/u);
    const inodeContender = launch(aliasRoot, "try");
    const inodeContenderExit = waitForChildExit(inodeContender);
    const inodeBlocked = await waitForChildOutput(inodeContender, "stderr", /BLOCKED/u);
    assert.match(inodeBlocked, /alias|lease|writer/i);
    assert.equal(await inodeContenderExit, 23);

    const inodeHolderExit = waitForChildExit(inodeHolder);
    inodeHolder.stdin.end("release\n");
    assert.equal(await inodeHolderExit, 0);
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
});

test("JSONL OS writer lease never admits two holders under repeated crash contention", { timeout: 120_000 }, async () => {
  assert.match(process.version, /^v22\.19\./u);
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-lock-stress-"));
  const identity = `stress:${root}`;

  const seed = spawnWriterLockProcess(identity);
  await waitForChildOutput(seed, "stdout", /ACQUIRED/u);
  const seedExit = waitForChildExit(seed);
  seed.kill("SIGKILL");
  assert.equal(await seedExit, null);

  let maximumAcquired = 0;
  const rounds = process.env.NODE_V8_COVERAGE === undefined ? 20 : 1;
  for (let round = 0; round < rounds; round += 1) {
    const contenders = Array.from({ length: 16 }, () => spawnWriterLockProcess(identity));
    try {
      const decisions = await Promise.all(contenders.map((child) => waitForChildDecision(child, 10_000)));
      const acquired = decisions.filter((decision) => decision === "acquired").length;
      maximumAcquired = Math.max(maximumAcquired, acquired);
      assert.ok(acquired <= 1, `round ${round} admitted ${acquired} concurrent writer leases`);
    } finally {
      const exits = contenders.map((child) => {
        const exit = waitForChildExit(child, 10_000);
        child.kill("SIGKILL");
        return exit;
      });
      await Promise.all(exits);
    }
  }

  assert.equal(maximumAcquired, 1);
});

test("descriptor lock commands are fixed, fail closed when missing, and release only by closing their lease", async () => {
  const checked: string[] = [];
  await assert.rejects(
    () => resolveWriterLockHelper("darwin", async (filePath) => {
      checked.push(filePath);
      return false;
    }),
    /helper.*unavailable/i
  );
  assert.equal(checked.length, 2);
  for (const candidate of checked) {
    assert.match(candidate, /native\/\.build\/mn-descriptor-lock$/u);
  }

  const darwinChecked: string[] = [];
  const darwin = await resolveWriterLockHelper("darwin", async (filePath) => {
    darwinChecked.push(filePath);
    return true;
  });
  assert.deepEqual(darwinChecked, [darwin.executable]);
  assert.match(darwin.executable, /native\/\.build\/mn-descriptor-lock$/u);
  assert.deepEqual(darwin.argumentsFor(4), ["4"]);
  const packagedDarwinChecks: string[] = [];
  const packagedDarwin = await resolveWriterLockHelper(
    "darwin",
    async (filePath) => {
      packagedDarwinChecks.push(filePath);
      return filePath.includes("/Resources/");
    },
    {
      packaged: true,
      processExecutable: "/Applications/Muniu.app/Contents/MacOS/mn-api-aarch64-apple-darwin",
      architecture: "arm64"
    }
  );
  assert.deepEqual(packagedDarwinChecks, [
    "/Applications/Muniu.app/Contents/MacOS/mn-descriptor-lock-aarch64-apple-darwin",
    "/Applications/Muniu.app/Contents/Resources/mn-descriptor-lock-aarch64-apple-darwin"
  ]);
  assert.equal(
    packagedDarwin.executable,
    "/Applications/Muniu.app/Contents/Resources/mn-descriptor-lock-aarch64-apple-darwin"
  );
  assert.deepEqual(packagedDarwin.argumentsFor(4), ["4"]);
  const linux = await resolveWriterLockHelper("linux", async (filePath) => {
    return filePath === "/usr/bin/flock";
  });
  assert.equal(linux.executable, "/usr/bin/flock");
  assert.deepEqual(linux.argumentsFor(4), ["-n", "4"]);

  const helper = await resolveWriterLockHelper(process.platform);
  assert.ok(
    helper.executable.endsWith("mn-descriptor-lock")
      || ["/usr/bin/flock", "/bin/flock"].includes(helper.executable)
  );
  assert.equal(helper.argumentsFor(3).at(-1), "3");

  const identity = `descriptor-release:${await mkdtemp(path.join(os.tmpdir(), "muniu-lock-release-"))}`;
  const held = await acquireOsWriterLock(identity);
  const identityDigest = createHash("sha256").update(identity).digest("hex");
  const identityLockPath = path.join(fixedWriterLockRoot(process.getuid?.()), `${identityDigest}.lock`);
  assert.deepEqual(await pidsWithOpenFile(identityLockPath), [process.pid]);
  await assert.rejects(() => acquireOsWriterLock(identity), /held|unavailable|writer/i);
  await held.release();
  const recovered = await acquireOsWriterLock(identity);
  await recovered.release();

  const ownerUid = process.getuid?.();
  assert.equal(typeof ownerUid, "number");
  const lockRoot = fixedWriterLockRoot(ownerUid);
  const unsafeIdentity = `unsafe-file:${await mkdtemp(path.join(os.tmpdir(), "muniu-lock-unsafe-"))}`;
  const unsafeDigest = createHash("sha256").update(unsafeIdentity).digest("hex");
  const unsafePath = path.join(lockRoot, `${unsafeDigest}.lock`);
  await symlink("/dev/null", unsafePath, "file");
  try {
    await assert.rejects(() => acquireOsWriterLock(unsafeIdentity), /safely|unsafe|symbolic|symlink/i);
  } finally {
    await unlink(unsafePath);
  }
  await writeFile(unsafePath, "", { mode: 0o644 });
  await chmod(unsafePath, 0o644);
  try {
    await assert.rejects(() => acquireOsWriterLock(unsafeIdentity), /permissions|unsafe/i);
  } finally {
    await unlink(unsafePath);
  }
});

test("packaged event writers re-enter the sidecar while source runs use the compiled helper", () => {
  const packaged = resolveEventWriterHelperCommand(
    true,
    "/Applications/Muniu.app/Contents/MacOS/mn-api"
  );
  assert.equal(packaged.executable, "/Applications/Muniu.app/Contents/MacOS/mn-api");
  assert.equal(packaged.staticHelperPath, undefined);
  assert.deepEqual(packaged.argumentsFor("nonce"), [
    "--mn-agent-session-event-writer",
    "3",
    "4",
    "nonce"
  ]);

  const source = resolveEventWriterHelperCommand(
    false,
    "/usr/local/bin/node",
    "file:///workspace/packages/agent-session/dist/writer-lock.js"
  );
  assert.equal(source.executable, "/usr/local/bin/node");
  assert.equal(
    source.staticHelperPath,
    "/workspace/packages/agent-session/dist/event-writer-helper.js"
  );
  assert.deepEqual(source.argumentsFor("nonce"), [
    "/workspace/packages/agent-session/dist/event-writer-helper.js",
    "3",
    "4",
    "nonce"
  ]);
});

test("JSONL fails closed when the compiled event writer helper is missing and recovers after restore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-missing-writer-helper-"));
  const sessionId = SessionId("missing-writer-helper-session");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  await creator.dispose();

  const helperPath = fileURLToPath(new URL("../src/event-writer-helper.js", import.meta.url));
  const hiddenPath = `${helperPath}.missing`;
  await rename(helperPath, hiddenPath);
  try {
    const unavailable = new JsonlAgentSessionStore(root);
    await assert.rejects(() => unavailable.open(sessionId), /compiled event writer helper.*unavailable/i);
    await unavailable.dispose();
  } finally {
    await rename(hiddenPath, helperPath);
  }

  const restored = new JsonlAgentSessionStore(root);
  const reopened = await restored.open(sessionId);
  assert.deepEqual(reopened.events.map((event) => event.type), ["session/created"]);
  await restored.dispose();
});

test("compiled event writer helper rejects non-string operation values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-writer-protocol-"));
  const eventHandle = await open(path.join(root, "events.jsonl"), "w+");
  const lockHandle = await open(path.join(root, "writer.lock"), "w+");
  const helperPath = fileURLToPath(new URL("../src/event-writer-helper.js", import.meta.url));
  const nonce = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const helper = spawn(process.execPath, [helperPath, "3", "4", nonce], {
    env: CHILD_PROCESS_ENV,
    stdio: ["pipe", "pipe", "pipe", eventHandle.fd, lockHandle.fd]
  }) as unknown as ChildProcessWithoutNullStreams;
  try {
    await waitForChildOutput(helper, "stdout", /"status":"ready"/u);
    helper.stdin.write(`${JSON.stringify({ nonce, requestId, operation: ["append"] })}\n`);
    assert.notEqual(await waitForChildExit(helper), 0);
    assert.equal(await readFile(path.join(root, "events.jsonl"), "utf8"), "");
  } finally {
    helper.kill("SIGKILL");
    await Promise.allSettled([eventHandle.close(), lockHandle.close()]);
  }
});

test("JSONL dispose holds its lease until an active durable append settles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-dispose-"));
  let enterAppend!: () => void;
  const appendEntered = new Promise<void>((resolve) => { enterAppend = resolve; });
  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const sessionId = SessionId("dispose-race");
  const store = new JsonlAgentSessionStore(root, {
    beforeAppend: async (event) => {
      if (event.type !== "turn/start") return;
      enterAppend();
      await appendGate;
    }
  });
  const session = await store.create({ sessionId });
  const append = session.append("turn/start", { turn: 1 });
  await appendEntered;
  let disposeSettled = false;
  const disposing = store.dispose().then(() => { disposeSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposeSettled, false);

  const contender = new JsonlAgentSessionStore(root);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);
  releaseAppend();
  await append;
  await disposing;
  assert.equal(disposeSettled, true);
  const transferred = await contender.open(sessionId);
  assert.deepEqual(transferred.events.map((event) => event.type), ["session/created", "turn/start"]);
  await contender.dispose();
});

test("JSONL rejects FIFO headers and event logs without blocking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-fifo-"));
  const sessionId = SessionId("fifo-session");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  await creator.dispose();

  const sessionDirectory = path.join(root, "sessions", sessionId);
  for (const fileName of ["header.json", "events.jsonl"]) {
    const filePath = path.join(sessionDirectory, fileName);
    const backupPath = `${filePath}.regular`;
    await rename(filePath, backupPath);
    const fifo = spawnSync("/usr/bin/mkfifo", [filePath], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
    const child = spawnStoreProcess(root, sessionId, "try");
    try {
      const output = await waitForChildOutput(child, "stderr", /BLOCKED/u, 2_000);
      assert.match(output, /regular file|corrupt|FIFO/i);
      assert.equal(await waitForChildExit(child, 2_000), 23);
    } finally {
      child.kill("SIGKILL");
      await unlink(filePath).catch(() => {});
      await rename(backupPath, filePath);
    }
  }
});

test("JSONL rejects reentrant dispose from an I/O hook without misclassifying external disposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-reentrant-dispose-"));
  const sessionId = SessionId("reentrant-dispose");
  let store!: JsonlAgentSessionStore;
  let reentrantRejected = false;
  store = new JsonlAgentSessionStore(root, {
    beforeAppend: async (event) => {
      if (event.type !== "turn/start") return;
      await assert.rejects(() => store.dispose(), /reentrant|I\/O hook/i);
      reentrantRejected = true;
    }
  });
  const session = await store.create({ sessionId });
  await session.append("turn/start", { turn: 1 });
  assert.equal(reentrantRejected, true);

  const externalDispose = store.dispose();
  await externalDispose;
  const successor = new JsonlAgentSessionStore(root);
  const reopened = await successor.open(sessionId);
  assert.deepEqual(reopened.events.map((event) => event.type), ["session/created", "turn/start"]);
  await successor.dispose();
});

test("JSONL initial create hooks reject reentrant dispose without self-waiting", { timeout: 10_000 }, async () => {
  for (const target of ["beforeAppend", "renamed", "committed"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `muniu-session-initial-hook-${target}-`));
    const sessionId = SessionId(`initial-hook-${target}`);
    let store!: JsonlAgentSessionStore;
    let rejected = false;
    const rejectReentrantDispose = async () => {
      await assert.rejects(
        () => Promise.race([
          store.dispose(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("reentrant dispose timed out")), 250);
          })
        ]),
        /reentrant|I\/O hook/i
      );
      rejected = true;
    };
    store = new JsonlAgentSessionStore(root, {
      beforeAppend: async (event) => {
        if (target === "beforeAppend" && event.type === "session/created") {
          await rejectReentrantDispose();
        }
      },
      afterPublish: async (phase) => {
        if (target === phase) await rejectReentrantDispose();
      }
    });

    try {
      const session = await store.create({ sessionId });
      assert.equal(session.header.sessionId, sessionId);
      assert.equal(rejected, true);
    } finally {
      await store.dispose();
    }
  }
});

test("JSONL create publishes a complete session atomically and can retry after the first append fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-atomic-"));
  const sessionId = SessionId("atomic-session");
  let attempts = 0;
  const store = new JsonlAgentSessionStore(root, {
    beforeAppend: (event) => {
      if (event.type === "session/created" && attempts++ === 0) throw new Error("injected initial append failure");
    }
  });
  try {
    await assert.rejects(() => store.create({ sessionId }), /injected initial append failure/i);
    await assert.rejects(() => stat(path.join(root, "sessions", sessionId)), /ENOENT/);
    assert.deepEqual(await readdir(path.join(root, "sessions")), []);

    const session = await store.create({ sessionId });
    assert.deepEqual(session.events.map((event) => event.type), ["session/created"]);
    assert.equal(session.header.createdAt, session.events[0]?.occurredAt);
  } finally {
    await store.dispose();
  }
});

test("JSONL clears only same-session staging left by a crashed creator after taking the OS lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-stale-staging-"));
  const sessionId = SessionId("stale-staging-session");
  const crashed = spawnStoreProcess(root, sessionId, "create-hold");
  try {
    await waitForChildOutput(crashed, "stdout", /STAGED/u);
    const stagedBeforeCrash = await readdir(path.join(root, "sessions"));
    assert.equal(stagedBeforeCrash.filter((name) => name.startsWith(`.${sessionId}.create-`)).length, 1);
    const crashedExit = waitForChildExit(crashed);
    crashed.kill("SIGKILL");
    assert.equal(await crashedExit, null);

    const retry = new JsonlAgentSessionStore(root);
    const session = await retry.create({ sessionId });
    assert.equal(session.header.sessionId, sessionId);
    assert.deepEqual(await readdir(path.join(root, "sessions")), [sessionId]);
    await retry.dispose();
  } finally {
    crashed.kill("SIGKILL");
  }
});

test("JSONL create preserves the primary failure, aggregates cleanup failures, and releases every lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-create-cleanup-"));
  const sessionsRoot = path.join(root, "sessions");
  const sessionId = SessionId("cleanup-session");
  let injectFailure = true;
  const store = new JsonlAgentSessionStore(root, {
    beforeAppend: async (event) => {
      if (event.type !== "session/created" || !injectFailure) return;
      injectFailure = false;
      await chmod(sessionsRoot, 0o500);
      throw new Error("primary create failure");
    }
  });

  let failure: unknown;
  try {
    await store.create({ sessionId });
  } catch (error: unknown) {
    failure = error;
  } finally {
    await chmod(sessionsRoot, 0o700);
  }

  try {
    assert.ok(failure instanceof AggregateError);
    assert.match(String(failure.errors[0]), /primary create failure/i);
    assert.ok(failure.errors.slice(1).some((error) => /permission|EACCES|operation not permitted/i.test(String(error))));
    const retried = await store.create({ sessionId });
    assert.equal(retried.header.sessionId, sessionId);
  } finally {
    await store.dispose();
  }
});

test("JSONL classifies post-rename failures and idempotently reopens only an identical creation snapshot", async () => {
  for (const phase of ["renamed", "committed"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `muniu-session-${phase}-failure-`));
    const sessionId = SessionId(`${phase}-session`);
    let injected = false;
    const store = new JsonlAgentSessionStore(root, {
      afterPublish: (currentPhase: string) => {
        if (currentPhase === phase && !injected) {
          injected = true;
          throw new Error(`injected ${phase} failure`);
        }
      }
    } as never);

    try {
      await assert.rejects(
        () => store.create({ sessionId, cwd: "/workspace", labels: { purpose: "retry" } }),
        (error: unknown) => {
          const outcome = (error as { outcome?: unknown }).outcome;
          assert.equal(outcome, phase === "renamed" ? "uncertain" : "committed");
          assert.match(String(error), new RegExp(`injected ${phase} failure`, "iu"));
          return true;
        }
      );
      const retried = await store.create({ sessionId, cwd: "/workspace", labels: { purpose: "retry" } });
      assert.equal(retried.header.protectedCwd?.text, "/workspace");
      await store.dispose();

      const incompatible = new JsonlAgentSessionStore(root);
      await assert.rejects(
        () => incompatible.create({ sessionId, cwd: "/different", labels: { purpose: "retry" } }),
        /different|conflict|creation snapshot|already exists/i
      );
      await incompatible.dispose();
    } finally {
      await store.dispose();
    }
  }
});

test("JSONL dispose during the post-rename window waits and leaves an idempotently recoverable session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-dispose-published-"));
  const sessionId = SessionId("dispose-published-session");
  let enteredPublish!: () => void;
  const publishEntered = new Promise<void>((resolve) => { enteredPublish = resolve; });
  let releasePublish!: () => void;
  const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
  const store = new JsonlAgentSessionStore(root, {
    afterPublish: async (phase: string) => {
      if (phase !== "renamed") return;
      enteredPublish();
      await publishGate;
    }
  } as never);
  const creating = store.create({ sessionId, cwd: "/workspace" });
  await publishEntered;
  let disposeSettled = false;
  const disposing = store.dispose().then(() => { disposeSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposeSettled, false);
  releasePublish();
  await assert.rejects(
    () => creating,
    (error: unknown) => {
      assert.equal((error as { outcome?: unknown }).outcome, "uncertain");
      return true;
    }
  );
  await disposing;

  const retry = new JsonlAgentSessionStore(root);
  const recovered = await retry.create({ sessionId, cwd: "/workspace" });
  assert.equal(recovered.header.sessionId, sessionId);
  await retry.dispose();
});

test("JSONL open rejects symlinked session paths and files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-symlink-"));
  const sessionId = SessionId("linked-session");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  await creator.dispose();
  const sessionDir = path.join(root, "sessions", sessionId);
  const realDir = `${sessionDir}.real`;

  await rename(sessionDir, realDir);
  await symlink(realDir, sessionDir, "dir");
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(sessionId), /symbolic link|symlink/i);
  await unlink(sessionDir);
  await rename(realDir, sessionDir);

  for (const fileName of ["header.json", "events.jsonl"]) {
    const filePath = path.join(sessionDir, fileName);
    const realFile = `${filePath}.real`;
    await rename(filePath, realFile);
    await symlink(realFile, filePath, "file");
    const contender = new JsonlAgentSessionStore(root);
    await assert.rejects(() => contender.open(sessionId), /symbolic link|symlink|too many levels/i);
    await contender.dispose();
    await unlink(filePath);
    await rename(realFile, filePath);
  }
});

test("JSONL writer leases converge across symlink roots and hard-linked event aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-alias-"));
  const sessionId = SessionId("alias-session");
  const owner = new JsonlAgentSessionStore(root);
  await owner.create({ sessionId });

  const symlinkRoot = `${root}-symlink`;
  await symlink(root, symlinkRoot, "dir");
  const symlinkContender = new JsonlAgentSessionStore(symlinkRoot);
  await assert.rejects(() => symlinkContender.open(sessionId), /lease|writer/i);
  await symlinkContender.dispose();

  const hardlinkRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-session-hardlink-"));
  const hardlinkDir = path.join(hardlinkRoot, "sessions", sessionId);
  await mkdir(hardlinkDir, { recursive: true });
  const ownerDir = path.join(root, "sessions", sessionId);
  await link(path.join(ownerDir, "header.json"), path.join(hardlinkDir, "header.json"));
  await link(path.join(ownerDir, "events.jsonl"), path.join(hardlinkDir, "events.jsonl"));
  const hardlinkContender = new JsonlAgentSessionStore(hardlinkRoot);
  await assert.rejects(() => hardlinkContender.open(sessionId), /lease|writer|alias/i);
  await hardlinkContender.dispose();
  await owner.dispose();
});

test("JSONL append remains bound to its leased event descriptor if the pathname is replaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-replaced-"));
  const sessionId = SessionId("replaced-events");
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId });
  const eventsPath = path.join(root, "sessions", sessionId, "events.jsonl");
  const leasedEventsPath = `${eventsPath}.leased`;
  await rename(eventsPath, leasedEventsPath);
  await writeFile(eventsPath, "", { mode: 0o600 });

  await session.append("turn/start", { turn: 1 });
  assert.equal(await readFile(eventsPath, "utf8"), "");
  assert.match(await readFile(leasedEventsPath, "utf8"), /"type":"turn\/start"/u);
  assert.deepEqual(session.events.map((event) => event.type), ["session/created", "turn/start"]);
  await store.dispose();
});

test("JSONL append cannot be redirected when the validated session directory is replaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-replaced-directory-"));
  const sessionId = SessionId("replaced-directory");
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId });
  const sessionDirectory = path.join(root, "sessions", sessionId);
  const leasedDirectory = `${sessionDirectory}.leased`;
  await rename(sessionDirectory, leasedDirectory);
  await mkdir(sessionDirectory, { mode: 0o700 });
  const replacementEvents = path.join(sessionDirectory, "events.jsonl");
  await writeFile(replacementEvents, "", { mode: 0o600 });

  await session.append("turn/start", { turn: 1 });
  assert.equal(await readFile(replacementEvents, "utf8"), "");
  assert.match(await readFile(path.join(leasedDirectory, "events.jsonl"), "utf8"), /"type":"turn\/start"/u);
  await store.dispose();
});

test("recovery closes started and unstarted tool effects without replaying either", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("recover-session") });
  const user = createUserMessage({
    id: MessageId("user-1"),
    content: [{ type: "text", text: "run tools" }],
    source: { kind: "user" }
  });
  const started = CallId("call-started");
  const unstarted = CallId("call-unstarted");
  const assistant = createAssistantMessage({
    id: MessageId("assistant-1"),
    content: [
      { type: "tool-call", id: started, name: "write", arguments: "{}" },
      { type: "tool-call", id: unstarted, name: "read", arguments: "{}" }
    ],
    source: { kind: "model", provider: "mock", model: "scripted" }
  });
  const runId = RunId("recovery-run");
  const turnCandidateId = CandidateId("recovery-turn-candidate");
  const assistantCandidateId = CandidateId("recovery-assistant-candidate");
  const binder = createRuntimeEffectCommitmentBinderV1({
    governanceDigest: Digest("a".repeat(64)),
    harnessDigest: Digest("b".repeat(64))
  });
  const startedArguments = "{}";
  const startedHandle = binder.bind({
    effectKind: deriveToolEffectKindV1("write"),
    sessionId: session.header.sessionId,
    runId,
    candidateId: assistantCandidateId,
    turn: 1,
    step: 1,
    internalEffectId: started,
    protectedInput: createProtectedTextV1(startedArguments),
    raw: { kind: "text", value: startedArguments }
  });
  const unstartedHandle = binder.bind({
    effectKind: deriveToolEffectKindV1("read"),
    sessionId: session.header.sessionId,
    runId,
    candidateId: assistantCandidateId,
    turn: 1,
    step: 1,
    internalEffectId: unstarted,
    protectedInput: createProtectedTextV1("{}"),
    raw: { kind: "text", value: "{}" }
  });
  await session.append("turn/start", { turn: 1 }, { runId, candidateId: turnCandidateId });
  await session.append("user/message", { turn: 1, message: user });
  await session.append("step/start", { turn: 1, step: 1 });
  await session.append(
    "assistant/message",
    { turn: 1, step: 1, message: assistant },
    { runId, candidateId: assistantCandidateId }
  );
  const startedBinding = {
    schemaVersion: 1 as const,
    approvalId: "recovery-approval-started",
    scope: startedHandle.commitment.effectKind,
    risk: "side-effecting" as const,
    callId: started,
    name: "write",
    commitment: startedHandle.commitment
  };
  const startedRequest = await session.append(
    "approval/requested",
    { binding: startedBinding },
    { runId, candidateId: assistantCandidateId }
  );
  await session.append(
    "approval/resolved",
    {
      binding: startedBinding,
      requestEventId: startedRequest.eventId,
      requestDigest: startedRequest.digest,
      decision: "approve_once",
      resolution: "decided"
    },
    { runId, candidateId: assistantCandidateId }
  );
  await session.append(
    "tool/call",
    {
      turn: 1,
      step: 1,
      callId: started,
      name: "write",
      arguments: startedArguments,
      commitment: startedHandle.commitment
    },
    { runId, candidateId: assistantCandidateId }
  );
  const unstartedBinding = {
    schemaVersion: 1 as const,
    approvalId: "recovery-approval-unstarted",
    scope: unstartedHandle.commitment.effectKind,
    risk: "read-only" as const,
    callId: unstarted,
    name: "read",
    commitment: unstartedHandle.commitment
  };
  const unstartedRequest = await session.append(
    "approval/requested",
    { binding: unstartedBinding },
    { runId, candidateId: assistantCandidateId }
  );
  binder.dispose();

  const waitingProjection = projectSession(session.events);
  assert.equal(waitingProjection.status, "waiting-approval");
  assert.deepEqual(waitingProjection.pendingApprovals.map((approval) => ({
    approvalId: approval.binding.approvalId,
    state: approval.state,
    requestEventId: approval.requestEventId,
    requestDigest: approval.requestDigest
  })), [{
    approvalId: "recovery-approval-unstarted",
    state: "requested",
    requestEventId: unstartedRequest.eventId,
    requestDigest: unstartedRequest.digest
  }]);

  const firstRecovery = recoverInterruptedSession(session);
  const concurrentRecovery = recoverInterruptedSession(session);
  const [recovered, duplicate] = await Promise.all([firstRecovery, concurrentRecovery]);
  assert.deepEqual(duplicate, []);
  assert.deepEqual(
    recovered.filter((event) => event.type === "tool/result").map((event) => event.type === "tool/result"
      ? event.payload.publicControls.error?.code
      : undefined),
    [TOOL_OUTCOME_UNKNOWN, TOOL_NOT_STARTED]
  );
  const interruptedApproval = recovered.find((event) => event.type === "approval/resolved");
  assert.deepEqual(interruptedApproval?.type === "approval/resolved"
    ? interruptedApproval.payload.publicControls
    : undefined, {
    binding: unstartedBinding,
    requestEventId: unstartedRequest.eventId,
    requestDigest: unstartedRequest.digest,
    decision: "deny",
    resolution: "interrupted"
  });
  assert.deepEqual(recovered.slice(-2).map((event) => event.type), ["step/end", "turn/end"]);
  const recoveredToolResults = recovered.filter((event) => event.type === "tool/result");
  assert.deepEqual(
    recoveredToolResults.map((event) => event.candidateId),
    [assistantCandidateId, assistantCandidateId]
  );
  assert.deepEqual(recoveredToolResults.map((event) => event.runId), [runId, runId]);
  assert.deepEqual(
    recovered.slice(-2).map((event) => ({ runId: event.runId, candidateId: event.candidateId })),
    [
      { runId, candidateId: turnCandidateId },
      { runId, candidateId: turnCandidateId }
    ]
  );
  const last = recovered.at(-1);
  assert.equal(last?.type === "turn/end" ? last.payload.publicControls.reason : undefined, "interrupted");
  assert.equal((await recoverInterruptedSession(session)).length, 0);

  const projection = projectSession(session.events);
  assert.equal(projection.status, "interrupted");
  assert.equal(projection.pendingToolCalls.length, 0);
  assert.equal(projection.pendingApprovals.length, 0);
  assert.deepEqual(projection.messages.map((message) => message.publicControls.message.id), [
    "user-1",
    "assistant-1",
    "recovery-call-started",
    "recovery-call-unstarted"
  ]);
  assert.equal(projection.pendingToolCalls.length, 0);
});

test("recovery treats approved but not started tools as not started without replay", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("recover-approved-not-started") });
  const callId = CallId("approved-not-started-call");
  const runId = RunId("approved-not-started-run");
  const candidateId = CandidateId("approved-not-started-candidate");
  const assistant = createAssistantMessage({
    id: MessageId("approved-not-started-assistant"),
    content: [{ type: "tool-call", id: callId, name: "write", arguments: "{}" }],
    source: { kind: "model", provider: "mock", model: "scripted" }
  });
  const binder = createRuntimeEffectCommitmentBinderV1({
    governanceDigest: Digest("c".repeat(64)),
    harnessDigest: Digest("d".repeat(64))
  });
  const handle = binder.bind({
    effectKind: deriveToolEffectKindV1("write"),
    sessionId: session.header.sessionId,
    runId,
    candidateId,
    turn: 1,
    step: 1,
    internalEffectId: callId,
    protectedInput: createProtectedTextV1("{}"),
    raw: { kind: "text", value: "{}" }
  });
  const binding = {
    schemaVersion: 1 as const,
    approvalId: "approved-not-started-approval",
    scope: handle.commitment.effectKind,
    risk: "side-effecting" as const,
    callId,
    name: "write",
    commitment: handle.commitment
  };
  await session.append("turn/start", { turn: 1 }, { runId, candidateId });
  await session.append("step/start", { turn: 1, step: 1 }, { runId, candidateId });
  await session.append(
    "assistant/message",
    { turn: 1, step: 1, message: assistant },
    { runId, candidateId }
  );
  const requested = await session.append(
    "approval/requested",
    { binding },
    { runId, candidateId }
  );
  await session.append("approval/resolved", {
    binding,
    requestEventId: requested.eventId,
    requestDigest: requested.digest,
    decision: "approve_once",
    resolution: "decided"
  }, { runId, candidateId });
  binder.dispose();

  const before = projectSession(session.events);
  assert.equal(before.status, "active");
  assert.deepEqual(before.pendingApprovals.map((approval) => approval.state), ["approved"]);

  const recovered = await recoverInterruptedSession(session);
  assert.deepEqual(recovered.map((event) => event.type), ["tool/result", "step/end", "turn/end"]);
  const result = recovered[0];
  assert.equal(result?.type === "tool/result" ? result.payload.publicControls.error?.code : undefined, TOOL_NOT_STARTED);
  assert.deepEqual(await recoverInterruptedSession(session), []);
  assert.equal(projectSession(session.events).pendingApprovals.length, 0);
});

test("projection rejects an approval request forged across the proposal run or candidate", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("approval-proposal-binding") });
  const callId = CallId("proposal-bound-call");
  const proposalRunId = RunId("proposal-run");
  const proposalCandidateId = CandidateId("proposal-candidate");
  const forgedRunId = RunId("forged-approval-run");
  const forgedCandidateId = CandidateId("forged-approval-candidate");
  const assistant = createAssistantMessage({
    id: MessageId("proposal-bound-assistant"),
    content: [{ type: "tool-call", id: callId, name: "write", arguments: "{}" }],
    source: { kind: "model", provider: "mock", model: "scripted" }
  });
  const binder = createRuntimeEffectCommitmentBinderV1({
    governanceDigest: Digest("e".repeat(64)),
    harnessDigest: Digest("f".repeat(64))
  });
  const handle = binder.bind({
    effectKind: deriveToolEffectKindV1("write"),
    sessionId: session.header.sessionId,
    runId: forgedRunId,
    candidateId: forgedCandidateId,
    turn: 1,
    step: 1,
    internalEffectId: callId,
    protectedInput: createProtectedTextV1("{}"),
    raw: { kind: "text", value: "{}" }
  });
  await session.append("turn/start", { turn: 1 }, {
    runId: proposalRunId,
    candidateId: proposalCandidateId
  });
  await session.append("step/start", { turn: 1, step: 1 }, {
    runId: proposalRunId,
    candidateId: proposalCandidateId
  });
  await session.append("assistant/message", { turn: 1, step: 1, message: assistant }, {
    runId: proposalRunId,
    candidateId: proposalCandidateId
  });
  await session.append("approval/requested", {
    binding: {
      schemaVersion: 1,
      approvalId: "forged-proposal-approval",
      scope: handle.commitment.effectKind,
      risk: "side-effecting",
      callId,
      name: "write",
      commitment: handle.commitment
    }
  }, { runId: forgedRunId, candidateId: forgedCandidateId });
  binder.dispose();

  assert.throws(
    () => projectSession(session.events),
    /approval|proposal|run|candidate/iu
  );
});

test("recovery closes a durably started model attempt as unknown without replay", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("recover-model-attempt") });
  const runId = RunId("recover-model-run");
  const candidateId = CandidateId("recover-model-candidate");
  await session.append("turn/start", { turn: 1 }, { runId, candidateId });
  await session.append("step/start", { turn: 1, step: 1 }, { runId, candidateId });
  const started = createModelAttemptStartedV1({
    providerId: "provider-safe",
    modelId: "model-safe",
    apiFormat: "openai_chat",
    attempt: 1,
    protectedRequestDigest: "a".repeat(64),
    routeDigest: "b".repeat(64),
    pricing: createModelPricingSnapshotV1({ inputUsdPerMillion: "1" })
  });
  const startedEvent = await session.append("model/attempt-started", {
    turn: 1,
    step: 1,
    attempt: started
  }, { runId, candidateId });

  const before = projectSession(session.events);
  assert.deepEqual(before.pendingModelAttempts.map((attempt) => ({
    eventId: attempt.startedEventId,
    digest: attempt.startedDigest,
    attempt: attempt.started.attempt
  })), [{ eventId: startedEvent.eventId, digest: startedEvent.digest, attempt: 1 }]);

  const recovered = await recoverInterruptedSession(session);
  assert.deepEqual(recovered.map((event) => event.type), ["model/audit", "step/end", "turn/end"]);
  const audit = recovered[0];
  assert.equal(audit?.type, "model/audit");
  if (audit?.type !== "model/audit") throw new Error("model audit recovery event was not appended");
  assert.equal(audit.payload.publicControls.startedEventId, startedEvent.eventId);
  assert.equal(audit.payload.publicControls.startedDigest, startedEvent.digest);
  assert.equal(audit.payload.publicControls.terminal.outcome, "interrupted");
  assert.equal(audit.payload.publicControls.terminal.dispatchState, "unknown");
  assert.equal(audit.payload.publicControls.terminal.failureCode, "stream_interrupted");
  assert.equal(audit.runId, runId);
  assert.equal(audit.candidateId, candidateId);
  assert.deepEqual(await recoverInterruptedSession(session), []);
  assert.equal(projectSession(session.events).pendingModelAttempts.length, 0);
});
