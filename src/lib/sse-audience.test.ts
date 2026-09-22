import { describe, expect, it } from "vitest";

import {
  isPrivateTeamChatEvent,
  parseSseRedisMessage,
  serializeSseRedisBody,
  shouldDeliverSseEvent,
  SSE_ACCESS_REVOKED,
  teamChatAudience,
} from "@/lib/sse-audience";

const ORG = "org_a";
const MEMBER = "user_member";
const OUTSIDER = "user_outsider";
const SUPER = {
  organizationId: ORG,
  userId: "user_super",
  isSuperAdmin: true,
};
const MEMBER_L = {
  organizationId: ORG,
  userId: MEMBER,
  isSuperAdmin: false,
};
const OUTSIDER_L = {
  organizationId: ORG,
  userId: OUTSIDER,
  isSuperAdmin: false,
};

describe("isPrivateTeamChatEvent", () => {
  it("marca só prefixo team_chat_", () => {
    expect(isPrivateTeamChatEvent("team_chat_message")).toBe(true);
    expect(isPrivateTeamChatEvent("team_chat_room_updated")).toBe(true);
    expect(isPrivateTeamChatEvent("new_message")).toBe(false);
    expect(isPrivateTeamChatEvent("sse_access_revoked")).toBe(false);
  });
});

describe("teamChatAudience — participação, não payload", () => {
  it("união de membros atuais + extra (quem saiu)", () => {
    expect(teamChatAudience(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
  });

  it("mensagem posterior à remoção não inclui o ex-membro", () => {
    const remaining = ["a", "b"];
    const leaveNotice = teamChatAudience(remaining, ["c"]);
    expect(leaveNotice).toContain("c");
    expect(teamChatAudience(remaining)).not.toContain("c");
  });

  it("adicionar membro entra na audiência seguinte", () => {
    expect(teamChatAudience(["a", "b"])).not.toContain("c");
    expect(teamChatAudience(["a", "b", "c"])).toContain("c");
  });
});

describe("shouldDeliverSseEvent — super-admin sem bypass em sala privada", () => {
  it("super-admin fora da audiência não recebe team_chat_*", () => {
    expect(
      shouldDeliverSseEvent(SUPER, "team_chat_message", {
        organizationId: ORG,
        audienceUserIds: [MEMBER],
      }),
    ).toBe(false);
  });

  it("super-admin na audiência (membro explícito) recebe", () => {
    expect(
      shouldDeliverSseEvent(
        { ...SUPER, userId: MEMBER },
        "team_chat_message",
        { organizationId: ORG, audienceUserIds: [MEMBER] },
      ),
    ).toBe(true);
  });

  it("super-admin continua recebendo atendimento da plataforma", () => {
    expect(
      shouldDeliverSseEvent(SUPER, "new_message", { organizationId: ORG }),
    ).toBe(true);
  });

  it("membro da sala recebe; colega da org fora da sala não", () => {
    const env = { organizationId: ORG, audienceUserIds: [MEMBER] };
    expect(shouldDeliverSseEvent(MEMBER_L, "team_chat_message", env)).toBe(true);
    expect(shouldDeliverSseEvent(OUTSIDER_L, "team_chat_message", env)).toBe(
      false,
    );
  });

  it("team_chat_* sem audiência explícita: fail-closed", () => {
    expect(
      shouldDeliverSseEvent(MEMBER_L, "team_chat_message", {
        organizationId: ORG,
      }),
    ).toBe(false);
    expect(
      shouldDeliverSseEvent(MEMBER_L, "team_chat_message", {
        organizationId: ORG,
        audienceUserIds: [],
      }),
    ).toBe(false);
    expect(
      shouldDeliverSseEvent(SUPER, "team_chat_typing", { organizationId: ORG }),
    ).toBe(false);
  });

  it("atendimento sem audiência: fan-out por org, não por userId", () => {
    expect(
      shouldDeliverSseEvent(OUTSIDER_L, "new_message", { organizationId: ORG }),
    ).toBe(true);
    expect(
      shouldDeliverSseEvent(
        { organizationId: "org_b", userId: MEMBER, isSuperAdmin: false },
        "new_message",
        { organizationId: ORG },
      ),
    ).toBe(false);
  });

  it("sse_access_revoked só para o userId alvo", () => {
    const env = { organizationId: ORG, audienceUserIds: [MEMBER] };
    expect(shouldDeliverSseEvent(MEMBER_L, SSE_ACCESS_REVOKED, env)).toBe(true);
    expect(shouldDeliverSseEvent(OUTSIDER_L, SSE_ACCESS_REVOKED, env)).toBe(
      false,
    );
    expect(shouldDeliverSseEvent(SUPER, SSE_ACCESS_REVOKED, env)).toBe(false);
  });
});

describe("fio Redis — audiência no envelope, não em data.memberIds", () => {
  it("serializa audienceUserIds fora do payload FE", () => {
    const raw = serializeSseRedisBody({
      event: "team_chat_message",
      organizationId: ORG,
      data: { organizationId: ORG, content: "segredo", memberIds: [OUTSIDER] },
      audienceUserIds: [MEMBER],
    });
    const parsed = parseSseRedisMessage(raw);
    expect(parsed?.audienceUserIds).toEqual([MEMBER]);
    expect(
      (parsed?.data as { memberIds: string[] }).memberIds,
    ).toEqual([OUTSIDER]);
    expect(
      shouldDeliverSseEvent(OUTSIDER_L, parsed!.event, {
        organizationId: parsed!.organizationId,
        audienceUserIds: parsed!.audienceUserIds,
      }),
    ).toBe(false);
    expect(
      shouldDeliverSseEvent(MEMBER_L, parsed!.event, {
        organizationId: parsed!.organizationId,
        audienceUserIds: parsed!.audienceUserIds,
      }),
    ).toBe(true);
  });

  it("mensagem Redis de team_chat sem audienceUserIds: ninguém recebe", () => {
    const parsed = parseSseRedisMessage(
      serializeSseRedisBody({
        event: "team_chat_message",
        organizationId: ORG,
        data: { organizationId: ORG, memberIds: [MEMBER, OUTSIDER] },
      }),
    );
    expect(parsed?.audienceUserIds).toBeUndefined();
    expect(
      shouldDeliverSseEvent(MEMBER_L, parsed!.event, {
        organizationId: parsed!.organizationId,
        audienceUserIds: parsed!.audienceUserIds,
      }),
    ).toBe(false);
  });
});
