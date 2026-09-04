// SPDX-License-Identifier: Apache-2.0

import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import {
  SafePublicWebReader,
  type PinnedHttpRequest,
  type PinnedHttpResponse,
  type PublicWebReaderDependencies,
} from "./web-read.js";

export function createNodePublicWebReader(
  options: Omit<PublicWebReaderDependencies, "dnsLookup" | "request"> = {},
): SafePublicWebReader {
  return new SafePublicWebReader({
    ...options,
    dnsLookup: async (hostname) => (await lookup(hostname, { all: true, verbatim: true }))
      .map((record) => record.address),
    request: requestPinnedNodeHttp,
  });
}

/**
 * 传输层只连接安全层已经核对过的第一个地址。禁用连接池，避免跨请求复用
 * 旧 DNS 连接；TLS SNI 与 Host 仍使用原始域名。
 */
export async function requestPinnedNodeHttp(
  input: PinnedHttpRequest,
): Promise<PinnedHttpResponse> {
  const target = new URL(input.url);
  const address = input.resolvedAddresses[0];
  const family = address ? isIP(address) : 0;
  if (!address || (family !== 4 && family !== 6)) {
    throw new TypeError("固定连接地址无效");
  }
  const request = target.protocol === "https:" ? requestHttps : requestHttp;
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError("只允许 HTTP 或 HTTPS 请求");
  }
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  return new Promise<PinnedHttpResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const outgoing = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: input.method,
      path: `${target.pathname}${target.search}`,
      headers: input.headers,
      agent: false,
      lookup: pinnedLookup,
    }, (incoming) => {
      if (settled) {
        incoming.destroy();
        return;
      }
      settled = true;
      const headers = Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(", ") : value,
      ]));
      resolve({
        status: incoming.statusCode ?? 0,
        headers,
        body: incoming,
        remoteAddress: incoming.socket.remoteAddress ?? "",
        discard: () => { incoming.destroy(); },
      });
    });
    outgoing.once("error", fail);
    outgoing.setTimeout(input.timeoutMs, () => outgoing.destroy(new Error("网页请求超时")));
    const abort = () => outgoing.destroy(new Error("网页请求已取消"));
    input.signal.addEventListener("abort", abort, { once: true });
    outgoing.once("close", () => input.signal.removeEventListener("abort", abort));
    if (input.signal.aborted) abort();
    else outgoing.end();
  });
}
