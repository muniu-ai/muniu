// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProcessSupervisor, createProcessTools } from "../src/index.js";

test("process tools stream stdin and output through a session-bound cursor", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "muniu-process-tools-"));
  const supervisor = new ProcessSupervisor({ allowedExecutables: [process.execPath] });
  const byName = new Map(createProcessTools(supervisor).map((tool) => [tool.name, tool]));
  const context = { sessionId: "session-process-one", cwd };
  const started = await byName.get("process_start")!.execute({
    executable: process.execPath,
    args: ["-e", "process.stdin.once('data', b => process.stdout.write(b.toString().toUpperCase()))"]
  }, context) as { processId: string };
  await byName.get("process_write_stdin")!.execute({
    processId: started.processId,
    data: "hello",
    close: true
  }, context);
  const terminal = await byName.get("process_wait")!.execute({ processId: started.processId }, context);
  assert.deepEqual(terminal, { exitCode: 0, signal: null, status: "completed" });
  const output = await byName.get("process_read")!.execute({ processId: started.processId, cursor: 0 }, context) as {
    entries: Array<{ stream: string; text: string }>;
    nextCursor: number;
  };
  assert.equal(output.entries.map((entry) => entry.text).join(""), "HELLO");
  assert.equal(output.entries[0]?.stream, "stdout");
  assert.equal(output.nextCursor > 0, true);
});

test("process supervisor rejects traversal, unapproved executables, cross-session access and missing PTY", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "muniu-process-tools-boundary-"));
  const supervisor = new ProcessSupervisor({ allowedExecutables: [process.execPath] });
  await assert.rejects(
    () => supervisor.start({ sessionId: "session-one", cwd }, {
      executable: process.execPath,
      args: [],
      cwd: "../outside"
    }),
    /outside the workspace/iu
  );
  await assert.rejects(
    () => supervisor.start({ sessionId: "session-one", cwd }, { executable: "sh", args: [] }),
    /not allowlisted/iu
  );
  await assert.rejects(
    () => supervisor.start({ sessionId: "session-one", cwd }, {
      executable: process.execPath,
      args: [],
      pty: true
    }),
    /PTY backend is unavailable/u
  );

  const started = await supervisor.start({ sessionId: "session-one", cwd }, {
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"]
  });
  await assert.rejects(
    () => supervisor.read("session-two", started.processId, 0),
    /does not belong to the session/iu
  );
  await supervisor.terminate("session-one", started.processId, "SIGTERM");
  assert.equal((await supervisor.wait("session-one", started.processId)).status, "terminated");
});

test("process resize delegates only to an explicitly configured PTY backend", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "muniu-process-tools-pty-"));
  const resizes: Array<[number, number]> = [];
  let exit: ((result: { exitCode: number | null; signal: string | null }) => void) | undefined;
  const supervisor = new ProcessSupervisor({
    allowedExecutables: ["fake-pty"],
    ptyBackend: {
      launch() {
        return {
          write() {},
          resize(columns, rows) { resizes.push([columns, rows]); },
          terminate() { exit?.({ exitCode: null, signal: "SIGTERM" }); },
          onData() { return () => undefined; },
          onExit(listener) { exit = listener; return () => undefined; }
        };
      }
    }
  });
  const started = await supervisor.start({ sessionId: "session-pty", cwd }, {
    executable: "fake-pty",
    args: [],
    pty: true
  });
  await supervisor.resize("session-pty", started.processId, 120, 40);
  assert.deepEqual(resizes, [[120, 40]]);
  await supervisor.terminate("session-pty", started.processId, "SIGTERM");
});

test("process supervisor handles a backend that exits during listener registration", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "muniu-process-tools-sync-exit-"));
  let exitListenerRemoved = false;
  const supervisor = new ProcessSupervisor({
    allowedExecutables: ["sync-exit"],
    ptyBackend: {
      launch() {
        return {
          write() {},
          terminate() {},
          onData() { return () => undefined; },
          onExit(listener) {
            listener({ exitCode: 0, signal: null });
            return () => { exitListenerRemoved = true; };
          }
        };
      }
    }
  });
  const started = await supervisor.start({ sessionId: "session-sync-exit", cwd }, {
    executable: "sync-exit",
    args: [],
    pty: true
  });
  assert.equal((await supervisor.wait("session-sync-exit", started.processId)).status, "completed");
  assert.equal(exitListenerRemoved, true);
});
