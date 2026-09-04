import { useEffect, useMemo, useRef, useState } from "react";
import { Command, FileCheck2, Search, Target, TerminalSquare } from "lucide-react";

export interface PaletteItem {
  readonly id: string;
  readonly kind: "命令" | "机会" | "Coding 任务" | "Skill" | "成果";
  readonly title: string;
  readonly detail?: string;
  readonly action: () => void;
}

const iconByKind = {
  "命令": Command,
  "机会": Target,
  "Coding 任务": TerminalSquare,
  "Skill": Search,
  "成果": FileCheck2,
} as const;

export function CommandPalette({ open, items, onClose }: {
  readonly open: boolean;
  readonly items: readonly PaletteItem[];
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) { setQuery(""); requestAnimationFrame(() => inputRef.current?.focus()); }
  }, [open]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? items.filter((item) => `${item.kind} ${item.title} ${item.detail ?? ""}`.toLocaleLowerCase().includes(needle)) : items;
  }, [items, query]);
  if (!open) return null;
  return <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令中心" onMouseDown={(event) => event.stopPropagation()}>
      <label className="palette-search"><Search size={18} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索命令、机会、任务、Skill 和成果" /></label>
      <div className="palette-results">
        {filtered.map((item) => {
          const Icon = iconByKind[item.kind];
          return <button key={item.id} onClick={() => { item.action(); onClose(); }}><Icon size={17} /><span><strong>{item.title}</strong><small>{item.kind}{item.detail ? ` · ${item.detail}` : ""}</small></span></button>;
        })}
        {filtered.length === 0 && <p className="palette-empty">没有匹配结果</p>}
      </div>
      <footer><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></footer>
    </section>
  </div>;
}
