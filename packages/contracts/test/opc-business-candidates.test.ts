// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import * as candidates from "../src/opc-business-candidates.js";

const source = { namespace: "opc.business.customer", resourceId: "c", streamVersion: 3, digest: "a".repeat(64) };
const proposal = { key: "quote-draft", title: "报价建议", rationale: "按已确认范围报价", evidenceRefs: [source], command: {
  type: "quote.create", quoteId: "q", customerId: "c", serviceId: "s", serviceVersion: 1, quantity: 2, discountMinor: "0", validUntil: "2026-10-20", dueOn: "2026-10-30",
} };
const origin = { goalId: "g", planRevisionId: "p", deliverySetId: "d", outputKey: "result", outputDigest: "b".repeat(64) };

test("本地经营候选只接收固定成果选择，禁止任意命令和伪造作用域", () => {
  const value = { workspaceId: "w", expectedStreamVersion: 0, origin, proposalKey: "quote-draft" };
  assert.deepEqual(candidates.parseCreateOpcBusinessCandidateV2(value), value);
  for (const input of [{ ...value, command: proposal.command }, { ...value, principalId: "forged" }, { ...value, expectedStreamVersion: 1 },
    { ...value, origin: { ...origin, outputDigest: "bad" } }]) assert.throws(() => candidates.parseCreateOpcBusinessCandidateV2(input));
});

test("经营提议严格限制命令和引用，不接收模型计算金额、状态或无来源证据", () => {
  assert.deepEqual(candidates.parseOpcBusinessProposalV2(proposal), proposal);
  for (const value of [{ ...proposal, command: { ...proposal.command, totalMinor: "1" } }, { ...proposal, evidenceRefs: [] },
    { ...proposal, command: { type: "payment.record", paymentId: "p", orderId: "o", amountMinor: "1", receivedOn: "2026-10-10", sourceRef: "invented" } },
    { ...proposal, evidenceRefs: [{ ...source, streamVersion: -1 }] }, { ...proposal, accepted: true }]) assert.throws(() => candidates.parseOpcBusinessProposalV2(value));
});

test("候选决定锁定双版本、正文与预览摘要且不可夹带改动", () => {
  const value = { workspaceId: "w", expectedStreamVersion: 1, expectedBusinessStreamVersion: 3, candidateDigest: "a".repeat(64), previewDigest: "b".repeat(64), decision: "apply" };
  assert.deepEqual(candidates.parseDecideOpcBusinessCandidateV2(value), value);
  for (const input of [{ ...value, command: proposal.command }, { ...value, decision: "confirm" }, { ...value, expectedBusinessStreamVersion: -1 },
    { ...value, previewDigest: "" }]) assert.throws(() => candidates.parseDecideOpcBusinessCandidateV2(input));
});
