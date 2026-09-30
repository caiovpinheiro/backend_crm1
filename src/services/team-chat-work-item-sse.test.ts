import { describe, expect, it } from "vitest";

import {
  workItemSseRoomCandidate,
  workItemSseStakeholders,
} from "@/services/team-chat-work-item-sse";

describe("workItemSseRoomCandidate", () => {
  it("usa roomId persistido", () => {
    expect(
      workItemSseRoomCandidate({
        roomId: "room_1",
        originType: "message",
        originId: "msg_1",
      }),
    ).toEqual({ kind: "room", roomId: "room_1" });
  });

  it("originType=room sem roomId resolve a sala pelo originId", () => {
    expect(
      workItemSseRoomCandidate({
        roomId: null,
        originType: "room",
        originId: "room_from_origin",
      }),
    ).toEqual({ kind: "room", roomId: "room_from_origin" });
  });

  it("originType=message sem roomId pede lookup da mensagem", () => {
    expect(
      workItemSseRoomCandidate({
        roomId: null,
        originType: "message",
        originId: "msg_1",
      }),
    ).toEqual({ kind: "lookup_message", originId: "msg_1" });
  });

  it("originType=meeting sem roomId pede lookup da reunião", () => {
    expect(
      workItemSseRoomCandidate({
        roomId: null,
        originType: "meeting",
        originId: "meet_1",
      }),
    ).toEqual({ kind: "lookup_meeting", originId: "meet_1" });
  });

  it("sem sala e sem origem útil: none (publisher usa stakeholders, não a org)", () => {
    expect(
      workItemSseRoomCandidate({
        roomId: null,
        originType: "other",
        originId: "",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("workItemSseStakeholders", () => {
  it("união de criador, participantes e assignees — sem duplicar", () => {
    expect(
      workItemSseStakeholders({
        createdById: "u1",
        participantIds: ["u2", "u1"],
        entries: [{ assigneeId: "u3" }, { assigneeId: null }, { assigneeId: "u2" }],
      }),
    ).toEqual(["u1", "u2", "u3"]);
  });
});
