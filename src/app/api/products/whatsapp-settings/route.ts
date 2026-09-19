import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getOrgSetting, setOrgSetting } from "@/lib/org-settings";
import {
  isProductWhatsAppSendMode,
  parseProductWhatsAppSendMode,
  PRODUCT_WHATSAPP_SEND_MODE_KEY,
  PRODUCT_WHATSAPP_SEND_MODES,
} from "@/lib/product-whatsapp-send-mode";

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const sendMode = parseProductWhatsAppSendMode(
      await getOrgSetting(PRODUCT_WHATSAPP_SEND_MODE_KEY),
    );
    return NextResponse.json({
      sendMode,
      modes: PRODUCT_WHATSAPP_SEND_MODES,
    });
  });
}

export async function PUT(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:edit");
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const sendMode = rec.sendMode;
    if (!isProductWhatsAppSendMode(sendMode)) {
      return NextResponse.json(
        {
          message: `sendMode inválido. Use: ${PRODUCT_WHATSAPP_SEND_MODES.join(", ")}.`,
        },
        { status: 400 },
      );
    }

    await setOrgSetting(PRODUCT_WHATSAPP_SEND_MODE_KEY, sendMode);
    return NextResponse.json({ sendMode });
  });
}
