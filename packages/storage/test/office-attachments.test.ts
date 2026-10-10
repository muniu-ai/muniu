// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAttachments } from "../src/attachments.js";

test("Office attachments require DOCX/XLSX extensions and ZIP or encrypted-container signatures", () => {
  for (const [extension, mediaType] of [
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ] as const) {
    for (const bytes of [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]) {
      assert.equal(validateAttachments([{ fileName: `source.${extension}`, mediaType, bytes }]).attachments.length, 1);
    }
    assert.throws(() => validateAttachments([{ fileName: `source.${extension}`, mediaType, bytes: Buffer.from("fake") }]), /does not match/);
    assert.throws(() => validateAttachments([{ fileName: "macro.docm", mediaType, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }]), /extension/);
  }
});
