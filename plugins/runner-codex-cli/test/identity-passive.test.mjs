import assert from "node:assert/strict";
import { access, chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { passivelyInspectRunnerBinary } from "../src/index.ts";

test("Codex Runner 被动检查不执行未确认路径", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mn-codex-passive-"));
  const binary = join(directory, "codex");
  const marker = join(directory, "executed");
  await writeFile(binary, `#!/bin/sh\ntouch "${marker}"\necho 4.5.6\n`);
  await chmod(binary, 0o755);

  const inspection = await passivelyInspectRunnerBinary(binary);

  assert.equal(inspection.realPath, await realpath(binary));
  assert.match(inspection.sha256, /^[0-9a-f]{64}$/u);
  assert.equal("version" in inspection, false);
  await assert.rejects(() => access(marker));
});
