// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { approvedNodeImage, selectCachedKindNode } from "../lib/kind-node-image.mjs";

test("offline Kind cache must match the config digest of the pinned release", () => {
  const id = "sha256:b1b6ffc307b4d2ac9bd8902aa24a720ff533ffa5b34193c66d7c0f21f2d77ee7";
  assert.equal(selectCachedKindNode(approvedNodeImage, { Id: id, Architecture: "arm64" }), id);
  assert.equal(selectCachedKindNode(approvedNodeImage, undefined), approvedNodeImage);
  assert.throws(() => selectCachedKindNode(approvedNodeImage, { Id: "sha256:" + "0".repeat(64), Architecture: "arm64" }), /digest/);
  assert.throws(() => selectCachedKindNode(approvedNodeImage, { Id: id, Architecture: "amd64" }), /digest/);
  assert.throws(() => selectCachedKindNode("kindest/node:latest", undefined), /pinned/);
});
