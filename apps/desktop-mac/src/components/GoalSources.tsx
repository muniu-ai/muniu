// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import type { BusinessContextTargetV2, BusinessObjectContextV2, GoalResourceRefV2 } from "@mn/contracts";
import { AgentOsApiError, type AgentOsClient } from "../api";

type Extraction = Awaited<ReturnType<AgentOsClient["assetExtraction"]>>;
type Source = { readonly ref: GoalResourceRefV2; readonly extraction?: Extraction; readonly business?: BusinessObjectContextV2; readonly error?: string };

export function GoalSources({ api, workspaceId, resourceRefs }: {
  readonly api: AgentOsClient; readonly workspaceId: string; readonly resourceRefs: readonly GoalResourceRefV2[];
}) {
  const [sources, setSources] = useState<readonly Source[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [downloading, setDownloading] = useState<string>();
  const sequence = useRef(0);
  const mounted = useRef(true);
  const signature = JSON.stringify(resourceRefs.filter(ref => ref.namespace === "asset" || businessTarget(ref)));
  const refresh = useCallback(async () => {
    const refs = JSON.parse(signature) as readonly GoalResourceRefV2[];
    const request = ++sequence.current;
    setSources([]); setLoading(refs.length > 0);
    const next = await Promise.all(refs.map(async ref => {
      try {
        const target = businessTarget(ref);
        if (target) {
          const business = await api.businessContext(workspaceId, target);
          if (business.sourceRef.resourceId !== ref.resourceId || business.sourceRef.streamVersion !== ref.streamVersion || business.sourceRef.digest !== ref.digest) return { ref, error: "资料版本已变化，请重新关联并审阅任务计划。" };
          return { ref, business };
        }
        const extraction = await api.assetExtraction(ref.resourceId);
        if (extraction.assetRef.resourceId !== ref.resourceId || extraction.assetRef.streamVersion !== ref.streamVersion || extraction.assetRef.digest !== ref.digest) {
          return { ref, error: "资料版本已变化，请重新关联并审阅任务计划。" };
        }
        return { ref, extraction };
      } catch (caught) { return { ref, error: sourceError(caught) }; }
    }));
    if (mounted.current && request === sequence.current) { setSources(next); setLoading(false); }
  }, [api, signature, workspaceId]);
  useEffect(() => {
    mounted.current = true; void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = api.watchWorkspaceEvents(workspaceId, () => {
      sequence.current += 1;
      setSources([]); setLoading(signature !== "[]");
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 150);
    });
    return () => { mounted.current = false; sequence.current += 1; stop(); if (timer) clearTimeout(timer); };
  }, [api, workspaceId, refresh]);

  async function download(source: Source) {
    if (!source.extraction || downloading) return;
    const request = sequence.current;
    setDownloading(source.ref.resourceId);
    try {
      const content = await api.assetContent(source.ref.resourceId);
      if (!mounted.current || request !== sequence.current) return;
      const url = URL.createObjectURL(content);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = source.extraction.fileName; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (caught) {
      if (mounted.current && request === sequence.current) setSources(items => items.map(item => item.ref.resourceId === source.ref.resourceId ? { ref: item.ref, error: sourceError(caught) } : item));
    } finally { if (mounted.current) setDownloading(undefined); }
  }

  if (signature === "[]") return null;
  return <section aria-label="任务资料来源"><h3>资料与来源</h3><p>解析结果用于核对提取内容，不代表模型已阅读全部原文。资料版本固定，读取时重新检查权限。</p>
    {loading && <p role="status">正在核对资料来源…</p>}
    {sources.map(source => <article className="goal-output" key={`${source.ref.namespace}:${source.ref.resourceId}`}>
      {source.business ? <>
        <strong>{source.business.title}</strong><p>事实版本 {source.ref.streamVersion} · 业务事实以经营记录为准。</p>
        <button type="button" className="secondary-button" aria-label={`查看业务资料：${source.business.title}`} onClick={() => setPreview(current => current === source.ref.resourceId ? undefined : source.ref.resourceId)}>查看业务资料</button>
        {preview === source.ref.resourceId && <pre className="goal-preview">{source.business.content}</pre>}
      </> : source.extraction ? <>
        <strong>{source.extraction.fileName}</strong><span className="pill">{source.extraction.status === "complete" ? "已解析" : source.extraction.status === "partial" ? "部分解析" : "无法读取"}</span>
        <p>版本 {source.ref.streamVersion} · {source.extraction.blocks.length} 个文字片段</p>
        {source.extraction.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}
        <div className="goal-actions"><button type="button" className="secondary-button" aria-label={`查看摘录：${source.extraction.fileName}`} onClick={() => setPreview(current => current === source.ref.resourceId ? undefined : source.ref.resourceId)}>查看摘录</button>
          <button type="button" className="secondary-button" aria-label={`下载原文：${source.extraction.fileName}`} disabled={Boolean(downloading)} onClick={() => void download(source)}>{downloading === source.ref.resourceId ? "正在读取…" : "下载原文"}</button></div>
        {preview === source.ref.resourceId && <div>{source.extraction.blocks.slice(0, 20).map(block => <div key={block.id}><small>{sourceLocation(block.locator)}</small><pre className="goal-preview">{block.text}</pre></div>)}
          {source.extraction.blocks.length > 20 && <p>此处仅展示前 20 个片段，可下载原文核对其余内容。</p>}</div>}
      </> : <p role="alert">{source.error}<button type="button" className="quiet-button" onClick={() => void refresh()}>重新核对资料</button></p>}
    </article>)}
  </section>;
}

export function sourceLocation(locator: Extraction["blocks"][number]["locator"]): string {
  return [locator.part, locator.sheet && `工作表 ${locator.sheet}`, locator.page && `第 ${locator.page} 页`,
    locator.paragraph && `第 ${locator.paragraph} 段`, locator.cell && `单元格 ${locator.cell}`,
    !locator.cell && locator.row && `第 ${locator.row} 行`, !locator.cell && locator.column && `第 ${locator.column} 列`].filter(Boolean).join(" · ") || "原文片段";
}
function sourceError(error: unknown): string {
  return error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : "资料暂不可用，请检查来源和读取权限后重试。";
}

function businessTarget(ref: GoalResourceRefV2): BusinessContextTargetV2 | undefined {
  const kind = ref.namespace.replace("opc.business.", "");
  if (ref.namespace === `opc.business.${kind}` && ["customer", "order", "delivery", "review"].includes(kind)) return { kind: kind as BusinessContextTargetV2["kind"], resourceId: ref.resourceId };
  return undefined;
}
