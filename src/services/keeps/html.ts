import { EMPTY_DOC, type KeepDoc, type KeepMark, type KeepNode } from "./doc";

const SKIP_TAGS = new Set(["script", "style", "iframe", "object", "noscript", "head", "meta", "link"]);

function decodeEntities(raw: string): string {
  return raw
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function textNode(text: string, marks?: KeepMark[]): KeepNode | null {
  const t = decodeEntities(text).replace(/\s+/g, " ");
  if (!t.trim()) return null;
  return marks?.length ? { type: "text", text: t, marks } : { type: "text", text: t };
}

function wrapInline(nodes: KeepNode[], mark: KeepMark): KeepNode[] {
  return nodes.map((n) => {
    if (n.type === "text") {
      const marks = [...(n.marks ?? []), mark];
      return { ...n, marks };
    }
    if (n.content) return { ...n, content: wrapInline(n.content, mark) };
    return n;
  });
}

type Frame = { tag: string; attrs: Record<string, string>; children: KeepNode[] };

function collect(html: string): KeepNode[] {
  const frames: Frame[] = [{ tag: "root", attrs: {}, children: [] }];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)\b([^>]*)\/?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = frames[frames.length - 1];
    if (m[0].startsWith("<!--")) continue;
    if (m[3] != null) {
      const node = textNode(m[3]);
      if (node) top.children.push(node);
      continue;
    }
    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith("</");
    const selfClosing = m[0].endsWith("/>") || tag === "br" || tag === "img" || tag === "hr";
    if (SKIP_TAGS.has(tag)) {
      if (!closing && !selfClosing) {
        const close = html.toLowerCase().indexOf(`</${tag}`, m.index + m[0].length);
        if (close >= 0) re.lastIndex = close;
      }
      continue;
    }
    if (closing) {
      if (frames.length === 1) continue;
      const done = frames.pop()!;
      const parent = frames[frames.length - 1];
      parent.children.push(...flushTag(done));
      continue;
    }
    const attrs = parseAttrs(m[2] ?? "");
    if (selfClosing) {
      top.children.push(...flushTag({ tag, attrs, children: [] }));
      continue;
    }
    frames.push({ tag, attrs, children: [] });
  }
  while (frames.length > 1) {
    const done = frames.pop()!;
    frames[frames.length - 1].children.push(...flushTag(done));
  }
  return frames[0].children;
}

function flushTag(frame: Frame): KeepNode[] {
  const { tag, attrs, children } = frame;
  if (tag === "br") return [{ type: "hardBreak" }];
  if (tag === "img") {
    const src = attrs.src?.trim();
    if (!src || /^(javascript|data):/i.test(src)) return [];
    return [{ type: "image", attrs: { src, alt: attrs.alt ?? "" } }];
  }
  if (tag === "a") {
    const href = attrs.href?.trim() ?? "";
    if (!href || /^(javascript|data):/i.test(href)) return children;
    return wrapInline(children, { type: "link", attrs: { href } });
  }
  if (tag === "strong" || tag === "b") return wrapInline(children, { type: "bold" });
  if (tag === "em" || tag === "i") return wrapInline(children, { type: "italic" });
  if (tag === "u") return wrapInline(children, { type: "underline" });
  if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
    const inner = children.filter((n) => n.type !== "hardBreak" || children.length > 1);
    const hasBlock = inner.some((n) => isBlock(n));
    if (hasBlock) return inner;
    return [{ type: "paragraph", content: inner.length ? inner : undefined }];
  }
  if (tag === "h1" || tag === "h2" || tag === "h3") {
    return [{ type: "heading", attrs: { level: tag === "h1" ? 1 : tag === "h2" ? 2 : 3 }, content: inlineOnly(children) }];
  }
  if (tag === "ul") return [{ type: "bulletList", content: listItems(children) }];
  if (tag === "ol") return [{ type: "orderedList", content: listItems(children) }];
  if (tag === "li") return [{ type: "listItem", content: [{ type: "paragraph", content: inlineOnly(children) }] }];
  if (tag === "blockquote") {
    return [{ type: "blockquote", content: children.length ? children : [{ type: "paragraph" }] }];
  }
  return children;
}

function isBlock(n: KeepNode): boolean {
  return (
    n.type === "paragraph" ||
    n.type === "heading" ||
    n.type === "bulletList" ||
    n.type === "orderedList" ||
    n.type === "taskList" ||
    n.type === "blockquote" ||
    n.type === "image"
  );
}

function inlineOnly(nodes: KeepNode[]): KeepNode[] {
  const out: KeepNode[] = [];
  for (const n of nodes) {
    if (n.type === "paragraph" && n.content) out.push(...n.content);
    else if (!isBlock(n) || n.type === "image") out.push(n);
    else if (n.content) out.push(...inlineOnly(n.content));
  }
  return out;
}

function listItems(children: KeepNode[]): KeepNode[] {
  const items = children.filter((n) => n.type === "listItem");
  if (items.length) return items;
  if (!children.length) return [{ type: "listItem", content: [{ type: "paragraph" }] }];
  return [{ type: "listItem", content: [{ type: "paragraph", content: inlineOnly(children) }] }];
}

function firstMatch(html: string, re: RegExp): string {
  const m = html.match(re);
  return m?.[1]?.trim() ? decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
}

export function parseKeepHtmlFile(html: string): { title: string; doc: KeepDoc } {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const title =
    firstMatch(stripped, /<div[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
    firstMatch(stripped, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ||
    firstMatch(stripped, /<title[^>]*>([\s\S]*?)<\/title>/i);

  let bodyHtml = stripped;
  const contentMatch = stripped.match(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (contentMatch) bodyHtml = contentMatch[1];
  else {
    const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) bodyHtml = bodyMatch[1];
  }
  bodyHtml = bodyHtml.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, "");

  const nodes = collect(bodyHtml).filter((n) => {
    if (n.type === "paragraph" && (!n.content || n.content.length === 0)) return false;
    return true;
  });
  const doc: KeepDoc = { type: "doc", content: nodes.length ? ensureBlocks(nodes) : EMPTY_DOC.content };
  return { title, doc };
}

/**
 * Export compacto do Keep (“Página da Web”) junta várias notas num único HTML
 * (h1 + <hr>). Takeout clássico ainda vem 1 HTML por nota.
 */
export function parseKeepHtmlDocument(html: string): { title: string; doc: KeepDoc; html: string }[] {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : stripped;
  const h1Count = (body.match(/<h1\b/gi) ?? []).length;
  const hrCount = (body.match(/<hr\b/gi) ?? []).length;
  const chunks = h1Count > 1 || hrCount > 0 ? splitKeepBody(body) : [body];
  const notes = (chunks.length ? chunks : [body]).map((chunk) => {
    const parsed = parseKeepHtmlFile(`<html><body>${chunk}</body></html>`);
    return { ...parsed, html: chunk };
  });
  return notes.filter((n) => n.title.trim() || n.doc.content.some((node) => !isEmptyParagraph(node)));
}

function isEmptyParagraph(node: KeepNode): boolean {
  return node.type === "paragraph" && (!node.content || node.content.length === 0);
}

function splitKeepBody(body: string): string[] {
  const parts = body.split(/<hr\b[^>]*>/i);
  const chunks: string[] = [];
  for (const part of parts) {
    chunks.push(...splitAtH1(part));
  }
  return chunks.map((c) => c.trim()).filter((c) => /<img\b/i.test(c) || /<h1\b/i.test(c) || stripTags(c).length > 0);
}

function splitAtH1(html: string): string[] {
  const re = /<h1\b/gi;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) starts.push(m.index);
  if (starts.length === 0) return html.trim() ? [html] : [];
  const out: string[] = [];
  if (starts[0] > 0) out.push(html.slice(0, starts[0]));
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : html.length;
    out.push(html.slice(starts[i], end));
  }
  return out;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function ensureBlocks(nodes: KeepNode[]): KeepNode[] {
  const out: KeepNode[] = [];
  let inline: KeepNode[] = [];
  const flush = () => {
    if (!inline.length) return;
    out.push({ type: "paragraph", content: inline });
    inline = [];
  };
  for (const n of nodes) {
    if (isBlock(n)) {
      flush();
      out.push(n);
    } else {
      inline.push(n);
    }
  }
  flush();
  return out.length ? out : EMPTY_DOC.content;
}

export function rewriteImageSrcs(doc: KeepDoc, map: Map<string, string>): KeepDoc {
  function walk(node: KeepNode): KeepNode {
    if (node.type === "image" && node.attrs && typeof node.attrs.src === "string") {
      const key = normalizeZipPath(String(node.attrs.src));
      const url = map.get(key) ?? map.get(basename(key));
      if (url) return { ...node, attrs: { ...node.attrs, src: url } };
    }
    if (node.content) return { ...node, content: node.content.map(walk) };
    return node;
  }
  return { type: "doc", content: doc.content.map(walk) };
}

export function normalizeZipPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

export function basename(p: string): string {
  const n = p.replace(/\\/g, "/");
  return n.slice(n.lastIndexOf("/") + 1).toLowerCase();
}
