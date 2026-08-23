// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlNotificationLog } from "../src/index.js";

test("JSONL notification log persists ordered cursors across process replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mn-notifications-"));
  const filePath = path.join(root, "notifications.jsonl");
  const first = new JsonlNotificationLog(filePath);
  await Promise.all([
    first.append({ method: "warning", params: { message: "one" } }),
    first.append({ method: "warning", params: { message: "two" } })
  ]);

  const reopened = new JsonlNotificationLog(filePath);
  assert.deepEqual(await reopened.readAfter("1"), [
    { cursor: "2", notification: { method: "warning", params: { message: "two" } } }
  ]);
  assert.equal((await readFile(filePath, "utf8")).split("\n").filter(Boolean).length, 2);
});

test("JSONL notification log rejects torn records and symlink targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mn-notifications-"));
  const torn = path.join(root, "torn.jsonl");
  await writeFile(torn, "{}", { mode: 0o600 });
  await assert.rejects(new JsonlNotificationLog(torn).readAfter(), /torn final record/u);

  const target = path.join(root, "target.jsonl");
  const alias = path.join(root, "alias.jsonl");
  await writeFile(target, "", { mode: 0o600 });
  await symlink(target, alias);
  await assert.rejects(
    new JsonlNotificationLog(alias).readAfter(),
    /ELOOP|symbolic link/u
  );
});
