export const KEEP_NOTE_COLORS = [
  "coral",
  "peach",
  "sand",
  "mint",
  "sage",
  "fog",
  "storm",
  "dusk",
  "blossom",
] as const;

export type KeepNoteColorId = (typeof KEEP_NOTE_COLORS)[number];

const COLOR_SET = new Set<string>(KEEP_NOTE_COLORS);

export function isKeepNoteColor(value: string): value is KeepNoteColorId {
  return COLOR_SET.has(value);
}

/** PATCH: omitido = não muda; `null` = cor padrão. */
export function parseKeepNoteColor(value: unknown): KeepNoteColorId | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "none" || value === "default") return null;
  if (typeof value === "string" && isKeepNoteColor(value)) return value;
  return undefined;
}

export function parseKeepColorFilter(raw: string[]): Array<KeepNoteColorId | "none"> {
  const out: Array<KeepNoteColorId | "none"> = [];
  for (const item of raw) {
    const v = item.trim().toLowerCase();
    if (!v) continue;
    if (v === "none" || v === "default") {
      if (!out.includes("none")) out.push("none");
      continue;
    }
    if (isKeepNoteColor(v) && !out.includes(v)) out.push(v);
  }
  return out;
}
