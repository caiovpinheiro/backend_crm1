/**
 * Corrige notas do Bwipo Keeps importadas do Google Keep que ficaram com
 * entidades HTML nomeadas literais no texto (`curr&iacute;culo`, `voc&ecirc;`,
 * `aten&ccedil;&atilde;o`). O decodificador do import só tratava um conjunto
 * mínimo de entidades; a correção em src/services/keeps/html.ts resolve os
 * imports futuros e este script reprocessa o que já está no banco.
 *
 * Reescreve `title`, `content` (texto dos nós TipTap) e `plainText`.
 *
 * Uso:
 *   node scripts/fix-keep-html-entities.mjs            # dry-run
 *   node scripts/fix-keep-html-entities.mjs --apply    # grava
 *   node scripts/fix-keep-html-entities.mjs --org=<organizationId>
 *
 * Requer DATABASE_URL no ambiente ou em .env.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "pg";

if (!process.env.DATABASE_URL && existsSync(".env")) {
  const m = readFileSync(".env", "utf8").match(/^DATABASE_URL=(.+)$/m);
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, "");
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL ausente");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const orgArg = process.argv.find((a) => a.startsWith("--org="));
const ORG = orgArg ? orgArg.slice("--org=".length) : null;

const NAMED = {
  nbsp: "\u00a0", iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥", brvbar: "¦", sect: "§",
  uml: "¨", copy: "©", ordf: "ª", laquo: "«", not: "¬", shy: "\u00ad", reg: "®", macr: "¯",
  deg: "°", plusmn: "±", sup2: "²", sup3: "³", acute: "´", micro: "µ", para: "¶", middot: "·",
  cedil: "¸", sup1: "¹", ordm: "º", raquo: "»", frac14: "¼", frac12: "½", frac34: "¾", iquest: "¿",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", times: "×",
  Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ", szlig: "ß",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", divide: "÷",
  oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ", yuml: "ÿ",
  OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200c", zwj: "\u200d", lrm: "\u200e", rlm: "\u200f",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  dagger: "†", Dagger: "‡", bull: "•", hellip: "…", permil: "‰", prime: "′", Prime: "″",
  lsaquo: "‹", rsaquo: "›", oline: "‾", euro: "€", trade: "™", larr: "←", uarr: "↑", rarr: "→", darr: "↓",
  harr: "↔", hearts: "♥", apos: "'", quot: '"', lt: "<", gt: ">",
};

function decode(s) {
  return s
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,7});/g, (m, name) => (name === "amp" ? m : NAMED[name] ?? m))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/\u00a0/g, " ");
}

function walkDoc(node) {
  let changed = false;
  if (node && typeof node === "object") {
    if (node.type === "text" && typeof node.text === "string") {
      const t = decode(node.text);
      if (t !== node.text) {
        node.text = t;
        changed = true;
      }
    }
    if (Array.isArray(node.content)) for (const c of node.content) changed = walkDoc(c) || changed;
  }
  return changed;
}

// Espelho de plainTextFromDoc (src/services/keeps/doc.ts)
function plainText(doc) {
  const parts = [];
  function walk(node) {
    if (node.type === "taskItem") parts.push(node.attrs?.checked ? "☑ " : "☐ ");
    else if (node.type === "listItem") parts.push("• ");
    if (node.type === "text" && node.text) parts.push(node.text);
    if (node.content) for (const child of node.content) walk(child);
    if (["paragraph", "heading", "listItem", "taskItem"].includes(node.type)) parts.push("\n");
  }
  for (const n of doc.content ?? []) walk(n);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

const dbUrl = new URL(process.env.DATABASE_URL);
const sslmode = dbUrl.searchParams.get("sslmode");
dbUrl.searchParams.delete("sslmode");
dbUrl.searchParams.delete("sslaccept");
const db = new Client({
  connectionString: dbUrl.toString(),
  ssl: sslmode && sslmode !== "disable" ? { rejectUnauthorized: false } : false,
});
await db.connect();

const params = [];
let where = `source = 'google_keep_html' AND (title ~ '&[a-zA-Z#][a-zA-Z0-9]*;' OR content::text ~ '&[a-zA-Z#][a-zA-Z0-9]*;')`;
if (ORG) {
  params.push(ORG);
  where += ` AND "organizationId" = $1`;
}
const { rows } = await db.query(
  `SELECT id, "organizationId", title, content FROM keep_notes WHERE ${where} ORDER BY "createdAt"`,
  params,
);
console.log(`${APPLY ? "APLICANDO" : "DRY-RUN"} — ${rows.length} nota(s) com entidades HTML`);

let fixed = 0;
for (const r of rows) {
  const doc = r.content;
  const title = decode(r.title ?? "");
  const docChanged = walkDoc(doc);
  const titleChanged = title !== r.title;
  if (!docChanged && !titleChanged) continue;
  fixed++;
  const pt = plainText(doc);
  console.log(`- ${r.id} [${r.organizationId}] "${r.title}" → "${title}"`);
  console.log(`    ${pt.slice(0, 120).replace(/\n/g, " | ")}`);
  if (APPLY) {
    await db.query(
      `UPDATE keep_notes SET title = $1, content = $2::jsonb, "plainText" = $3, "updatedAt" = now() WHERE id = $4`,
      [title, JSON.stringify(doc), pt, r.id],
    );
  }
}
console.log(`${APPLY ? "corrigidas" : "a corrigir"}: ${fixed}`);
await db.end();
