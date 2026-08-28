import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectPublicDoManagedHosts,
  hostnameFromConnectionUrl,
  isPublicDigitalOceanManagedHost,
  resetPublicDoManagedHostWarningForTests,
  warnPublicDoManagedHosts,
} from "@/lib/warn-public-do-managed-hosts";

afterEach(() => {
  resetPublicDoManagedHostWarningForTests();
  vi.restoreAllMocks();
});

describe("isPublicDigitalOceanManagedHost", () => {
  it("avisa hostname público DigitalOcean (sem private-)", () => {
    expect(
      isPublicDigitalOceanManagedHost(
        "crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com",
      ),
    ).toBe(true);
  });

  it("não avisa hostname private-*", () => {
    expect(
      isPublicDigitalOceanManagedHost(
        "private-crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com",
      ),
    ).toBe(false);
  });

  it("não avisa localhost", () => {
    expect(isPublicDigitalOceanManagedHost("localhost")).toBe(false);
    expect(isPublicDigitalOceanManagedHost("127.0.0.1")).toBe(false);
  });

  it("avisa Valkey público e ignora private- Valkey", () => {
    expect(
      isPublicDigitalOceanManagedHost(
        "crm1-valkey-nyc3-do-user-XXXX.b.db.ondigitalocean.com",
      ),
    ).toBe(true);
    expect(
      isPublicDigitalOceanManagedHost(
        "private-crm1-valkey-nyc3-do-user-XXXX.b.db.ondigitalocean.com",
      ),
    ).toBe(false);
  });
});

describe("hostnameFromConnectionUrl", () => {
  it("extrai hostname e não devolve user/senha", () => {
    const host = hostnameFromConnectionUrl(
      "postgresql://doadmin:s3cret-pass@crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25060/defaultdb?sslmode=require",
    );
    expect(host).toBe("crm1-pg-nyc3-do-user-xxxx.b.db.ondigitalocean.com");
    expect(host).not.toContain("doadmin");
    expect(host).not.toContain("s3cret");
  });

  it("aceita rediss://", () => {
    expect(
      hostnameFromConnectionUrl(
        "rediss://default:SENHA@private-crm1-valkey-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25061",
      ),
    ).toBe("private-crm1-valkey-nyc3-do-user-xxxx.b.db.ondigitalocean.com");
  });
});

describe("collectPublicDoManagedHosts", () => {
  it("marca DATABASE_URL pública e ignora replica/localhost", () => {
    const findings = collectPublicDoManagedHosts({
      DATABASE_URL:
        "postgresql://u:p@crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25060/db",
      DATABASE_URL_REPLICA:
        "postgresql://u:p@private-crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25060/db",
      REDIS_URL: "redis://127.0.0.1:6379",
    });
    expect(findings).toEqual([
      {
        envName: "DATABASE_URL",
        hostname: "crm1-pg-nyc3-do-user-xxxx.b.db.ondigitalocean.com",
      },
    ]);
  });

  it("marca REDIS_URL Valkey público", () => {
    const findings = collectPublicDoManagedHosts({
      REDIS_URL:
        "rediss://default:x@crm1-valkey-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25061",
    });
    expect(findings).toEqual([
      {
        envName: "REDIS_URL",
        hostname: "crm1-valkey-nyc3-do-user-xxxx.b.db.ondigitalocean.com",
      },
    ]);
  });
});

describe("warnPublicDoManagedHosts", () => {
  it("em production loga hostname e não loga senha; é idempotente", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = {
      NODE_ENV: "production",
      DATABASE_URL:
        "postgresql://doadmin:super-secret@crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25060/defaultdb",
    };
    warnPublicDoManagedHosts(env);
    warnPublicDoManagedHosts(env);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("[WARN]");
    expect(msg).toContain("crm1-pg-nyc3-do-user-xxxx.b.db.ondigitalocean.com");
    expect(msg).not.toContain("super-secret");
    expect(msg).not.toContain("doadmin");
  });

  it("não loga fora de production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnPublicDoManagedHosts({
      NODE_ENV: "development",
      DATABASE_URL:
        "postgresql://u:p@crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25060/db",
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
