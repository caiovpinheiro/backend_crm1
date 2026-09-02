import { describe, expect, it } from "vitest";

import {
  HUMAN_OUTBOUND_REPLY_MARK,
  countableReplyWhere,
  noCountableReplyWhere,
} from "../conversation-reply-marking";

describe("conversation-reply-marking", () => {
  it("HUMAN_OUTBOUND_REPLY_MARK tira o ticket de Aguardando", () => {
    expect(HUMAN_OUTBOUND_REPLY_MARK).toEqual({
      lastMessageDirection: "out",
      hasAgentReply: true,
      hasHumanReply: true,
    });
  });

  it("countableReplyWhere (setting off) exige hasHumanReply", () => {
    expect(countableReplyWhere(false)).toEqual({ hasHumanReply: true });
    expect(noCountableReplyWhere(false)).toEqual({ hasHumanReply: false });
  });

  it("countableReplyWhere (setting on) aceita hasAgentReply", () => {
    expect(countableReplyWhere(true)).toEqual({
      OR: [{ hasHumanReply: true }, { hasAgentReply: true }],
    });
  });
});
