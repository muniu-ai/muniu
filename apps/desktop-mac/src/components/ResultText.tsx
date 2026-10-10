// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";

/** Render a small, inert Markdown subset. HTML and remote media remain text. */
export function ResultText({ text }: { readonly text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const key = index;
    if (!line.trim()) { index++; continue; }
    if (/^```/u.test(line)) {
      const code: string[] = []; index++;
      while (index < lines.length && !/^```/u.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index++;
      blocks.push(<pre key={key}><code>{code.join("\n")}</code></pre>); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) { blocks.push(<h4 key={key}>{inline(heading[2]!)}</h4>); index++; continue; }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*\|/u.test(lines[index + 1] ?? "")) {
      const cells = (value: string) => value.trim().replace(/^\||\|$/gu, "").split("|").map(cell => cell.trim());
      const headers = cells(line), rows: string[][] = []; index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) rows.push(cells(lines[index++]!));
      blocks.push(<div className="result-table" key={key}><table><thead><tr>{headers.map((cell, i) => <th key={i}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (/^\s*[-*+]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/u.test(lines[index]!)) items.push(lines[index++]!.replace(/^\s*[-*+]\s+/u, ""));
      blocks.push(<ul key={key}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>); continue;
    }
    blocks.push(<p key={key}>{inline(line)}</p>); index++;
  }
  return <div className="result-text">{blocks}</div>;
}
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/gu).map((part, index) => part.startsWith("**") && part.endsWith("**")
    ? <strong key={index}>{part.slice(2, -2)}</strong> : part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part);
}
