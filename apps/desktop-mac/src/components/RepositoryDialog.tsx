import { FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentOsApiError, type AgentOsClient } from "../api";
import type { CodingRepositorySummary } from "../types";

interface NativeShell {
  readonly core: { invoke<T>(command: string, args: Readonly<Record<string, unknown>>): Promise<T> };
}

function normalizedPath(value: string) { return value.trim().replace(/\/+$/u, ""); }

export function RepositoryDialog({ api, workspaceId, workspaceName, repositories, open, onClose, onSelected }: {
  readonly api: AgentOsClient;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly repositories: readonly CodingRepositorySummary[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelected: (repository: CodingRepositorySummary) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string>();
  const native = (window as Window & { __TAURI__?: NativeShell }).__TAURI__;
  const pending = busy || choosing;
  const input = normalizedPath(path);
  const valid = input.startsWith("/") && !input.includes("\0");

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  async function chooseFolder() {
    if (!native || pending) return;
    setChoosing(true); setError(undefined);
    try {
      const selected = await native.core.invoke<string | null>("choose_repository_directory", {});
      if (mounted.current && selected) setPath(selected);
    } catch {
      if (mounted.current) setError("无法打开文件夹选择窗口，请手动填写仓库路径。");
    } finally { if (mounted.current) setChoosing(false); }
  }

  async function register() {
    if (pending || !valid) return;
    setBusy(true); setError(undefined);
    try {
      const existing = repositories.find(item => item.workspaceId === workspaceId && normalizedPath(item.rootRealPath) === input);
      // 响应丢失后重试同一路径，沿用原请求的幂等键。
      const key = attempts.current.get(input) ?? crypto.randomUUID();
      attempts.current.set(input, key);
      const repository = existing ?? await api.createCodingRepository(workspaceId, input, key);
      if (!mounted.current) return;
      onSelected(repository);
      setPath(""); onClose();
    } catch (error) {
      if (mounted.current) setError(error instanceof AgentOsApiError
        ? `${error.detail.message}。${error.detail.action}`
        : "未能确认登记结果，请重试；重复提交不会重复登记。");
    } finally { if (mounted.current) setBusy(false); }
  }

  return <dialog ref={dialog} className="repository-dialog" aria-labelledby="repository-dialog-title" aria-describedby="repository-dialog-help"
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <header><div><p className="eyebrow">{workspaceName}</p><h2 id="repository-dialog-title">登记仓库</h2></div><button type="button" className="icon-button" aria-label="关闭登记窗口" disabled={pending} onClick={onClose}><X size={19} /></button></header>
    <p id="repository-dialog-help">选择本机已有的 Git 仓库文件夹，登记后即可用于 Coding 任务。</p>
    <form onSubmit={event => { event.preventDefault(); void register(); }}>
      {native && <button type="button" className="secondary-button repository-folder-button" disabled={pending} onClick={() => void chooseFolder()}><FolderOpen size={19} />{choosing ? "正在选择" : "选择文件夹"}</button>}
      <label className="field"><span>仓库绝对路径</span><input aria-label="仓库绝对路径" value={path} onChange={event => { setPath(event.target.value); setError(undefined); }} placeholder="/Users/你的用户名/Projects/仓库" disabled={pending} spellCheck={false} autoComplete="off" /><small>{native ? "也可以粘贴文件夹的完整路径。" : "粘贴文件夹的完整路径；桌面应用还支持直接选择文件夹。"}</small></label>
      <p className="repository-help">只有远程仓库地址？请先克隆到本机，再选择文件夹。登记只保存路径，执行任务前会检查仓库及访问权限。</p>
      {error && <p className="repository-error" role="alert">{error}</p>}
      <footer><button type="button" className="quiet-button" disabled={pending} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={pending || !valid}>{busy ? "正在登记" : "登记并选中"}</button></footer>
    </form>
  </dialog>;
}
