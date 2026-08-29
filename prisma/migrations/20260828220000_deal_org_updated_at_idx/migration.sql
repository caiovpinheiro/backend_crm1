-- Incremental sync (GET /api/deals?updatedSince=) — avoids N× getById.
CREATE INDEX IF NOT EXISTS "deals_organizationId_updatedAt_idx"
  ON "deals" ("organizationId", "updatedAt");
