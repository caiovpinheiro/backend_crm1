import { describe, expect, it } from "vitest";

import { isMetaOutboundTemplate, type MetaOutboundPayload } from "@/lib/queue";

function basePayload(
  extra?: Partial<MetaOutboundPayload>,
): MetaOutboundPayload {
  return {
    conversationId: "c1",
    messageId: "m1",
    organizationId: "org1",
    contactId: "ct1",
    content: "oi",
    ...extra,
  };
}

describe("meta-outbound payload kind", () => {
  it("treats missing kind as text (jobs antigos)", () => {
    expect(isMetaOutboundTemplate(basePayload())).toBe(false);
    expect(isMetaOutboundTemplate(basePayload({ kind: "text" }))).toBe(false);
  });

  it("requires kind=template and a template name", () => {
    expect(
      isMetaOutboundTemplate(basePayload({ kind: "template" })),
    ).toBe(false);
    expect(
      isMetaOutboundTemplate(
        basePayload({
          kind: "template",
          template: {
            templateName: "hello_world",
            languageCode: "pt_BR",
          },
        }),
      ),
    ).toBe(true);
  });
});
