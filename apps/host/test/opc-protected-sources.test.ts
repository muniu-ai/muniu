// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { InMemoryKernelStore } from "@mn/kernel";
import {
  InMemoryKeyProvider,
  type ContentAddressedStorage,
} from "@mn/storage";

import { createAgentOsHost } from "../src/index.js";

const RAW_INTERVIEW = "仅应在授权响应中出现的访谈原文：淡季没有稳定的新客户。";

function memoryCas() {
  const objects = new Map<string, Buffer>();
  const cas: ContentAddressedStorage = {
    async put(bytes) {
      const copy = Buffer.from(bytes);
      const digest = createHash("sha256").update(copy).digest("hex");
      const created = !objects.has(digest);
      objects.set(digest, copy);
      return { digest, byteLength: copy.byteLength, created };
    },
    async get(digest) {
      const value = objects.get(digest);
      if (!value) throw new Error("CAS object missing");
      return Buffer.from(value);
    },
    async has(digest) { return objects.has(digest); },
    async gcOrphans() { return []; },
  };
  return { cas, objects };
}

function request(
  tenantId: string,
  principalId: string,
  path: string,
  body?: unknown,
  options: { readonly method?: string; readonly key?: string } = {},
): Request {
  const headers = new Headers({
    "X-Tenant": tenantId,
    "X-Principal": principalId,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (options.key) headers.set("Idempotency-Key", options.key);
  return new Request(`http://host.test${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function body(response: Response): Promise<any> {
  return response.json();
}

test("OPC 文件与访谈只接受同租户同工作区 Asset，原文不进入事实事件和投影", async () => {
  const store = new InMemoryKernelStore();
  const { cas, objects } = memoryCas();
  const keys = new InMemoryKeyProvider(randomBytes(32));
  let sequence = 0;
  const host = await createAgentOsHost({
    profile: "enterprise",
    store,
    cas,
    protectedPayloadKeyProvider: keys,
    secretStore: {
      async save(id) { return `vault://muniu/v2/${id}`; },
      async read() { return "fixture-key"; },
    },
    identityResolver: (incoming) => ({
      tenantId: incoming.headers.get("X-Tenant") ?? "",
      principalId: incoming.headers.get("X-Principal") ?? "",
      organizationRoles: ["organization_admin"],
    }),
    now: () => "2026-09-04T09:00:00.000Z",
    id: (kind) => `${kind}-${++sequence}`,
  });

  async function mutate(
    tenantId: string,
    principalId: string,
    path: string,
    payload: unknown,
    key: string,
    method = "POST",
  ) {
    const response = await host.dispatch(request(tenantId, principalId, path, payload, { key, method }));
    return { response, payload: await body(response.clone()) };
  }

  async function workspace(tenantId: string, suffix: string) {
    const result = await mutate(tenantId, `owner-${suffix}`, "/v2/workspaces", {
      name: `机会验证 ${suffix}`,
      viewMode: "business",
      pluginIds: ["opc"],
    }, `workspace-${suffix}`);
    assert.equal(result.response.status, 201, JSON.stringify(result.payload));
    return result.payload.data;
  }

  async function researchingOpportunity(tenantId: string, principalId: string, targetWorkspace: any, suffix: string) {
    let result = await mutate(tenantId, principalId, "/v2/plugins/opc/opportunities", {
      workspaceId: targetWorkspace.id,
      expectedStreamVersion: 0,
      input: `文件证据 ${suffix}`,
    }, `capture-${suffix}`);
    let opportunity = result.payload.data;
    for (const [command, input] of [
      ["frame", {
        targetCustomer: "独立开发者",
        problem: "缺少可复核资料",
        falsifiableHypothesis: "材料会支持或反对当前判断",
      }],
      ["start_research", {}],
    ] as const) {
      result = await mutate(tenantId, principalId, `/v2/plugins/opc/opportunities/${opportunity.id}/commands`, {
        workspaceId: targetWorkspace.id,
        expectedStreamVersion: opportunity.streamVersion,
        command,
        input,
      }, `${suffix}-${command}`);
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      opportunity = result.payload.data;
    }
    return opportunity;
  }

  async function upload(
    tenantId: string,
    principalId: string,
    targetWorkspace: any,
    key: string,
    fileName: string,
    content: string,
    protectedValue: boolean,
  ) {
    const result = await mutate(tenantId, principalId, "/v2/assets", {
      workspaceId: targetWorkspace.id,
      expectedStreamVersion: 0,
      attachments: [{
        fileName,
        mediaType: "text/plain",
        contentBase64: Buffer.from(content).toString("base64"),
        protected: protectedValue,
      }],
    }, key);
    assert.equal(result.response.status, 201, JSON.stringify(result.payload));
    return result.payload.data[0];
  }

  const workspaceA = await workspace("tenant-a", "a");
  const workspaceA2 = await workspace("tenant-a", "a2");
  const workspaceB = await workspace("tenant-b", "b");
  let opportunityA = await researchingOpportunity("tenant-a", "owner-a", workspaceA, "a");
  const opportunityA2 = await researchingOpportunity("tenant-a", "owner-a2", workspaceA2, "a2");
  const opportunityB = await researchingOpportunity("tenant-b", "owner-b", workspaceB, "b");
  const signalAsset = await upload(
    "tenant-a", "owner-a", workspaceA, "signal-asset", "市场资料.txt", "可复核的市场材料", false,
  );

  let result = await mutate("tenant-a", "owner-a", `/v2/plugins/opc/opportunities/${opportunityA.id}/commands`, {
    workspaceId: workspaceA.id,
    expectedStreamVersion: opportunityA.streamVersion,
    command: "record_signal",
    input: {
      sourceKind: "file",
      sourceAssetId: signalAsset.id,
      observedAt: "2026-09-04T08:30:00.000Z",
      summary: "材料反对当前价格假设",
      relationship: "oppose",
      evidenceKind: "context",
    },
  }, "signal-file");
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  opportunityA = result.payload.data;
  assert.equal(opportunityA.signals[0].sourceAssetId, signalAsset.id);

  const crossWorkspace = await mutate("tenant-a", "owner-a2", `/v2/plugins/opc/opportunities/${opportunityA2.id}/commands`, {
    workspaceId: workspaceA2.id,
    expectedStreamVersion: opportunityA2.streamVersion,
    command: "record_signal",
    input: {
      sourceKind: "file",
      sourceAssetId: signalAsset.id,
      observedAt: "2026-09-04T08:30:00.000Z",
      summary: "伪造跨工作区引用",
      relationship: "neutral",
      evidenceKind: "context",
    },
  }, "signal-cross-workspace");
  assert.equal(crossWorkspace.response.status, 422);
  assert.equal(crossWorkspace.payload.code, "OPC_ASSET_SCOPE_MISMATCH");

  const crossTenant = await mutate("tenant-b", "owner-b", `/v2/plugins/opc/opportunities/${opportunityB.id}/commands`, {
    workspaceId: workspaceB.id,
    expectedStreamVersion: opportunityB.streamVersion,
    command: "record_signal",
    input: {
      sourceKind: "file",
      sourceAssetId: signalAsset.id,
      observedAt: "2026-09-04T08:30:00.000Z",
      summary: "伪造跨租户引用",
      relationship: "neutral",
      evidenceKind: "context",
    },
  }, "signal-cross-tenant");
  assert.equal(crossTenant.response.status, 404);
  assert.equal(crossTenant.payload.code, "OPC_ASSET_NOT_FOUND");

  result = await mutate("tenant-a", "owner-a", `/v2/plugins/opc/opportunities/${opportunityA.id}/commands`, {
    workspaceId: workspaceA.id,
    expectedStreamVersion: opportunityA.streamVersion,
    command: "start_interviewing",
    input: {},
  }, "start-interviewing");
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  opportunityA = result.payload.data;

  const rejectedPlainAsset = await upload(
    "tenant-a", "owner-a", workspaceA, "plain-interview-asset", "访谈明文.txt", "不可作为访谈原文", false,
  );
  const plainInterview = await mutate("tenant-a", "owner-a", `/v2/plugins/opc/opportunities/${opportunityA.id}/commands`, {
    workspaceId: workspaceA.id,
    expectedStreamVersion: opportunityA.streamVersion,
    command: "record_interview",
    input: {
      interviewId: "interview-plain",
      participantRef: "受访者 A",
      occurredAt: "2026-09-03T10:00:00.000Z",
      rawRecordAssetId: rejectedPlainAsset.id,
    },
  }, "interview-plain");
  assert.equal(plainInterview.response.status, 422);
  assert.equal(plainInterview.payload.code, "OPC_INTERVIEW_ASSET_NOT_PROTECTED");

  const rawAsset = await upload(
    "tenant-a", "owner-a", workspaceA, "raw-interview-asset", "访谈原文.txt", RAW_INTERVIEW, true,
  );
  result = await mutate("tenant-a", "owner-a", `/v2/plugins/opc/opportunities/${opportunityA.id}/commands`, {
    workspaceId: workspaceA.id,
    expectedStreamVersion: opportunityA.streamVersion,
    command: "record_interview",
    input: {
      interviewId: "interview-a",
      participantRef: "受访者 A",
      occurredAt: "2026-09-03T10:00:00.000Z",
      rawRecordAssetId: rawAsset.id,
    },
  }, "interview-protected");
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  opportunityA = result.payload.data;
  assert.equal(opportunityA.interviews[0].rawRecord, RAW_INTERVIEW);
  assert.equal(opportunityA.interviews[0].rawRecordAssetId, rawAsset.id);

  const legacyRaw = await mutate("tenant-a", "owner-a", `/v2/plugins/opc/opportunities/${opportunityA.id}/commands`, {
    workspaceId: workspaceA.id,
    expectedStreamVersion: opportunityA.streamVersion,
    command: "record_interview",
    input: {
      interviewId: "interview-forged",
      participantRef: "受访者 B",
      occurredAt: "2026-09-03T11:00:00.000Z",
      rawRecord: RAW_INTERVIEW,
    },
  }, "interview-legacy-raw");
  assert.equal(legacyRaw.response.status, 422);

  const preview = await host.dispatch(request(
    "tenant-a", "owner-a",
    `/v2/plugins/opc/opportunities/${opportunityA.id}/deliverables?workspaceId=${workspaceA.id}`,
  ));
  assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()));
  assert.match(JSON.stringify((await body(preview)).data), new RegExp(RAW_INTERVIEW, "u"));

  const exported = await mutate("tenant-a", "owner-a", `/v2/plugins/opc/opportunities/${opportunityA.id}/exports`, {
    workspaceId: workspaceA.id,
    expectedStreamVersion: opportunityA.streamVersion,
  }, "export-protected");
  assert.equal(exported.response.status, 201, JSON.stringify(exported.payload));
  assert.match(JSON.stringify(exported.payload.data), new RegExp(RAW_INTERVIEW, "u"));

  const unauthorized = await host.dispatch(request(
    "tenant-a", "owner-a2",
    `/v2/plugins/opc/opportunities/${opportunityA.id}?workspaceId=${workspaceA.id}`,
  ));
  assert.equal(unauthorized.status, 403);
  assert.doesNotMatch(await unauthorized.text(), new RegExp(RAW_INTERVIEW, "u"));
  const unauthorizedExport = await mutate(
    "tenant-a",
    "owner-a2",
    `/v2/plugins/opc/opportunities/${opportunityA.id}/exports`,
    {
      workspaceId: workspaceA.id,
      expectedStreamVersion: opportunityA.streamVersion,
    },
    "export-without-membership",
  );
  assert.equal(unauthorizedExport.response.status, 403);
  assert.doesNotMatch(JSON.stringify(unauthorizedExport.payload), new RegExp(RAW_INTERVIEW, "u"));

  const privateState = await store.transact("tenant-a", (transaction) => ({
    opportunities: transaction.listProjections("opc.opportunity"),
    events: transaction.listProjections("opc.events"),
    deliverables: transaction.listProjections("deliverable"),
    idempotency: transaction.getIdempotency(
      `opc.opportunity.command:${opportunityA.id}:${workspaceA.id}:${opportunityA.id}`,
      "interview-protected",
    ),
  }));
  const kernelEvents = await store.readEvents("tenant-a", 0, 1_000);
  assert.doesNotMatch(JSON.stringify(privateState), new RegExp(RAW_INTERVIEW, "u"));
  assert.doesNotMatch(JSON.stringify(kernelEvents), new RegExp(RAW_INTERVIEW, "u"));
  assert.equal([...objects.values()].some((value) => value.includes(Buffer.from(RAW_INTERVIEW))), false);

  const keyRecord = await store.transact("tenant-a", (transaction) =>
    transaction.getProjection<any>("protectedPayloadKey", rawAsset.protectedPayloadRef));
  await store.transact("tenant-a", (transaction) => {
    transaction.deleteProjection("protectedPayloadKey", rawAsset.protectedPayloadRef);
  });
  const revoked = await host.dispatch(request(
    "tenant-a", "owner-a",
    `/v2/plugins/opc/opportunities/${opportunityA.id}?workspaceId=${workspaceA.id}`,
  ));
  assert.equal(revoked.status, 422);
  assert.equal((await body(revoked)).code, "PROTECTED_PAYLOAD_DESTROYED");
  await store.transact("tenant-a", (transaction) => {
    transaction.putProjection("protectedPayloadKey", rawAsset.protectedPayloadRef, keyRecord);
  });

  const deletion = await mutate("tenant-a", "owner-a", `/v2/assets/${rawAsset.id}`, {
    expectedStreamVersion: rawAsset.streamVersion,
    reason: "受访者撤回授权",
  }, "delete-interview-source", "DELETE");
  assert.equal(deletion.response.status, 200, JSON.stringify(deletion.payload));
  const deleted = await host.dispatch(request(
    "tenant-a", "owner-a",
    `/v2/plugins/opc/opportunities/${opportunityA.id}?workspaceId=${workspaceA.id}`,
  ));
  assert.equal(deleted.status, 404);
  assert.equal((await body(deleted)).code, "OPC_ASSET_NOT_FOUND");
  const exportAfterDelete = await mutate("tenant-a", "owner-a", `/v2/plugins/opc/opportunities/${opportunityA.id}/exports`, {
    workspaceId: workspaceA.id,
    expectedStreamVersion: opportunityA.streamVersion,
  }, "export-after-delete");
  assert.equal(exportAfterDelete.response.status, 404);
  assert.equal(exportAfterDelete.payload.code, "OPC_ASSET_NOT_FOUND");

  await host.close();
});
