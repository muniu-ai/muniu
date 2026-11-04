// SPDX-License-Identifier: Apache-2.0
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export async function loadApiContract() {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL("../../packages/contracts/src/openapi.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
}

export async function loadEnterpriseApiContract() {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL("../../packages/contracts/src/enterprise-api-schema.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
}
