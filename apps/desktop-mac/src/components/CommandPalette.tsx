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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery(""); setSelectedIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => { cancelAnimationFrame(frame); returnFocus.current?.focus(); };
  }, [open]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? items.filter((item) => `${item.kind} ${item.title} ${item.detail ?? ""}`.toLocaleLowerCase().includes(needle)) : items;
  }, [items, query]);
  const activeIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
  useEffect(() => {
    if (open) document.getElementById(`palette-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);
  if (!open) return null;
  return <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令中心" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (filtered.length) setSelectedIndex((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length);
      }
      if (event.key === "Enter" && event.target === inputRef.current && filtered[activeIndex]) {
        event.preventDefault(); filtered[activeIndex].action(); onClose();
      }
      if (event.key === "Tab") { event.preventDefault(); inputRef.current?.focus(); }
    }}>
      <label className="palette-search"><Search size={18} /><input ref={inputRef} value={query} aria-controls="palette-results" aria-activedescendant={filtered.length ? `palette-option-${activeIndex}` : undefined} onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }} placeholder="搜索命令、机会、任务、Skill 和成果" /></label>
      <div className="palette-results" id="palette-results" role="listbox" aria-label="搜索结果">
        {filtered.map((item, index) => {
          const Icon = iconByKind[item.kind];
          return <button key={item.id} id={`palette-option-${index}`} role="option" aria-selected={index === activeIndex} tabIndex={-1} onMouseMove={() => setSelectedIndex(index)} onClick={() => { item.action(); onClose(); }}><Icon size={17} /><span><strong>{item.title}</strong><small>{item.kind}{item.detail ? ` · ${item.detail}` : ""}</small></span></button>;
        })}
        {filtered.length === 0 && <p className="palette-empty">没有匹配结果</p>}
      </div>
      <footer><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></footer>
    </section>
  </div>;
}
