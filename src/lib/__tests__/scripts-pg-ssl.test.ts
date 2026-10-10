import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { pgConnectionConfig } from "../../../scripts/lib/pg-ssl.mjs";

/** Helper de TLS dos backfills (`scripts/lib/pg-ssl.mjs`). */
const DO_URL =
  "postgresql://doadmin:pw@db-x.b.db.ondigitalocean.example:25060/defaultdb?sslmode=require";

const dir = mkdtempSync(join(tmpdir(), "pgssl-"));
const caPath = join(dir, "ca.crt");
writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function params(connectionString: string | undefined) {
  return new URL(connectionString ?? "").searchParams;
}

describe("pgConnectionConfig", () => {
  it("sslmode=require → TLS sem verificar o CA e URL sem sslmode", () => {
    const cfg = pgConnectionConfig(DO_URL, {});
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(params(cfg.connectionString).has("sslmode")).toBe(false);
    expect(cfg.connectionString).toContain("db-x.b.db.ondigitalocean.example:25060/defaultdb");
  });

  it("lê DATABASE_URL do ambiente quando não recebe a URL", () => {
    const cfg = pgConnectionConfig(undefined, { DATABASE_URL: DO_URL });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(params(cfg.connectionString).has("sslmode")).toBe(false);
  });

  it("sslmode=disable → ssl:false", () => {
    const cfg = pgConnectionConfig("postgresql://u:p@db.example:5432/app?sslmode=disable", {});
    expect(cfg.ssl).toBe(false);
    expect(params(cfg.connectionString).has("sslmode")).toBe(false);
  });

  it("sem sslmode em host local → ssl:false", () => {
    const cfg = pgConnectionConfig("postgresql://u:p@localhost:5432/app", {});
    expect(cfg).toEqual({ connectionString: "postgresql://u:p@localhost:5432/app", ssl: false });
  });

  it("sem sslmode em host remoto → não define ssl (padrão do pg)", () => {
    const cfg = pgConnectionConfig("postgresql://u:p@db.example:5432/app?application_name=x", {});
    expect(cfg).toEqual({ connectionString: "postgresql://u:p@db.example:5432/app?application_name=x" });
    expect("ssl" in cfg).toBe(false);
  });

  it("sem sslmode na URL usa PGSSLMODE do ambiente", () => {
    const cfg = pgConnectionConfig("postgresql://u:p@db.example:5432/app", { PGSSLMODE: "require" });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("remove uselibpqcompat e preserva os outros parâmetros", () => {
    const cfg = pgConnectionConfig(`${DO_URL}&uselibpqcompat=true&application_name=bf`, {});
    const p = params(cfg.connectionString);
    expect(p.has("uselibpqcompat")).toBe(false);
    expect(p.has("sslmode")).toBe(false);
    expect(p.get("application_name")).toBe("bf");
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("PG_SSL_VERIFY=1 liga a verificação com o CA de PGSSLROOTCERT", () => {
    const cfg = pgConnectionConfig(DO_URL, { PG_SSL_VERIFY: "1", PGSSLROOTCERT: caPath });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true, ca: expect.stringContaining("FAKE") });
  });

  it("PG_SSL_VERIFY=1 sem CA em disco → verifica com a cadeia do Node", () => {
    const cfg = pgConnectionConfig(DO_URL, {
      PG_SSL_VERIFY: "1",
      PGSSLROOTCERT: join(dir, "nao-existe.crt"),
    });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("sslrootcert da URL sai da connection string (senão o pg sobrescreve o ssl)", () => {
    const url = `${DO_URL}&sslrootcert=${encodeURIComponent(caPath)}`;
    const off = pgConnectionConfig(url, {});
    expect(params(off.connectionString).has("sslrootcert")).toBe(false);
    expect(off.ssl).toEqual({ rejectUnauthorized: false });
    const on = pgConnectionConfig(url, { PG_SSL_VERIFY: "1" });
    expect(on.ssl).toEqual({ rejectUnauthorized: true, ca: expect.stringContaining("FAKE") });
  });

  it("sem DATABASE_URL → objeto vazio (pg cai nos PG* do ambiente)", () => {
    expect(pgConnectionConfig(undefined, {})).toEqual({});
  });
});
