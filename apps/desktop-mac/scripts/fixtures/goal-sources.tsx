// SPDX-License-Identifier: Apache-2.0
import { createRoot } from "react-dom/client";
import { GoalSources } from "../../src/components/GoalSources";
import type { AgentOsClient } from "../../src/api";
import "../../src/styles.css";

const assetRef = { namespace: "asset", resourceId: "source", streamVersion: 1, digest: "source-digest" };
const extraction = { assetRef, fileName: "来源.md", mediaType: "text/markdown", status: "complete", extractorVersion: "1", textDigest: "text-digest",
  blocks: [{ id: "block-1", text: "仅限获准期间读取的正文", locator: { paragraph: 1 } }], issues: [] };
let revoked = false, holdExtraction = false, holdDownload = false;
let listener: (() => void) | undefined;
let extractionReply: (() => void) | undefined, downloadReply: (() => void) | undefined;
const driver = {
  extractions: 0, downloads: 0, emittedDownloads: 0,
  event() { listener?.(); }, revoke() { revoked = true; listener?.(); },
  delayExtraction() { holdExtraction = true; listener?.(); }, delayDownload() { holdDownload = true; },
  releaseExtraction() { extractionReply?.(); }, releaseDownload() { downloadReply?.(); },
};
Object.assign(window, { sourcesDriver: driver });
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = value => { driver.emittedDownloads += 1; return createObjectURL(value); };
const api = {
  watchWorkspaceEvents(_workspace: string, change: () => void) { listener = change; return () => { listener = undefined; }; },
  async assetExtraction() {
    driver.extractions += 1;
    if (revoked) throw new Error("SOURCE_REVOKED");
    if (holdExtraction) { holdExtraction = false; await new Promise<void>(resolve => { extractionReply = resolve; }); }
    return extraction;
  },
  async assetContent() {
    driver.downloads += 1;
    if (revoked) throw new Error("SOURCE_REVOKED");
    if (holdDownload) await new Promise<void>(resolve => { downloadReply = resolve; });
    return new Blob(["仅限获准期间读取的正文"], { type: "text/markdown" });
  },
} as unknown as AgentOsClient;
createRoot(document.getElementById("root")!).render(<GoalSources api={api} workspaceId="workspace" resourceRefs={[assetRef]} />);
