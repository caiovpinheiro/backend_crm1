import type { Prisma } from "@prisma/client";

export type KeepMark = { type: string; attrs?: Record<string, unknown> };

export type KeepNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: KeepNode[];
  marks?: KeepMark[];
  text?: string;
};

export type KeepDoc = {
  type: "doc";
  content: KeepNode[];
};

export const EMPTY_DOC: KeepDoc = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export function isKeepDoc(value: unknown): value is KeepDoc {
  if (!value || typeof value !== "object") return false;
  const doc = value as KeepDoc;
  return doc.type === "doc" && Array.isArray(doc.content);
}

export function normalizeDoc(value: unknown): KeepDoc {
  if (isKeepDoc(value) && value.content.length > 0) return value;
  if (isKeepDoc(value)) return EMPTY_DOC;
  return EMPTY_DOC;
}

export function plainTextFromDoc(doc: KeepDoc): string {
  const parts: string[] = [];
  function walk(node: KeepNode) {
    if (node.type === "text" && node.text) parts.push(node.text);
    if (node.content) for (const child of node.content) walk(child);
    if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem" || node.type === "taskItem") {
      parts.push("\n");
    }
  }
  for (const n of doc.content) walk(n);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function asJson(doc: KeepDoc): Prisma.InputJsonValue {
  return doc as unknown as Prisma.InputJsonValue;
}
