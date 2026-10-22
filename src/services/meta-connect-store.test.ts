import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache/redis-client", () => ({
  getCacheClient: () => null,
}));

describe("meta connect nonce em memória (só fora de produção)", () => {
  const prev = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.NODE_ENV = prev;
  });

  it("completed devolve o mesmo canal e não volta para pending", async () => {
    const {
      savePendingMetaConnect,
      claimMetaConnect,
      completeMetaConnectRecord,
      readMetaConnectRecord,
    } = await import("./meta-connect-store");

    const nonce = `n-${Date.now()}`;
    await savePendingMetaConnect(
      nonce,
      {
        status: "pending",
        organizationId: "org",
        userId: "user",
        returnUrl: "https://acme.bwipo.com/settings/channels",
        exp: Date.now() + 60_000,
      },
      60,
    );

    const claimed = await claimMetaConnect(nonce);
    expect(claimed.kind).toBe("claimed");
    await completeMetaConnectRecord(
      nonce,
      "ch-1",
      "https://acme.bwipo.com/settings/channels",
      60,
    );

    const again = await claimMetaConnect(nonce);
    expect(again.kind).toBe("completed");
    if (again.kind === "completed") {
      expect(again.record.resultChannelId).toBe("ch-1");
      expect(again.record.status).toBe("completed");
    }
    const stored = await readMetaConnectRecord(nonce);
    expect(stored?.status).toBe("completed");
  });

  it("produção sem Redis recusa memória", async () => {
    process.env.NODE_ENV = "production";
    const { savePendingMetaConnect } = await import("./meta-connect-store");
    await expect(
      savePendingMetaConnect(
        `p-${Date.now()}`,
        {
          status: "pending",
          organizationId: "org",
          userId: "user",
          returnUrl: "https://acme.bwipo.com/settings/channels",
          exp: Date.now() + 60_000,
        },
        60,
      ),
    ).rejects.toMatchObject({ code: "REDIS_REQUIRED" });
  });
});
