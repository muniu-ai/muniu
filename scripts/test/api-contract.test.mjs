// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { parse } from "yaml";

test("公开 OpenAPI 文档与运行时使用同一契约", async () => {
  const compiled = await build({ entryPoints: ["packages/contracts/src/openapi.ts"], bundle: true, platform: "node", format: "esm", write: false });
  const { createOpenApiDocument } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
  assert.deepEqual(parse(await readFile("docs/reference/openapi.yaml", "utf8")), createOpenApiDocument());
});
