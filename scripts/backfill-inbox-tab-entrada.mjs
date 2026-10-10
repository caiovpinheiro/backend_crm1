/**
 * Backfill de `inbox:tab:entrada` nas roles preset MEMBER (Operador).
 *
 * A fila Entrada reúne as conversas ainda sem atendimento humano —
 * atribuídas ou não, já que a distribuição acontece antes do primeiro
 * contato. Sem essa chave o operador não enxerga as próprias conversas
 * recém-distribuídas (elas só apareceriam depois que alguém respondesse).
 * O recorte entre "só as minhas" e a fila inteira é o toggle do header
 * da Inbox (`?mine=1`), não a permissão.
 *
 * Só toca roles que JÁ tenham alguma chave `inbox:tab:*`: quando a role
 * não tem nenhuma, o backend cai no fallback legado (esperando +
 * respondidas via `conversation:view`) — inserir uma única chave ligaria
 * o modo explícito e apagaria as outras abas.
 *
 * Idempotente. Uso: DATABASE_URL=... node scripts/backfill-inbox-tab-entrada.mjs
 */
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

const KEY = "inbox:tab:entrada";

const c = new Client(pgConnectionConfig());
await c.connect();

const rows = await c.query(
  `SELECT id, "organizationId", name, permissions
     FROM roles
    WHERE "systemPreset" = 'MEMBER'
      AND NOT ($1 = ANY(permissions))
      AND EXISTS (
        SELECT 1 FROM unnest(permissions) p WHERE p LIKE 'inbox:tab:%'
      )`,
  [KEY],
);

let updated = 0;
for (const r of rows.rows) {
  await c.query(
    `UPDATE roles SET permissions = array_append(permissions, $1) WHERE id = $2`,
    [KEY, r.id],
  );
  updated++;
  console.log(`+ ${r.name} (org ${r.organizationId}) — ${KEY}`);
}

const skipped = await c.query(
  `SELECT count(*)::int AS n
     FROM roles
    WHERE "systemPreset" = 'MEMBER'
      AND NOT ($1 = ANY(permissions))
      AND NOT EXISTS (
        SELECT 1 FROM unnest(permissions) p WHERE p LIKE 'inbox:tab:%'
      )`,
  [KEY],
);

console.log(`\n${updated} role(s) atualizada(s).`);
if (skipped.rows[0].n > 0) {
  console.log(
    `${skipped.rows[0].n} role(s) sem nenhuma chave inbox:tab:* — mantidas no ` +
      `fallback legado. Ajuste em Settings → Permissões se quiser Entrada nelas.`,
  );
}
console.log("A cache de authz por usuário expira em ~60s.");

await c.end();
