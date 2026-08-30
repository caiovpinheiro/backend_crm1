/**
 * Backfill de conversations.firstInboundAt a partir de messages.
 *
 * Semântica A: MIN(createdAt) das inbound públicas (direction=in,
 * isPrivate=false) por conversationId. Não toca lastInboundAt.
 *
 * Lotes de ~5.000 conversas, cursor (createdAt, id), sleep entre lotes.
 * Cada UPDATE é uma transação curta do driver — sem BEGIN envolvendo
 * as 292k linhas.
 *
 * Uso:
 *   pnpm tsx src/scripts/backfill-conversation-first-inbound-at.ts --probe
 *   pnpm tsx src/scripts/backfill-conversation-first-inbound-at.ts --since=2026-08-01 --until=2026-08-08
 *   pnpm tsx src/scripts/backfill-conversation-first-inbound-at.ts --apply --since=... --until=...
 *   pnpm tsx src/scripts/backfill-conversation-first-inbound-at.ts --apply
 *
 * Sem --apply = dry-run (conta o que atualizaria). --probe = só o delta
 * "inbound em messages + lastInboundAt NULL".
 */

import { Prisma } from "@prisma/client";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const BATCH = 5_000;
const DEFAULT_SLEEP_MS = 200;

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseBound(raw: string | null, label: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} inválido: ${raw}`);
  return d;
}

function createdAtFilter(since: Date | null, until: Date | null): Prisma.Sql {
  return Prisma.sql`
    ${since ? Prisma.sql`AND c."createdAt" >= ${since}` : Prisma.empty}
    ${until ? Prisma.sql`AND c."createdAt" < ${until}` : Prisma.empty}
  `;
}

function printProbe(
  title: string,
  rows: Array<{ org_bucket: string; slug: string; channel: string | null; n: bigint }>,
) {
  const total = rows.reduce((acc, r) => acc + Number(r.n), 0);
  console.log(`[firstInboundAt] ${title}: ${total}`);
  const buckets = ["cruzeiro-ead", "dnawork", "resto"] as const;
  for (const bucket of buckets) {
    const subset = rows.filter((r) => r.org_bucket === bucket);
    const subtotal = subset.reduce((acc, r) => acc + Number(r.n), 0);
    if (subtotal === 0) {
      console.log(`  ${bucket}: 0`);
      continue;
    }
    const byChannel = new Map<string, number>();
    const bySlug = new Map<string, number>();
    for (const r of subset) {
      const ch = r.channel ?? "∅";
      byChannel.set(ch, (byChannel.get(ch) ?? 0) + Number(r.n));
      bySlug.set(r.slug, (bySlug.get(r.slug) ?? 0) + Number(r.n));
    }
    const chs = [...byChannel.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const slugs =
      bucket === "resto"
        ? ` slugs=${[...bySlug.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`
        : "";
    console.log(`  ${bucket}: ${subtotal} (${chs})${slugs}`);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const probe = process.argv.includes("--probe");
  const since = parseBound(argValue("since"), "since");
  const until = parseBound(argValue("until"), "until");
  const sleepMs = Number(argValue("sleep-ms") ?? DEFAULT_SLEEP_MS);
  const range = createdAtFilter(since, until);

  const { prismaBase } = await import("@/lib/prisma-base");

  if (process.argv.includes("--add-column")) {
    const col = await prismaBase.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'conversations'
        AND column_name = 'firstInboundAt'
    `;
    if (col.length === 0) {
      await prismaBase.$executeRawUnsafe(
        `ALTER TABLE conversations ADD COLUMN "firstInboundAt" TIMESTAMP`,
      );
      console.log("[firstInboundAt] coluna criada (ADD COLUMN sem DEFAULT)");
    } else {
      console.log("[firstInboundAt] coluna já existe");
    }
    await prismaBase.$disconnect();
    return;
  }

  type ProbeRow = {
    org_bucket: string;
    slug: string;
    channel: string | null;
    n: bigint;
  };

  const remaining = await prismaBase.$queryRaw<ProbeRow[]>`
    SELECT
      CASE
        WHEN o.slug IN ('cruzeiro-ead', 'dnawork') THEN o.slug
        ELSE 'resto'
      END AS org_bucket,
      o.slug,
      c.channel,
      COUNT(*)::bigint AS n
    FROM conversations c
    INNER JOIN organizations o ON o.id = c."organizationId"
    WHERE c."firstInboundAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM messages m
        WHERE m."conversationId" = c.id
          AND m.direction = 'in'
          AND m."isPrivate" = false
      )
      ${range}
    GROUP BY 1, 2, 3
    ORDER BY 1, n DESC
  `;

  printProbe(
    "inbound em messages + firstInboundAt NULL (universo do backfill)",
    remaining,
  );

  const hole = await prismaBase.$queryRaw<ProbeRow[]>`
    SELECT
      CASE
        WHEN o.slug IN ('cruzeiro-ead', 'dnawork') THEN o.slug
        ELSE 'resto'
      END AS org_bucket,
      o.slug,
      c.channel,
      COUNT(*)::bigint AS n
    FROM conversations c
    INNER JOIN organizations o ON o.id = c."organizationId"
    WHERE c."lastInboundAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM messages m
        WHERE m."conversationId" = c.id
          AND m.direction = 'in'
          AND m."isPrivate" = false
      )
      ${range}
    GROUP BY 1, 2, 3
    ORDER BY 1, n DESC
  `;

  printProbe(
    "inbound em messages + lastInboundAt NULL (furo IG/Messenger / painel)",
    hole,
  );

  if (probe) {
    await prismaBase.$disconnect();
    return;
  }

  if (!(since || until) && apply) {
    console.log("[firstInboundAt] APPLY sem faixa — pulando preview em memória");
  }

  const preview = (since || until)
    ? await prismaBase.$queryRaw<
    Array<{
      id: string;
      channel: string | null;
      first_in: Date;
      lastInboundAt: Date | null;
    }>
  >`
    SELECT
      c.id,
      c.channel,
      sub.first_in,
      c."lastInboundAt"
    FROM conversations c
    INNER JOIN (
      SELECT m."conversationId" AS id, MIN(m."createdAt") AS first_in
      FROM messages m
      INNER JOIN conversations x ON x.id = m."conversationId"
      WHERE x."firstInboundAt" IS NULL
        ${since ? Prisma.sql`AND x."createdAt" >= ${since}` : Prisma.empty}
        ${until ? Prisma.sql`AND x."createdAt" < ${until}` : Prisma.empty}
        AND m.direction = 'in'
        AND m."isPrivate" = false
      GROUP BY m."conversationId"
    ) sub ON sub.id = c.id
  `
    : [];

  const inversions = preview.filter(
    (r) => r.lastInboundAt != null && r.first_in > r.lastInboundAt,
  );
  console.log(
    `[firstInboundAt] range preview would-update=${preview.length}` +
      ` inversions(first>last)=${inversions.length}` +
      ` lastInboundAt_null=${preview.filter((r) => r.lastInboundAt == null).length}`,
  );
  for (const r of preview.slice(0, 10)) {
    const cmp =
      r.lastInboundAt == null
        ? "last=NULL"
        : r.first_in <= r.lastInboundAt
          ? "first<=last"
          : "INVERT";
    console.log(
      `  sample ${r.id} channel=${r.channel ?? "∅"} first=${r.first_in.toISOString()}` +
        ` last=${r.lastInboundAt?.toISOString() ?? "NULL"} ${cmp}`,
    );
  }
  if (inversions.length > 0) {
    console.error(
      `[firstInboundAt] STOP: ${inversions.length} ticket(s) com firstInboundAt > lastInboundAt`,
    );
    for (const r of inversions.slice(0, 20)) {
      console.error(
        `  invert ${r.id} first=${r.first_in.toISOString()} last=${r.lastInboundAt?.toISOString()}`,
      );
    }
    await prismaBase.$disconnect();
    process.exit(2);
  }

  if (!apply) {
    console.log("[firstInboundAt] dry-run — nenhuma linha escrita");
    await prismaBase.$disconnect();
    return;
  }

  if (!since && !until) {
    console.error("[firstInboundAt] STOP: --apply exige --since/--until (sem loop no cluster inteiro)");
    await prismaBase.$disconnect();
    process.exit(2);
  }

  let cursorAt: Date | null = null;
  let cursorId: string | null = null;
  let batches = 0;
  let touched = 0;

  console.log(
    `[firstInboundAt] APPLY` +
      ` since=${since?.toISOString() ?? "min"} until=${until?.toISOString() ?? "max"}` +
      ` batch=${BATCH} sleep=${sleepMs}ms`,
  );

  for (;;) {
    const page = await prismaBase.$queryRaw<Array<{ id: string; createdAt: Date }>>`
      SELECT c.id, c."createdAt"
      FROM conversations c
      WHERE c."firstInboundAt" IS NULL
        AND EXISTS (
          SELECT 1
          FROM messages m
          WHERE m."conversationId" = c.id
            AND m.direction = 'in'
            AND m."isPrivate" = false
        )
        ${range}
        ${
          cursorAt && cursorId
            ? Prisma.sql`AND (c."createdAt", c.id) > (${cursorAt}, ${cursorId})`
            : Prisma.empty
        }
      ORDER BY c."createdAt" ASC, c.id ASC
      LIMIT ${BATCH}
    `;

    if (page.length === 0) break;

    const ids = page.map((r) => r.id);
    const idList = Prisma.join(ids);
    let n = 0;
    if (apply) {
      n = await prismaBase.$executeRaw`
        UPDATE conversations c
        SET "firstInboundAt" = sub.first_in
        FROM (
          SELECT m."conversationId" AS id, MIN(m."createdAt") AS first_in
          FROM messages m
          WHERE m."conversationId" IN (${idList})
            AND m.direction = 'in'
            AND m."isPrivate" = false
          GROUP BY m."conversationId"
        ) sub
        WHERE c.id = sub.id
          AND c."firstInboundAt" IS NULL
      `;
    } else {
      const counted = await prismaBase.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n
        FROM (
          SELECT m."conversationId"
          FROM messages m
          WHERE m."conversationId" IN (${idList})
            AND m.direction = 'in'
            AND m."isPrivate" = false
          GROUP BY m."conversationId"
        ) s
      `;
      n = Number(counted[0]?.n ?? 0);
    }

    batches += 1;
    touched += Number(n);
    const last = page[page.length - 1]!;
    console.log(
      `  batch ${batches}: ${page[0]!.createdAt.toISOString()} .. ${last.createdAt.toISOString()}` +
        ` ids=${page.length} → ${n}${apply ? " updated" : " would update"}`,
    );

    cursorAt = last.createdAt;
    cursorId = last.id;
    if (page.length < BATCH) break;
    if (sleepMs > 0) await sleep(sleepMs);
  }

  console.log(
    `[firstInboundAt] done batches=${batches} rows=${touched}${apply ? "" : " (dry-run)"}`,
  );
  await prismaBase.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
