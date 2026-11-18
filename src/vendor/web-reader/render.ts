// Node-side renderer for Playwright ARIA snapshots.
export interface AriaNode {
  role: string;
  name: string;
  level: number;
  url?: string;
  children: AriaNode[];
  colspan?: number;
  rowspan?: number;
}

function scalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function parseAria(yaml: string): AriaNode {
  const root: AriaNode = { role: "root", name: "", level: 0, children: [] };
  const stack = [{ indent: -1, node: root }];
  for (const line of yaml.split("\n")) {
    const match = line.match(/^(\s*)-\s+(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    let rest = match[2].trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (rest.startsWith("/url:")) {
      stack[stack.length - 1].node.url = scalar(rest.slice(5).trim());
      continue;
    }
    // A whole snapshot key can itself be YAML quoted (not just its name).
    if (rest.endsWith(":") && !/^(text|code):/.test(rest)) rest = rest.slice(0, -1).trim();
    rest = scalar(rest);
    let node: AriaNode;
    const literal = rest.match(/^(text|code):\s*(.*)$/);
    if (literal) {
      node = { role: literal[1], name: scalar(literal[2]), level: 0, children: [] };
    } else {
      const role = rest.match(/^([\w-]+)(?:\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'))?(.*)$/);
      const tail = role?.[3] || "";
      let name = scalar(role?.[2] || "");
      const inline = tail.indexOf(":");
      if (inline !== -1) {
        const text = scalar(tail.slice(inline + 1).trim());
        if (text) name = name ? `${name} ${text}` : text;
      }
      node = {
        role: role?.[1] || rest, name,
        level: Number(tail.match(/\[level=(\d+)\]/)?.[1] || 0), children: [],
      };
      for (const key of ["colspan", "rowspan"] as const) {
        const span = tail.match(new RegExp(`\\b${key}=(\\d+)`));
        if (span) node[key] = Number(span[1]);
      }
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

const CONTAINER = new Set([
  "root", "generic", "main", "section", "article", "group", "region", "navigation",
  "banner", "contentinfo", "complementary", "figure", "figcaption", "form",
  "application", "document", "presentation", "none", "toolbar", "rowgroup",
]);
const SKIP = new Set(["img", "graphic"]);
const CELL = new Set(["cell", "columnheader", "rowheader"]);

export function linkText(url: string | undefined, text: string): string {
  const configured = Number(process.env.DSH_WEBREADER_MAXURL);
  const limit = Number.isFinite(configured) && configured > 0 ? configured : Infinity;
  return url && url.length <= limit ? `[${text}](${url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29")})` : text;
}

function content(node: AriaNode, markdown: boolean): string {
  if (SKIP.has(node.role)) return "";
  const children = node.children.map(c => content(c, markdown)).filter(Boolean).join(" ");
  // Accessible names of ancestors often already concatenate all descendant text.
  const text = children || node.name;
  if (markdown && node.role === "link") return linkText(node.url, text);
  if (markdown && node.role === "code" && text) return `\`${text}\``;
  return text;
}

export function inlineText(node: AriaNode): string { return content(node, true); }

function hasTable(node: AriaNode): boolean {
  return node.children.some(c => c.role === "table" || hasTable(c));
}

export function renderTable(tableNode: AriaNode, out: string[]): void {
  // Layout tables containing tables are structural wrappers. Rendering their
  // aggregate accessible names would duplicate every nested table and link.
  if (hasTable(tableNode)) {
    const visit = (node: AriaNode) => {
      if (node.role === "table") { renderTable(node, out); return; }
      if (node.role === "row" || CELL.has(node.role) || CONTAINER.has(node.role)) {
        if (node.children.length) node.children.forEach(visit);
        else if (CELL.has(node.role) && node.name.trim()) out.push(node.name.trim() + "\n");
      } else renderMarkdown({ role: "root", name: "", level: 0, children: [node] }, out, 0);
    };
    tableNode.children.forEach(visit);
    return;
  }
  const rows: AriaNode[] = [];
  const collect = (node: AriaNode) => {
    if (node.role === "row") rows.push(node);
    else node.children.forEach(collect);
  };
  tableNode.children.forEach(collect);
  const raw = rows.map(row => row.children.filter(c => CELL.has(c.role))).filter(row => row.length);
  if (!raw.length) return;
  // Bound both each dimension and the complete matrix, including hostile spans.
  const maxCols = 256;
  const maxRows = Math.min(raw.length, 10000);
  const budget = 65536;
  const grid: (string | undefined)[][] = [];
  for (let r = 0; r < maxRows; r++) {
    grid[r] ||= [];
    let col = 0;
    for (const cell of raw[r]) {
      while (col < maxCols && grid[r][col] !== undefined) col++;
      if (col >= maxCols || (r + 1) * (col + 1) > budget) break;
      const span = (key: "colspan" | "rowspan", cap: number) => {
        const value = cell[key] ?? Number(cell.name.match(new RegExp(`\\b${key}=(\\d+)`))?.[1] || 1);
        return Math.max(1, Math.min(cap, Number.isFinite(value) ? value : 1));
      };
      const width = span("colspan", Math.min(maxCols - col, Math.floor(budget / (r + 1)) - col));
      const height = span("rowspan", Math.min(maxRows - r, Math.floor(budget / (col + width)) - r));
      let text = inlineText(cell).trim().replace(/\[(?=[^\]]*\b(?:colspan|rowspan)=)[^\]]*\]/g, "").trim();
      text = text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
      grid[r][col] = text;
      for (let dr = 0; dr < height; dr++) {
        grid[r + dr] ||= [];
        for (let dc = 0; dc < width; dc++) {
          if (dr || dc) grid[r + dr][col + dc] ??= dr ? "«" : "»";
        }
      }
      col += width;
    }
  }
  const width = Math.max(0, ...grid.map(row => row.length));
  if (!width) return;
  // Padding sparse rows must stay within the same total-cell budget.
  const height = Math.min(grid.length, Math.floor(budget / width));
  out.push("\n\n");
  for (let r = 0; r < height; r++) {
    const row = Array.from({ length: width }, (_, c) => grid[r]?.[c] || "");
    out.push(`| ${row.join(" | ")} |\n`);
    if (!r) out.push(`| ${row.map(() => "---").join(" | ")} |\n`);
  }
  out.push("\n");
}

export function renderMarkdown(node: AriaNode, out: string[], listDepth: number): void {
  for (const n of node.children) {
    const text = () => inlineText(n).trim();
    switch (n.role) {
      case "heading":
        out.push(`\n\n${"#".repeat(n.level > 0 && n.level <= 6 ? n.level : 2)} ${text()}\n\n`);
        break;
      case "link":
        if (text()) out.push(text() + " ");
        break;
      case "list":
        renderMarkdown(n, out, listDepth); out.push("\n"); break;
      case "listitem": {
        const nested = n.children.filter(c => c.role === "list");
        const body = n.children.filter(c => c.role !== "list").map(inlineText).filter(Boolean).join(" ") || n.name;
        if (body || nested.length) out.push(`\n${"  ".repeat(listDepth)}- ${body.trim()}`);
        nested.forEach(c => renderMarkdown(c, out, listDepth + 1));
        break;
      }
      case "paragraph":
        if (text()) out.push("\n" + text() + "\n");
        break;
      case "table": renderTable(n, out); break;
      case "code": {
        const value = n.name.trim();
        if (value.includes("__PI_NL__") || value.includes("\n")) {
          out.push("\n\n```\n" + value.replace(/\s*__PI_NL__\s*/g, "\n") + "\n```\n\n");
        } else if (value) out.push("`" + value + "` ");
        break;
      }
      case "text": if (n.name.trim()) out.push(n.name.trim() + " "); break;
      case "textbox": if (n.name.trim()) out.push(`[输入框:${n.name.trim()}] `); break;
      case "button": if (n.name.trim()) out.push(`[按钮:${n.name.trim()}] `); break;
      case "separator": out.push("\n\n---\n\n"); break;
      default:
        if (SKIP.has(n.role)) break;
        if (!CONTAINER.has(n.role) && !n.children.length && n.name.trim()) out.push(n.name.trim() + " ");
        renderMarkdown(n, out, listDepth);
    }
  }
}

export function renderText(node: AriaNode, out: string[]): void {
  for (const n of node.children) {
    if (SKIP.has(n.role) || n.role === "textbox" || n.role === "button") continue;
    if (["heading", "paragraph", "text", "code", "link", "listitem"].includes(n.role)) {
      const text = content(n, false).trim();
      if (text) out.push((n.role === "listitem" ? "- " : "") + text + "\n");
    } else if (CELL.has(n.role) && !n.children.length) {
      if (n.name.trim()) out.push(n.name.trim() + "\n");
    } else renderText(n, out);
  }
}

function clean(text: string): string {
  return text.replace(/\s*__PI_NL__\s*/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function ariaToMarkdown(yaml: string): string {
  const out: string[] = []; renderMarkdown(parseAria(yaml), out, 0); return clean(out.join(""));
}
export function ariaToText(yaml: string): string {
  const out: string[] = []; renderText(parseAria(yaml), out); return clean(out.join(""));
}
