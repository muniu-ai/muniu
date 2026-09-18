// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBusinessActionDigest, computeBusinessOperationKey,
  parseBusinessDecisionV1, parseBusinessObjectSnapshotV1, parseEffectReceiptV1,
  parseIssueQuotePackageInputV1, parseCreateBusinessActionV2, parseEffectAdmissionRequestV1,
  parseBusinessActionV1, parseEffectAdmissionV1, parseEffectExecutionRequestV1,
} from "../src/business-effects.js";

const digest = "a".repeat(64);
const scope = { tenantId: "tenant-a", workspaceId: "workspace-a", principalId: "person-a", customerId: "customer-a" };
const template = { id: "quote-standard", version: "1", digest };
const snapshot = { schemaVersion: "1", providerId: "sales", objectType: "quote", objectId: "quote-a", version: "3",
  digest, protectedContentRef: "sales://tenant-a/quote/quote-a/3", scope,
  observedAt: "2026-09-18T01:00:00.000Z", template,
  sourceRefs: [{ namespace: "sales.rfq", resourceId: "rfq-a", digest, protectedContentRef: "sales://tenant-a/rfq/rfq-a/1" }] };
const decision = { schemaVersion: "1", id: "decision-a", scope, snapshotDigest: digest, snapshotVersion: "3",
  actorId: "reviewer-a", policyVersion: "1", approvedAt: "2026-09-18T01:00:00.000Z",
  expiresAt: "2026-09-19T01:00:00.000Z", status: "approved", digest };
const action = { schemaVersion: "1", action: "issueQuotePackage", actionId: "action-a", operationKey: "operation-a", scope,
  quote: { id: "quote-a", version: "3", digest }, businessDecision: { id: "decision-a", digest }, template,
  renderVersion: "1", exportFormat: "pdf", issueDate: "2026-09-18" };

test("业务快照和核准只接受完整的权威引用，并拒绝凭据及跨租户引用", () => {
  assert.deepEqual(parseBusinessObjectSnapshotV1(snapshot), snapshot);
  assert.deepEqual(parseBusinessDecisionV1(decision), decision);
  for (const bad of [
    { ...snapshot, digest: "changed" },
    { ...snapshot, schemaVersion: "2" },
    { ...snapshot, protectedContentRef: "sales://secret@tenant-a/quote/quote-a/3" },
    { ...snapshot, protectedContentRef: "sales://tenant-b/quote/quote-a/3" },
    { ...snapshot, sourceRefs: [{ ...snapshot.sourceRefs[0], protectedContentRef: "https://example.test/private?token=secret" }] },
    { ...snapshot, apiKey: "secret" },
  ]) assert.throws(() => parseBusinessObjectSnapshotV1(bad), /业务契约无效/u);
  assert.throws(() => parseBusinessDecisionV1({ ...decision, status: "revoked" }), /业务契约无效/u);
  assert.throws(() => parseBusinessDecisionV1({ ...decision, revokedAt: decision.approvedAt }), /业务契约无效/u);
});

test("稳定操作身份不依赖批准、动作或执行人，动作摘要仍绑定批准和权限范围", () => {
  const first = parseIssueQuotePackageInputV1(action);
  const changedApproval = parseIssueQuotePackageInputV1({ ...action, actionId: "action-b", businessDecision: { id: "decision-b", digest: "b".repeat(64) } });
  assert.equal(computeBusinessOperationKey(first), computeBusinessOperationKey(changedApproval));
  assert.notEqual(computeBusinessActionDigest(first), computeBusinessActionDigest(changedApproval));
  const otherPrincipal = parseIssueQuotePackageInputV1({ ...action, scope: { ...scope, principalId: "person-b" } });
  assert.equal(computeBusinessOperationKey(first), computeBusinessOperationKey(otherPrincipal));
  assert.notEqual(computeBusinessActionDigest(first), computeBusinessActionDigest(otherPrincipal));
  for (const change of [{ quote: { ...action.quote, version: "4" } }, { issueDate: "2026-09-19" }, { renderVersion: "2" },
    { template: { ...template, digest: "b".repeat(64) } }, { scope: { ...scope, customerId: "customer-b" } }]) {
    assert.notEqual(computeBusinessOperationKey(first), computeBusinessOperationKey(parseIssueQuotePackageInputV1({ ...action, ...change })));
  }
});

test("业务动作拒绝模型注入的 Worker 身份及无效日期", () => {
  assert.throws(() => parseIssueQuotePackageInputV1({ ...action, workerId: "forged" }));
  assert.throws(() => parseIssueQuotePackageInputV1({ ...action, fencingToken: 99 }));
  assert.throws(() => parseIssueQuotePackageInputV1({ ...action, issueDate: "2026-02-30" }));
  const create = { schemaVersion: "1", action: "issueQuotePackage", expectedStreamVersion: 0,
    workspaceId: scope.workspaceId, customerId: scope.customerId, quoteId: "quote-a", quoteVersion: "3",
    decisionId: "decision-a", templateId: template.id, templateVersion: template.version, renderVersion: "1", exportFormat: "pdf", issueDate: "2026-09-18" };
  assert.deepEqual(parseCreateBusinessActionV2(create), create);
  for (const extra of [{ tenantId: "tenant-b" }, { principalId: "admin" }, { operationKey: "override" }, { quoteDigest: digest }]) {
    assert.throws(() => parseCreateBusinessActionV2({ ...create, ...extra }));
  }
});

test("完成回执必须含归档文件和 SHA256，受理和未知状态不能伪装成果", () => {
  const completed = { schemaVersion: "1", actionId: "action-a", operationKey: "operation-a", status: "completed",
    packageId: "package-a", files: [{ name: "quote.pdf", mediaType: "application/pdf", sha256: digest,
      protectedContentRef: "sales://tenant-a/package/package-a/1" }], observedAt: "2026-09-18T01:00:00.000Z" };
  assert.deepEqual(parseEffectReceiptV1(completed), completed);
  for (const bad of [{ ...completed, files: [] }, { ...completed, status: "accepted" },
    { ...completed, files: [{ ...completed.files[0], sha256: "invalid" }] },
    { ...completed, files: [{ ...completed.files[0], protectedContentRef: "https://example.test?access_token=secret" }] },
    { ...completed, sent: true }]) assert.throws(() => parseEffectReceiptV1(bad));
});

test("服务端入场请求复核稳定操作身份和批准摘要，不能注入替换正文", () => {
  const prepared = parseIssueQuotePackageInputV1(action);
  const bound = { ...prepared, operationKey: computeBusinessOperationKey(prepared) };
  const identity = { executionId: "execution-a", generation: 1, jobId: "job-a", workerId: "worker-a", fencingToken: 1 };
  const request = { schemaVersion: "1", action: bound, identity, approvalId: "approval-a", actionDigest: computeBusinessActionDigest(bound) };
  assert.deepEqual(parseEffectAdmissionRequestV1(request), request);
  for (const bad of [{ ...request, actionDigest: "f".repeat(64) },
    { ...request, action: { ...bound, operationKey: "replacement" } },
    { ...request, action: { ...bound, businessDecision: { ...bound.businessDecision, id: "decision-b" } } },
    { ...request, identity: { ...identity, fencingToken: 0 } }]) assert.throws(() => parseEffectAdmissionRequestV1(bad));
  const execution = { schemaVersion: "1", actionId: bound.actionId, operationKey: bound.operationKey, admissionId: "admission-a", identity };
  assert.deepEqual(parseEffectExecutionRequestV1(execution), execution);
  assert.throws(() => parseEffectExecutionRequestV1({ ...execution, action: bound }));
  assert.throws(() => parseEffectAdmissionV1({ schemaVersion: "1", actionId: bound.actionId, operationKey: bound.operationKey,
    admissionId: "admission-a", status: "existing" }));
  const state = { schemaVersion: "1", id: bound.actionId, tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    executionId: identity.executionId, jobId: identity.jobId, operationKey: bound.operationKey, actionDigest: request.actionDigest,
    action: bound, status: "queued", streamVersion: 1, createdAt: "2026-09-18T01:00:00.000Z", updatedAt: "2026-09-18T01:00:00.000Z" };
  assert.deepEqual(parseBusinessActionV1(state), state);
  assert.throws(() => parseBusinessActionV1({ ...state, actionDigest: "f".repeat(64) }));
});
