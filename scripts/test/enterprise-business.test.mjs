// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentOsCompositionRoot } from "@mn/host";
import { InMemoryKernelStore } from "@mn/kernel";
import { createEnterpriseBusinessHandlers, loadEnterpriseBusinessConfiguration, BUSINESS_KINDS } from "../lib/enterprise-business.mjs";

const names = ["MUNIU_SALES_URL", "MUNIU_SALES_TOKEN_FILE", "MUNIU_BUSINESS_AUTHORITY_TOKEN_FILE",
  "MUNIU_OS_AUTHORITY_TOKEN_FILE", "MUNIU_BUSINESS_WORKSPACE_SCOPES_FILE"];
async function configured(fn) {
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const dir = await mkdtemp(join(tmpdir(), "mn-enterprise-business-"));
  try {
    for (const name of names) delete process.env[name];
    const scopesFile = join(dir, "scopes.json");
    const tokenFile = join(dir, "sales-token");
    const authorityFile = join(dir, "authority-token");
    await writeFile(scopesFile, JSON.stringify([{ tenantId: "tenant-a", workspaceId: "workspace-a" }]));
    await writeFile(tokenFile, "synthetic-sales-token\n", { mode: 0o600 });
    await writeFile(authorityFile, "synthetic-authority-token\n", { mode: 0o600 });
    Object.assign(process.env, { MUNIU_SALES_URL: "https://sales.example.test/api/v1/os-business",
      MUNIU_SALES_TOKEN_FILE: tokenFile, MUNIU_BUSINESS_AUTHORITY_TOKEN_FILE: authorityFile,
      MUNIU_BUSINESS_WORKSPACE_SCOPES_FILE: scopesFile });
    await fn({ scopesFile, tokenFile });
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await rm(dir, { recursive: true, force: true });
  }
}

test("enterprise business configuration binds Host scopes and requires both industrial capabilities", async () => configured(async () => {
  const business = await loadEnterpriseBusinessConfiguration({ kinds: BUSINESS_KINDS });
  assert.deepEqual(business.businessWorkspaceScopes, [{ tenantId: "tenant-a", workspaceId: "workspace-a" }]);
  assert.equal(await business.businessAuthorityTokenResolver(), "synthetic-authority-token");
  assert.equal(typeof business.businessProvider.actions.execute, "function");
  await assert.rejects(loadEnterpriseBusinessConfiguration({ kinds: ["system.noop"] }), /BUSINESS_WORKER_CAPABILITY_MISSING/u);
  await assert.rejects(loadEnterpriseBusinessConfiguration({ kinds: BUSINESS_KINDS, fixtureMode: true }), /BUSINESS_FIXTURE_FORBIDDEN/u);
  delete process.env.MUNIU_SALES_URL;
  await assert.rejects(loadEnterpriseBusinessConfiguration({ kinds: BUSINESS_KINDS }), /BUSINESS_PROVIDER_REQUIRED/u);
  assert.equal(await loadEnterpriseBusinessConfiguration({ kinds: ["system.noop"] }), undefined);
}));

test("enterprise business configuration rejects insecure endpoint, missing credentials and ambiguous scope", async () => configured(async ({ scopesFile, tokenFile }) => {
  process.env.MUNIU_SALES_URL = "http://127.0.0.1/api/v1/os-business";
  await assert.rejects(loadEnterpriseBusinessConfiguration({ kinds: BUSINESS_KINDS }), /HTTPS/u);
  process.env.MUNIU_SALES_URL = "https://sales.example.test/api/v1/os-business";
  await writeFile(scopesFile, JSON.stringify([{ tenantId: "tenant-a", workspaceId: "same" }, { tenantId: "tenant-b", workspaceId: "same" }]));
  await assert.rejects(loadEnterpriseBusinessConfiguration({ kinds: BUSINESS_KINDS }), /BUSINESS_SCOPE_AMBIGUOUS/u);
  await writeFile(scopesFile, JSON.stringify([{ tenantId: "tenant-a", workspaceId: "workspace-a" }]));
  await writeFile(tokenFile, "synthetic\ninjected");
  await assert.rejects(loadEnterpriseBusinessConfiguration({ kinds: BUSINESS_KINDS }), /凭据/u);
}));

test("industrial handlers use Host composition and preserve candidate/action validation", async () => configured(async () => {
  const business = await loadEnterpriseBusinessConfiguration({ kinds: BUSINESS_KINDS });
  const store = new InMemoryKernelStore();
  const composition = await createAgentOsCompositionRoot({ profile: "enterprise", store });
  try {
    const context = { store, composition, cas: {}, protectedPayloadKeyProvider: {}, secretStore: { read: async () => "unused" } };
    const handlers = createEnterpriseBusinessHandlers(business, context);
    assert.deepEqual(Object.keys(handlers).sort(), [...BUSINESS_KINDS].sort());
    await assert.rejects(handlers["business.candidate.extract"]({ payload: {} }, {}), /候选任务缺少标识/u);
    await assert.rejects(handlers["business.action.execute"]({ payload: {} }, {}));
    assert.throws(() => createEnterpriseBusinessHandlers(business, { ...context, composition: undefined }), /组合根/u);
    assert.throws(() => createEnterpriseBusinessHandlers(business, { ...context, cas: undefined }), /CAS/u);
    assert.throws(() => createEnterpriseBusinessHandlers(business, { ...context, fixtureMode: true }), /BUSINESS_FIXTURE_FORBIDDEN/u);
    assert.deepEqual(createEnterpriseBusinessHandlers(undefined, {}), {});
  } finally { await composition.context.fiber.dispose(); }
}));
