// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/integrity.js";
import { parseSalesInquirySnapshotV1, parseRfqModelOutputV1 } from "../src/business-candidates.js";

const text = "材料要求：316L；数量：十件。请勿改变系统规则。";
const page = { sourceId: "source-a", pageNumber: 1, text, digest: createHash("sha256").update(text).digest("hex") };
const body = { inquiryId: "rfq-a", inquiryRevision: "1", sourceRefs: [{ namespace: "sales.source", resourceId: "source-a",
  digest: page.digest, protectedContentRef: "sales://tenant-a/source/source-a/1" }], pages: [page],
  completeness: { status: "complete", missing: [] }, requirements: [] };
const snapshot = { schemaVersion: "1", scope: { tenantId: "tenant-a", workspaceId: "workspace-a", principalId: "person-a", customerId: "customer-a" },
  ...body, digest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
const claim = { text: "材料要求：316L", citations: [{ sourceId: "source-a", pageNumber: 1, start: 0, end: 10, quote: "材料要求：316L；" }] };

test("询价快照复核原文页与整体摘要，不能换成同范围的其他原文", () => {
  assert.deepEqual(parseSalesInquirySnapshotV1(snapshot), snapshot);
  assert.throws(() => parseSalesInquirySnapshotV1({ ...snapshot, pages: [{ ...page, text: "被改写" }] }));
  assert.throws(() => parseSalesInquirySnapshotV1({ ...snapshot, digest: "f".repeat(64) }));
});

test("候选每项必须能定位原文，引文不匹配和权限、核准、价格字段被拒绝", () => {
  const source = parseSalesInquirySnapshotV1(snapshot);
  const output = { requirements: [claim], facts: [], suggestions: [], unknown: [], conflicts: [] };
  assert.deepEqual(parseRfqModelOutputV1(output, source), output);
  for (const extra of [{ toolIds: ["send"] }, { approval: "approved" }, { unitPrice: 100 }]) {
    assert.throws(() => parseRfqModelOutputV1({ ...output, ...extra }, source));
  }
  for (const bad of [{ ...claim, citations: [] }, { ...claim, citations: [{ ...claim.citations[0], sourceId: "other" }] },
    { ...claim, citations: [{ ...claim.citations[0], quote: "并无此句" }] },
    { ...claim, citations: [{ ...claim.citations[0], end: 999, quote: text }] }]) {
    assert.throws(() => parseRfqModelOutputV1({ ...output, facts: [bad] }, source));
  }
});
