/** Estatísticas finais pós-simulação de import de deals. */
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 2 });

const deals = await pool.query(
  `SELECT o.name, count(d.id)::int AS deals
     FROM organizations o LEFT JOIN deals d ON d."organizationId" = o.id
    GROUP BY o.name ORDER BY o.name`,
);
console.log("deals/org:", JSON.stringify(deals.rows));

const tags = await pool.query(
  `SELECT t.name, o.name AS org,
          (SELECT count(*)::int FROM tags_on_deals td WHERE td."tagId" = t.id) AS deals_taggeados
     FROM tags t JOIN organizations o ON o.id = t."organizationId"
    WHERE t.name LIKE '__STRESS_IMPORT__%' ORDER BY o.name`,
);
console.log("tags stress:", JSON.stringify(tags.rows, null, 1));

const act = await pool.query(
  `SELECT b.id, b.type, b.status, o.name, b.processed, b.total
     FROM bulk_operations b JOIN organizations o ON o.id = b."organizationId"
    WHERE b.type IN ('CONTACT_IMPORT','DEAL_IMPORT') AND b.status IN ('PENDING','PROCESSING')`,
);
console.log("imports ativos agora:", JSON.stringify(act.rows));

const today = await pool.query(
  `SELECT b.id, o.name AS org, b.status, b.processed, b.failed, b.total,
          EXTRACT(EPOCH FROM (b."finishedAt" - b."startedAt"))::int AS dur_s,
          b."startedAt"::time(0) AS ini, b."finishedAt"::time(0) AS fim
     FROM bulk_operations b JOIN organizations o ON o.id = b."organizationId"
    WHERE b.type = 'DEAL_IMPORT' AND b."createdAt" > now() - interval '5 hours'
    ORDER BY b."createdAt"`,
);
console.log("ops do dia:", JSON.stringify(today.rows, null, 1));

await pool.end();
