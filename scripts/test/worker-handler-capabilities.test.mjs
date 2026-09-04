// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWorkerSupportedKinds,
} from "../lib/worker-handler-capabilities.mjs";

test("企业 Worker capability 配置必须是非空、无重复的 JSON kind 数组", () => {
  assert.deepEqual(parseWorkerSupportedKinds('["agent.execution.run","system.noop"]'), [
    "agent.execution.run",
    "system.noop",
  ]);
  for (const invalid of [
    undefined,
    "",
    "system.noop",
    "[]",
    '["system.noop","system.noop"]',
    '["system.noop",1]',
  ]) {
    assert.throws(() => parseWorkerSupportedKinds(invalid), /MN_WORKER_SUPPORTED_KINDS/u);
  }
});
