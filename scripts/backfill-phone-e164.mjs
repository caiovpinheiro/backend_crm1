/**
 * Backfill de telefones dos contatos para o formato E.164 (`+55DD...`).
 *
 * Contexto: até 2026-07 o telefone era gravado em formatos inconsistentes
 * (webhook gravava `+55...`, importações gravavam o valor cru tipo
 * `11987654321` ou `(11) 98765-4321`). O matching de deduplicação agora usa
 * `phoneMatchVariants` (variantes E.164 com/sem 9º dígito) num
 * `where: { phone: { in: [...] } }`, que só encontra registros já gravados em
 * E.164. Este script padroniza a base existente para que o matching pegue os
 * contatos legados.
 *
 * NÃO faz merge de duplicados — apenas normaliza o FORMATO. Ao final, lista
 * grupos de contatos que passaram a ter o MESMO telefone normalizado (dentro
 * da mesma org), para uma limpeza manual/posterior decidir o que fazer.
 *
 * Idempotente: rodar de novo não muda nada depois de aplicado.
 *
 * Uso:
 *   node scripts/backfill-phone-e164.mjs            # dry-run (não grava nada)
 *   node scripts/backfill-phone-e164.mjs --apply    # aplica as mudanças
 *   TARGET_ORG_ID=<org> node scripts/backfill-phone-e164.mjs [--apply]
 *
 * Requer DATABASE_URL no ambiente (mesma do backend).
 */
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

const APPLY = process.argv.includes("--apply");
const TARGET_ORG = process.env.TARGET_ORG_ID ?? null;

// ── normalizePhone: espelho de src/lib/phone.ts (mantido em sincronia) ──────
const E164_RE = /^\+\d{7,15}$/;

function strip(raw) {
  return raw.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
}

function normalizeBrLocal(local) {
  if (local.length === 11 || local.length === 10) return `+55${local}`;
  return null;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const s = strip(String(raw).trim());
  if (!s) return null;
  if (E164_RE.test(s)) return s;
  const digits = s.startsWith("+") ? s.slice(1) : s;
  if (digits.startsWith("55")) return normalizeBrLocal(digits.slice(2));
  if (digits.length === 10 || digits.length === 11) return normalizeBrLocal(digits);
  if (digits.length >= 7 && digits.length <= 15) {
    const candidate = `+${digits}`;
    return E164_RE.test(candidate) ? candidate : null;
  }
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────
const c = new Client(pgConnectionConfig());
await c.connect();

const orgFilter = TARGET_ORG ? `AND "organizationId" = '${TARGET_ORG}'` : "";
const { rows } = await c.query(
  `SELECT id, "organizationId", phone
     FROM contacts
    WHERE phone IS NOT NULL AND phone <> ''
      ${orgFilter}`,
);

console.log(
  `Modo: ${APPLY ? "APPLY (grava)" : "DRY-RUN (não grava)"}${TARGET_ORG ? ` | org=${TARGET_ORG}` : ""}`,
);
console.log(`Contatos com telefone: ${rows.length}`);

let changed = 0;
let unchanged = 0;
let notNormalizable = 0;
// Chave "org|normalizedPhone" -> lista de ids (para detectar duplicados).
const byNormalized = new Map();

for (const r of rows) {
  const normalized = normalizePhone(r.phone);
  if (!normalized) {
    notNormalizable++;
    console.warn(`  ! não normalizável: contact=${r.id} phone=${JSON.stringify(r.phone)}`);
    continue;
  }

  const key = `${r.organizationId}|${normalized}`;
  if (!byNormalized.has(key)) byNormalized.set(key, []);
  byNormalized.get(key).push(r.id);

  if (normalized === r.phone) {
    unchanged++;
    continue;
  }

  changed++;
  if (APPLY) {
    await c.query(`UPDATE contacts SET phone = $1, "updatedAt" = now() WHERE id = $2`, [
      normalized,
      r.id,
    ]);
  } else {
    console.log(`  ~ ${r.id}: ${JSON.stringify(r.phone)} -> ${normalized}`);
  }
}

const duplicates = [...byNormalized.entries()].filter(([, ids]) => ids.length > 1);

console.log("");
console.log("── Resumo ──────────────────────────────────────────");
console.log(`  Normalizados (mudariam/mudaram): ${changed}`);
console.log(`  Já em E.164 (sem mudança):       ${unchanged}`);
console.log(`  Não normalizáveis:               ${notNormalizable}`);
console.log(`  Grupos de duplicados (mesmo telefone normalizado na org): ${duplicates.length}`);

if (duplicates.length > 0) {
  console.log("");
  console.log("── Duplicados detectados (NÃO mesclados por este script) ──");
  for (const [key, ids] of duplicates.slice(0, 50)) {
    const [org, phone] = key.split("|");
    console.log(`  org=${org} phone=${phone} -> ${ids.length} contatos: ${ids.join(", ")}`);
  }
  if (duplicates.length > 50) {
    console.log(`  ... e mais ${duplicates.length - 50} grupos.`);
  }
}

if (!APPLY) {
  console.log("");
  console.log("Dry-run: nada foi gravado. Rode com --apply para aplicar.");
}

await c.end();
