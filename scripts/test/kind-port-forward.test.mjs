// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createKindPortForward } from "../lib/kind-port-forward.mjs";

test("Kind reconnects a terminated tunnel to the same Host Pod without replacing a live tunnel", () => {
  const children = [];
  const calls = [];
  const forward = createKindPortForward("muniu-kind", "pod/host-b", "27319:7318", children, (...args) => {
    calls.push(args);
    return { exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() };
  });
  forward.reconnect();
  assert.equal(calls.length, 1);
  const first = forward.child;
  first.stderr.emit("data", "connection closed");
  assert.match(forward.diagnostics(), /connection closed/u);
  first.exitCode = 1;
  forward.reconnect();
  assert.notEqual(forward.child, first);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(forward.diagnostics(), "");
  assert.equal(children.length, 2);
  forward.child.signalCode = "SIGTERM";
  forward.reconnect();
  assert.equal(children.length, 3);
});
