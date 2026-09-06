// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync } from "node:crypto";
import { LocalSignedPluginRepository } from "../../host/dist/index.js";
import { createSignedRegistryMetadata, signPluginManifest, sha256Hex } from "../../../packages/plugin-sdk/dist/index.js";

export function signedUiPluginFixture() {
  const root = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const metadata = createSignedRegistryMetadata({ schemaVersion: 1, sequence: 1, issuedAt, expiresAt,
    keys: [{ keyId: "release", publicKeySpki: release.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), notBefore: issuedAt, notAfter: expiresAt }],
    revokedKeys: [], revokedReleases: [],
  }, "root", root.privateKey);
  const packageBytes = Buffer.from("deterministic signed UI fixture");
  const manifest = signPluginManifest({ schemaVersion: 1, id: "research", version: "1.0.0", engineApi: "0.2.0",
    displayName: "研究助手", description: "从插件入口加载研究卡片", entrypoints: { host: "./host.mjs", ui: "./ui.mjs", cli: "./cli.mjs" },
    contributes: { routes: ["research.home"], navigation: ["research.nav"], widgets: [], commands: ["summarize"], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [] },
    permissions: [], dataNamespace: "research", eventSchemas: {}, projections: [], dependencies: [], packageSha256: sha256Hex(packageBytes),
    signature: { algorithm: "Ed25519", keyId: "release", value: "pending" },
    release: { sequence: 1, publishedAt: issuedAt, expiresAt, source: "https://plugins.muniu.example/research/1.0.0" }, license: "Apache-2.0",
  }, release.privateKey);
  const definition = { id: "research", version: "1.0.0", official: false, trustBoundary: "process_equivalent", manifest,
    contributions: { routes: [{ id: "research.home", path: "/plugins/research" }], navigation: [{ id: "research.nav", label: "研究助手", routeId: "research.home" }], widgets: [], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
      commands: [{ id: "summarize", title: "生成研究结果", run: async (input) => ({ outcome: `研究结果：${input.topic}` }) }] },
    surfaces: {
      ui: { pages: [{ routeId: "research.home", title: "研究工作台", cards: [{ title: "生成研究结果", body: "输入主题后生成结果", commandId: "summarize", fields: [{ name: "topic", label: "研究主题", type: "string", required: true }] }] }], widgets: [] },
      cli: { commands: [{ name: "summarize", commandId: "summarize", description: "生成研究结果", fields: [{ name: "topic", type: "string", required: true }] }] },
    },
  };
  return { pluginRepository: new LocalSignedPluginRepository({ metadata, releases: [{ manifest, packageBytes, definition }] }), trustedPluginRoots: [{ keyId: "root", publicKey: root.publicKey }] };
}
