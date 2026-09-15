// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { SigV4S3Client } from "../lib/s3-client.mjs";

const client = fetchImplementation => new SigV4S3Client({ endpoint: "https://s3.test", region: "fixture",
  accessKeyId: "fixture", secretAccessKey: "fixture", fetchImplementation });
const listing = (truncated, content = "", token = "") => `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${content}${token}</ListBucketResult>`;
const object = key => `<Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`;

test("S3 list follows continuation tokens and bounds every request", async () => {
  let calls = 0;
  const s3 = client(async (url, init) => {
    assert.ok(init.signal);
    assert.equal(url.searchParams.get("prefix"), "v2/");
    if (++calls === 1) return new Response(listing(true, object("v2/one"), "<NextContinuationToken>a&amp;b</NextContinuationToken>"));
    assert.equal(url.searchParams.get("continuation-token"), "a&b");
    return new Response(listing(false, object("v2/two")));
  });
  assert.deepEqual((await s3.listObjects({ bucket: "fixture", prefix: "v2/" })).map(value => value.key), ["v2/one", "v2/two"]);
  assert.equal(calls, 2);
});

test("S3 list rejects incomplete pages and repeated continuation tokens", async () => {
  for (const xml of ["<Error>fixture</Error>", listing(true), listing(false, object("other/one")),
    listing(false, object("v2/one").replace("2026-01-01T00:00:00Z", "invalid"))]) {
    await assert.rejects(client(async () => new Response(xml)).listObjects({ bucket: "fixture", prefix: "v2/" }));
  }
  let calls = 0;
  await assert.rejects(client(async () => {
    assert.ok(++calls <= 2);
    return new Response(listing(true, "", "<NextContinuationToken>same</NextContinuationToken>"));
  }).listObjects({ bucket: "fixture", prefix: "v2/" }));
});

test("S3 delete batches at 1000 and treats per-object HTTP 200 errors as failure", async () => {
  const counts = [];
  await client(async (_url, init) => {
    counts.push([...init.body.toString().matchAll(/<Object>/gu)].length);
    return new Response("<DeleteResult/>");
  }).deleteObjects({ bucket: "fixture", keys: Array.from({ length: 1001 }, (_, i) => `v2/${i}`) });
  assert.deepEqual(counts, [1000, 1]);
  let calls = 0;
  await assert.rejects(client(async () => {
    calls++;
    return new Response("<DeleteResult><Error><Code>AccessDenied</Code></Error></DeleteResult>");
  }).deleteObjects({ bucket: "fixture", keys: Array.from({ length: 1001 }, (_, i) => `v2/${i}`) }));
  assert.equal(calls, 1, "unknown deletion results must not be retried");
  for (const xml of ["<DeleteResult>", "<DeleteResult><Deleted/>", "<!DOCTYPE x><DeleteResult/>"]) {
    await assert.rejects(client(async () => new Response(xml)).deleteObjects({ bucket: "fixture", keys: ["v2/one"] }));
  }
});
