/**
 * Limpeza do run strmt662jht: marca como CANCELLED as 4 ops que ficaram
 * zumbis (PROCESSING/PENDING) após o obliterate da fila — com erro explicativo.
 * A op de Cruzeiro EaD (concluída) não é tocada.
 */
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 2 });

const ids = [
  "copmt662jlp1zw47njf", // Comercial Cruzeiro (PROCESSING 3200/5000)
  "copmt662jq5hf036wht", // EduIT (PENDING)
  "copmt662jsdidgfk2b7", // Sumare EaD (PENDING)
  "copmt662jtwm3pyrcj7", // teste (PENDING)
];

const err = JSON.stringify([{
  itemId: "__operation__",
  message: "Cancelada pelo simulador de stress: fila import-etl sofreu obliterate (reset.mjs) durante o processamento — job perdido.",
  attempt: 0,
  at: new Date().toISOString(),
}]);

const r = await pool.query(
  `UPDATE bulk_operations
      SET status = 'CANCELLED', "finishedAt" = now(), "updatedAt" = now(),
          errors = $2::jsonb
    WHERE id = ANY($1) AND status IN ('PENDING','PROCESSING')
    RETURNING id, status`,
  [ids, err],
);
console.log("canceladas:", JSON.stringify(r.rows));

const done = await pool.query(
  `SELECT id, status, total, processed, succeeded, failed, "startedAt", "finishedAt"
     FROM bulk_operations WHERE id = 'copmt662joalh3fy31v'`,
);
console.log("cruzeiro-ead (minha):", JSON.stringify(done.rows));

await pool.end();
