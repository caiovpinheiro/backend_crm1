import { describe, expect, it } from "vitest";

import {
  authorizeStorageObject,
  type StorageAuthzSession,
  type StorageObjectLookup,
} from "./storage-object-access";

const ORG = "org_a";
const USER = "user_a";
const OTHER = "user_b";

const member: StorageAuthzSession = {
  userId: USER,
  organizationId: ORG,
  role: "MEMBER",
};

function lookup(partial: Partial<StorageObjectLookup>): StorageObjectLookup {
  return {
    findKeepOwnerUserId: async () => null,
    findExportOwnerUserId: async () => null,
    findTeamChatRoomId: async () => null,
    isRoomMember: async () => false,
    ...partial,
  };
}

describe("authorizeStorageObject", () => {
  it("isola org divergente", async () => {
    const ok = await authorizeStorageObject(
      member,
      { orgId: "org_b", bucket: "inbound-media", fileName: "a.ogg" },
      lookup({}),
    );
    expect(ok).toBe(false);
  });

  it("permite inbound da própria org", async () => {
    const ok = await authorizeStorageObject(
      member,
      { orgId: ORG, bucket: "inbound-media", fileName: "a.ogg" },
      lookup({}),
    );
    expect(ok).toBe(true);
  });

  it("bloqueia keep de outro usuário", async () => {
    const ok = await authorizeStorageObject(
      member,
      { orgId: ORG, bucket: "keeps", fileName: "note.bin" },
      lookup({ findKeepOwnerUserId: async () => OTHER }),
    );
    expect(ok).toBe(false);
  });

  it("permite keep do dono", async () => {
    const ok = await authorizeStorageObject(
      member,
      { orgId: ORG, bucket: "keeps", fileName: "note.bin" },
      lookup({ findKeepOwnerUserId: async () => USER }),
    );
    expect(ok).toBe(true);
  });

  it("bloqueia export LGPD de outro usuário", async () => {
    const ok = await authorizeStorageObject(
      member,
      { orgId: ORG, bucket: "data-exports", fileName: "exp.zip" },
      lookup({ findExportOwnerUserId: async () => OTHER }),
    );
    expect(ok).toBe(false);
  });

  it("bloqueia import para MEMBER", async () => {
    const ok = await authorizeStorageObject(
      member,
      { orgId: ORG, bucket: "imports", fileName: "leads.csv" },
      lookup({}),
    );
    expect(ok).toBe(false);
  });

  it("permite import para MANAGER", async () => {
    const ok = await authorizeStorageObject(
      { ...member, role: "MANAGER" },
      { orgId: ORG, bucket: "imports", fileName: "leads.csv" },
      lookup({}),
    );
    expect(ok).toBe(true);
  });

  it("exige membership na sala quando o anexo é de team-chat", async () => {
    const denied = await authorizeStorageObject(
      member,
      { orgId: ORG, bucket: "attachments", fileName: "sala.png" },
      lookup({
        findTeamChatRoomId: async () => "room_private",
        isRoomMember: async () => false,
      }),
    );
    expect(denied).toBe(false);

    const allowed = await authorizeStorageObject(
      member,
      { orgId: ORG, bucket: "attachments", fileName: "sala.png" },
      lookup({
        findTeamChatRoomId: async () => "room_private",
        isRoomMember: async () => true,
      }),
    );
    expect(allowed).toBe(true);
  });

  it("anexo de inbox (sem sala) permanece por org", async () => {
    const ok = await authorizeStorageObject(
      member,
      { orgId: ORG, bucket: "attachments", fileName: "inbox.png" },
      lookup({ findTeamChatRoomId: async () => null }),
    );
    expect(ok).toBe(true);
  });
});
