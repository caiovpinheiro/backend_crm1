/**
 * Seed de volume para validar Lote 2 (collapse inbox).
 *
 * Isolado — nunca importado por código de produção.
 *
 * Uso:
 *   npx tsx scripts/seed-volume.ts              # limpa orgs volume + semeia
 *   npx tsx scripts/seed-volume.ts --clean      # só limpa
 *   SEED_VOLUME_CLEAN=1 npx tsx scripts/seed-volume.ts
 *   npm run seed:volume
 *   npm run seed:volume -- --clean
 *
 * Orgs fixas (idempotentes):
 *   org_vol_small  (~200 conversas)
 *   org_vol_medium (~15k)
 *   org_vol_large  (~120k)
 */

import "dotenv/config";
import { Pool, type PoolClient } from "pg";

const ORG_IDS = ["org_vol_small", "org_vol_medium", "org_vol_large"] as const;

type Profile = {
  id: (typeof ORG_IDS)[number];
  slug: string;
  name: string;
  targetConvs: number;
};

const PROFILES: Profile[] = [
  { id: "org_vol_small", slug: "vol-small", name: "Volume Small", targetConvs: 200 },
  { id: "org_vol_medium", slug: "vol-medium", name: "Volume Medium", targetConvs: 15_000 },
  { id: "org_vol_large", slug: "vol-large", name: "Volume Large", targetConvs: 120_000 },
];

const CHANNELS = ["whatsapp", "instagram", "messenger", "telegram"] as const;
const BATCH = 2_000;
/** Linhas únicas recentes na org grande para empurrar grupos multi além do HARD_CAP (8000). */
const HARD_CAP_NOISE = 8_500;

type ConvRow = {
  id: string;
  organizationId: string;
  number: number;
  channel: string | null;
  status: "OPEN" | "RESOLVED" | "PENDING" | "SNOOZED";
  contactId: string | null;
  channelId: string | null;
  unreadCount: number;
  updatedAt: Date;
  createdAt: Date;
  closedAt: Date | null;
  followUpAt: Date | null;
};

function parseArgs(argv: string[]) {
  const envClean =
    process.env.SEED_VOLUME_CLEAN === "1" ||
    process.env.SEED_VOLUME_CLEAN === "true";
  // --clean (ou env) sem --seed => só limpa. Default / --seed => limpa + semeia.
  const cleanFlag = argv.includes("--clean") || envClean;
  const seedFlag = argv.includes("--seed");
  const mode = cleanFlag && !seedFlag ? "clean" : "seed";
  return { mode };
}

function pad(n: number, w: number) {
  return String(n).padStart(w, "0");
}

function contactId(orgKey: string, n: number) {
  return `vol_${orgKey}_c_${pad(n, 6)}`;
}

function convId(orgKey: string, n: number) {
  return `vol_${orgKey}_cv_${pad(n, 7)}`;
}

function channelRowId(orgKey: string, ch: string) {
  return `vol_${orgKey}_ch_${ch}`;
}

function orgKeyFromId(id: string) {
  return id.replace(/^org_vol_/, "");
}

/** Distribuição de tamanho de grupo (conversas por contato) — cauda longa. */
function planGroupSizes(targetConvs: number): number[] {
  const sizes: number[] = [];
  let remaining = targetConvs;
  // Reserva para bordas fixas (~3% ou mínimo)
  const reserve = Math.min(Math.max(40, Math.floor(targetConvs * 0.02)), 400);
  remaining -= reserve;

  while (remaining > 0) {
    const r = Math.random();
    let size: number;
    if (r < 0.72) size = 1;
    else if (r < 0.88) size = 2 + Math.floor(Math.random() * 3); // 2–4
    else if (r < 0.97) size = 5 + Math.floor(Math.random() * 11); // 5–15
    else size = 16 + Math.floor(Math.random() * 15); // 16–30
    size = Math.min(size, remaining);
    sizes.push(size);
    remaining -= size;
  }
  return sizes;
}

function pickStatus(activeTaken: boolean): ConvRow["status"] {
  if (!activeTaken) {
    const r = Math.random();
    if (r < 0.55) return "OPEN";
    if (r < 0.7) return "PENDING";
    if (r < 0.8) return "SNOOZED";
    return "RESOLVED";
  }
  return "RESOLVED";
}

async function ensureNullableBorders(client: PoolClient) {
  // Schema Prisma exige NOT NULL, mas o SQL de collapse trata NULL.
  // Relaxamos só no DB local de volume para exercitar as bordas.
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'conversations' AND column_name = 'contactId' AND is_nullable = 'NO'
      ) THEN
        ALTER TABLE conversations ALTER COLUMN "contactId" DROP NOT NULL;
        RAISE NOTICE 'seed-volume: contactId now nullable';
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'conversations' AND column_name = 'channel' AND is_nullable = 'NO'
      ) THEN
        ALTER TABLE conversations ALTER COLUMN channel DROP NOT NULL;
        RAISE NOTICE 'seed-volume: channel now nullable';
      END IF;
    END $$;
  `);
}

async function cleanVolume(client: PoolClient) {
  console.log("[clean] Removendo orgs de volume…");
  // Ordem segura: filhos com RESTRICT / sem cascade completo
  await client.query(`DELETE FROM conversations WHERE "organizationId" = ANY($1::text[])`, [
    ORG_IDS,
  ]);
  await client.query(`DELETE FROM contacts WHERE "organizationId" = ANY($1::text[])`, [ORG_IDS]);
  await client.query(`DELETE FROM channels WHERE "organizationId" = ANY($1::text[])`, [ORG_IDS]);
  await client.query(`DELETE FROM organizations WHERE id = ANY($1::text[])`, [ORG_IDS]);
  console.log("[clean] OK");
}

async function insertBatch(
  client: PoolClient,
  sqlPrefix: string,
  rows: unknown[][],
  castSql: string,
) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const values: string[] = [];
    let p = 1;
    for (const row of chunk) {
      const placeholders = row.map(() => `$${p++}`);
      values.push(`(${placeholders.join(",")})`);
      params.push(...row);
    }
    await client.query(`${sqlPrefix} VALUES ${values.join(",")}${castSql}`, params);
  }
}

function buildDataset(profile: Profile): {
  contacts: { id: string; number: number; name: string; phone: string }[];
  channelIds: Record<string, string>;
  convs: ConvRow[];
} {
  const key = orgKeyFromId(profile.id);
  const base = Date.now();
  const contacts: { id: string; number: number; name: string; phone: string }[] = [];
  const convs: ConvRow[] = [];
  const channelIds: Record<string, string> = {};
  for (const ch of CHANNELS) {
    channelIds[ch] = channelRowId(key, ch);
  }

  let contactNum = 0;
  let convNum = 0;

  const pushContact = () => {
    contactNum += 1;
    const id = contactId(key, contactNum);
    contacts.push({
      id,
      number: contactNum,
      name: `Vol ${key} Contact ${contactNum}`,
      phone: `+5511${pad(contactNum % 100_000_000, 9)}`,
    });
    return id;
  };

  const pushConv = (partial: Omit<ConvRow, "organizationId" | "number" | "id"> & { id?: string }) => {
    convNum += 1;
    const id = partial.id ?? convId(key, convNum);
    convs.push({
      id,
      organizationId: profile.id,
      number: convNum,
      channel: partial.channel,
      status: partial.status,
      contactId: partial.contactId,
      channelId: partial.channelId,
      unreadCount: partial.unreadCount,
      updatedAt: partial.updatedAt,
      createdAt: partial.createdAt,
      closedAt: partial.closedAt,
      followUpAt: partial.followUpAt,
    });
    return id;
  };

  // --- HARD_CAP noise (só large): singletons recentes nas primeiras ~8500 posições ---
  const noiseCount =
    profile.id === "org_vol_large"
      ? HARD_CAP_NOISE
      : Math.min(40, Math.floor(profile.targetConvs * 0.15));

  for (let i = 0; i < noiseCount; i++) {
    const cid = pushContact();
    const ch = CHANNELS[i % CHANNELS.length];
    const ts = new Date(base - i * 1_000);
    pushConv({
      channel: ch,
      status: i % 7 === 0 ? "RESOLVED" : i % 11 === 0 ? "PENDING" : "OPEN",
      contactId: cid,
      channelId: channelIds[ch],
      unreadCount: i % 5,
      updatedAt: ts,
      createdAt: new Date(ts.getTime() - 86_400_000),
      closedAt: i % 7 === 0 ? ts : null,
      followUpAt: null,
    });
  }

  // --- Grupos multi (5–30) com max(updatedAt) DEPOIS da linha 8000 (mais antigos) ---
  const deepGroupCount =
    profile.id === "org_vol_large" ? 120 : profile.id === "org_vol_medium" ? 40 : 8;
  for (let g = 0; g < deepGroupCount; g++) {
    const cid = pushContact();
    const nInGroup = 5 + (g % 26); // 5–30
    const channelsUsed = new Set<string>();
    for (let j = 0; j < nInGroup; j++) {
      const ch = CHANNELS[j % CHANNELS.length];
      const activeKey = `${cid}::${ch}`;
      const activeTaken = channelsUsed.has(activeKey);
      if (!activeTaken) channelsUsed.add(activeKey);
      // Mais antigo que o noise: base - HARD_CAP_NOISE*1000 - ...
      const ts = new Date(base - (HARD_CAP_NOISE + g * 40 + j) * 1_000);
      const status = pickStatus(activeTaken);
      pushConv({
        channel: ch,
        status,
        contactId: cid,
        channelId: channelIds[ch],
        unreadCount: j % 3,
        updatedAt: ts,
        createdAt: new Date(ts.getTime() - 3_600_000),
        closedAt: status === "RESOLVED" ? ts : null,
        followUpAt: status === "RESOLVED" && j % 4 === 0 ? ts : null,
      });
    }
  }

  // --- Empates exatos de updatedAt no mesmo grupo ---
  {
    const cid = pushContact();
    const tieAt = new Date(base - (HARD_CAP_NOISE + 500) * 1_000);
    // Mesmo contact+channel: só 1 ativo; resto RESOLVED — empate updatedAt
    for (let t = 0; t < 5; t++) {
      pushConv({
        channel: "whatsapp",
        status: t === 0 ? "OPEN" : "RESOLVED",
        contactId: cid,
        channelId: channelIds.whatsapp,
        unreadCount: 0,
        updatedAt: tieAt,
        createdAt: new Date(tieAt.getTime() - t * 60_000),
        closedAt: t === 0 ? null : tieAt,
        followUpAt: null,
      });
    }
    // Outros canais (não whatsapp), mesmo updatedAt — collapse por canal
    for (let t = 1; t < CHANNELS.length; t++) {
      const ch = CHANNELS[t];
      pushConv({
        channel: ch,
        status: "OPEN",
        contactId: cid,
        channelId: channelIds[ch],
        unreadCount: 1,
        updatedAt: tieAt,
        createdAt: new Date(tieAt.getTime() - 120_000),
        closedAt: null,
        followUpAt: null,
      });
    }
  }

  // --- Bordas: contactId NULL / channel NULL ---
  const nullContactN = profile.id === "org_vol_large" ? 80 : profile.id === "org_vol_medium" ? 20 : 5;
  for (let i = 0; i < nullContactN; i++) {
    const ts = new Date(base - (HARD_CAP_NOISE + 800 + i) * 1_000);
    pushConv({
      channel: CHANNELS[i % CHANNELS.length],
      status: i % 2 === 0 ? "OPEN" : "RESOLVED",
      contactId: null,
      channelId: null,
      unreadCount: 0,
      updatedAt: ts,
      createdAt: ts,
      closedAt: i % 2 === 0 ? null : ts,
      followUpAt: null,
    });
  }
  const nullChannelN = nullContactN;
  for (let i = 0; i < nullChannelN; i++) {
    const cid = pushContact();
    const ts = new Date(base - (HARD_CAP_NOISE + 900 + i) * 1_000);
    pushConv({
      channel: null,
      status: i % 3 === 0 ? "PENDING" : i % 3 === 1 ? "SNOOZED" : "RESOLVED",
      contactId: cid,
      channelId: null,
      unreadCount: 0,
      updatedAt: ts,
      createdAt: ts,
      closedAt: i % 3 === 2 ? ts : null,
      followUpAt: null,
    });
  }

  // --- Preenche até target com distribuição realista ---
  const remaining = profile.targetConvs - convs.length;
  if (remaining > 0) {
    const sizes = planGroupSizes(remaining);
    let offset = HARD_CAP_NOISE + 2_000;
    for (const size of sizes) {
      const cid = pushContact();
      const channelsUsed = new Set<string>();
      for (let j = 0; j < size; j++) {
        const ch = CHANNELS[(j + size) % CHANNELS.length];
        const activeKey = `${cid}::${ch}`;
        const activeTaken = channelsUsed.has(activeKey);
        if (!activeTaken) channelsUsed.add(activeKey);
        const ts = new Date(base - (offset + j) * 1_000);
        const status = pickStatus(activeTaken);
        pushConv({
          channel: ch,
          status,
          contactId: cid,
          channelId: channelIds[ch],
          unreadCount: Math.floor(Math.random() * 4),
          updatedAt: ts,
          createdAt: new Date(ts.getTime() - 86_400_000),
          closedAt: status === "RESOLVED" ? ts : null,
          followUpAt: status === "RESOLVED" && Math.random() < 0.15 ? ts : null,
        });
      }
      offset += size + 1;
    }
  }

  // Ajuste fino: se passou do target (improvável), corta; se ficou curto, completa singletons
  while (convs.length < profile.targetConvs) {
    const cid = pushContact();
    const i = convs.length;
    const ch = CHANNELS[i % CHANNELS.length];
    const ts = new Date(base - (10_000 + i) * 1_000);
    pushConv({
      channel: ch,
      status: "OPEN",
      contactId: cid,
      channelId: channelIds[ch],
      unreadCount: 0,
      updatedAt: ts,
      createdAt: ts,
      closedAt: null,
      followUpAt: null,
    });
  }
  if (convs.length > profile.targetConvs) {
    convs.length = profile.targetConvs;
  }

  // Re-numera conversas 1..N estável após possível corte
  convs.forEach((c, idx) => {
    c.number = idx + 1;
    c.id = convId(key, idx + 1);
  });

  return { contacts, channelIds, convs };
}

async function seedProfile(client: PoolClient, profile: Profile) {
  console.log(`\n[seed] ${profile.id} → ~${profile.targetConvs} conversas`);
  const t0 = Date.now();
  const { contacts, channelIds, convs } = buildDataset(profile);
  const key = orgKeyFromId(profile.id);

  await client.query(
    `INSERT INTO organizations (id, name, slug, status, "createdAt", "updatedAt", "onboardingCompletedAt")
     VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, "updatedAt" = NOW()`,
    [profile.id, profile.name, profile.slug],
  );

  // Channels
  let chNum = 0;
  for (const ch of CHANNELS) {
    chNum += 1;
    const type =
      ch === "instagram" ? "INSTAGRAM" : ch === "messenger" ? "FACEBOOK" : "WHATSAPP";
    const provider = ch === "telegram" ? "BAILEYS_MD" : "META_CLOUD_API";
    await client.query(
      `INSERT INTO channels (id, "organizationId", number, name, type, provider, status, config, "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5::"ChannelType",$6::"ChannelProvider",'CONNECTED','{}',NOW(),NOW())
       ON CONFLICT (id) DO NOTHING`,
      [channelIds[ch], profile.id, chNum, `${ch} volume`, type, provider],
    );
  }

  // Contacts
  const contactRows = contacts.map((c) => [
    c.id,
    c.number,
    c.name,
    c.phone,
    profile.id,
    "LEAD",
    0,
    new Date(),
    new Date(),
  ]);
  await insertBatch(
    client,
    `INSERT INTO contacts (id, number, name, phone, "organizationId", "lifecycleStage", "leadScore", "createdAt", "updatedAt")`,
    contactRows,
    ` ON CONFLICT (id) DO NOTHING`,
  );
  console.log(`  contacts: ${contacts.length}`);

  // Conversations
  const convRows = convs.map((c) => [
    c.id,
    c.organizationId,
    c.number,
    c.channel,
    c.status,
    c.contactId,
    c.channelId,
    c.unreadCount,
    false,
    false,
    false,
    c.updatedAt,
    c.createdAt,
    c.closedAt,
    c.followUpAt,
  ]);
  await insertBatch(
    client,
    `INSERT INTO conversations (
      id, "organizationId", number, channel, status, "contactId", "channelId",
      "unreadCount", "hasAgentReply", "hasHumanReply", "hasError",
      "updatedAt", "createdAt", "closedAt", "followUpAt"
    )`,
    convRows,
    ``,
  );
  console.log(`  conversations: ${convs.length} (${Date.now() - t0}ms)`);

  // Sanity: unique parcial ativo
  const dup = await client.query(
    `SELECT "contactId", channel, COUNT(*)::int AS n
     FROM conversations
     WHERE "organizationId" = $1 AND status <> 'RESOLVED' AND "contactId" IS NOT NULL AND channel IS NOT NULL
     GROUP BY 1, 2 HAVING COUNT(*) > 1
     LIMIT 5`,
    [profile.id],
  );
  if (dup.rows.length > 0) {
    throw new Error(
      `[seed] violação unique ativo em ${profile.id}: ${JSON.stringify(dup.rows)}`,
    );
  }

  void key;
}

async function analyze(client: PoolClient) {
  console.log("\n[analyze] ANALYZE conversations, contacts, channels…");
  await client.query(`ANALYZE conversations`);
  await client.query(`ANALYZE contacts`);
  await client.query(`ANALYZE channels`);
}

async function printCounts(client: PoolClient) {
  const { rows } = await client.query(
    `SELECT o.id, o.name, COUNT(c.id)::int AS conversations
     FROM organizations o
     LEFT JOIN conversations c ON c."organizationId" = o.id
     WHERE o.id = ANY($1::text[])
     GROUP BY o.id, o.name
     ORDER BY o.id`,
    [ORG_IDS],
  );
  console.log("\n[counts]");
  for (const r of rows) {
    console.log(`  ${r.id}: ${r.conversations} conversas`);
  }
  if (rows.length === 0) console.log("  (nenhuma org volume)");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await cleanVolume(client);
    if (args.mode === "clean") {
      await client.query("COMMIT");
      await printCounts(client);
      return;
    }
    await ensureNullableBorders(client);
    // Seed fora de uma única transação gigante (120k) — commit parcial por org
    await client.query("COMMIT");

    for (const profile of PROFILES) {
      await client.query("BEGIN");
      try {
        await seedProfile(client, profile);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }

    await analyze(client);
    await printCounts(client);
    console.log("\n[done] seed-volume OK");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
