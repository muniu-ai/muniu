// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { businessDateAt } from "../src/business-calendar.js";

test("经营日期按北京时间跨日，审计时间仍可使用 UTC", () => {
  assert.equal(businessDateAt("2026-10-08T15:59:59.999Z"), "2026-10-08");
  assert.equal(businessDateAt("2026-10-08T16:00:00.000Z"), "2026-10-09");
  assert.equal(businessDateAt("2026-12-31T16:00:00.000Z"), "2027-01-01");
  assert.throws(() => businessDateAt("not-a-date"), RangeError);
});
