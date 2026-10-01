/**
 * /api/profile
 * ────────────
 * Perfil do usuário autenticado. Usado pela sidebar (GET para hidratar o
 * popover de conta) e pela página `/settings/profile` (GET + PUT).
 *
 * Campos editáveis pelo dono da sessão:
 *  - name, email  (identidade)
 *  - avatarUrl    (upload via /api/profile/avatar grava e depois este PUT
 *                  só persiste a URL retornada; PUT com string vazia limpa
 *                  o avatar e volta ao fallback de iniciais)
 *  - phone        (opcional, formato livre)
 *  - signature    (assinatura anexada às mensagens — vazio = usa name)
 *  - closingMessage (sobrescreve a mensagem de encerramento da organização)
 *  - currentPassword + newPassword (rotação de senha protegida)
 *
 * Troca de senha e sessões (SV-1/SV-2): a senha nova incrementa
 * `users.sessionVersion` no mesmo UPDATE — todas as sessões do usuário
 * caem. A resposta traz `sessionRenewal` (prova de uso único, 60 s) para a
 * sessão que fez o pedido continuar: o cliente chama
 * `update({ sessionRenewal: token })` do `useSession` e recebe o cookie na
 * versão nova. Sem esse passo, esta sessão cai como as outras.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { Prisma } from "@prisma/client";

import { auth } from "@/lib/auth";
import { issueSessionRenewal } from "@/lib/auth/session-renewal";
import {
  SESSION_VERSION_BUMP,
  notifySessionsRevoked,
} from "@/lib/auth/session-revocation";
import { sessionVersionFromClaim } from "@/lib/auth/session-version";
import { CHAT_THEME_KEYS } from "@/lib/chat-theme";
import { prisma } from "@/lib/prisma";

/** Campos do perfil sem `chatTheme` — usado se o banco ainda não tiver a migration. */
const PROFILE_SELECT_CORE = {
  id: true,
  name: true,
  email: true,
  role: true,
  avatarUrl: true,
  phone: true,
  signature: true,
  closingMessage: true,
  createdAt: true,
} as const;

const PROFILE_SELECT = {
  ...PROFILE_SELECT_CORE,
  chatTheme: true,
} as const;

const DEFAULT_CHAT_THEME_DB = "azul";

function isMissingUserChatThemeColumn(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2022") return true;
  }
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    msg.includes("chattheme") ||
    msg.includes("chat_theme") ||
    (msg.includes("column") && msg.includes("does not exist"))
  );
}

const chatThemeEnum = z.enum(CHAT_THEME_KEYS);

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: PROFILE_SELECT,
    });
    return NextResponse.json(user);
  } catch (e) {
    if (!isMissingUserChatThemeColumn(e)) throw e;
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: PROFILE_SELECT_CORE,
    });
    return NextResponse.json(
      user ? { ...user, chatTheme: DEFAULT_CHAT_THEME_DB } : user,
    );
  }
}

const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().max(320).optional(),
    avatarUrl: z.union([z.string().max(2000), z.null()]).optional(),
    phone: z.union([z.string().max(80), z.null()]).optional(),
    signature: z.union([z.string().max(500), z.null()]).optional(),
    closingMessage: z.union([z.string().max(2000), z.null()]).optional(),
    chatTheme: chatThemeEnum.optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(1).max(200).optional(),
  });

/** Sanitiza string opcional: trim + conversão de "" em null para limpar campo. */
function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const parsed = updateProfileSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Dados inválidos.", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json(
        { message: "Nome não pode ficar vazio." },
        { status: 400 },
      );
    }
    data.name = name;
  }

  if (body.email !== undefined) {
    const email = body.email.trim().toLowerCase();
    if (!email) {
      return NextResponse.json(
        { message: "E-mail não pode ficar vazio." },
        { status: 400 },
      );
    }
    data.email = email;
  }

  const avatar = nullableString(body.avatarUrl);
  if (avatar !== undefined) data.avatarUrl = avatar;

  const phone = nullableString(body.phone);
  if (phone !== undefined) data.phone = phone;

  const signature = nullableString(body.signature);
  if (signature !== undefined) data.signature = signature;

  const closing = nullableString(body.closingMessage);
  if (closing !== undefined) data.closingMessage = closing;

  if (body.chatTheme !== undefined) {
    data.chatTheme = body.chatTheme;
  }

  if (body.newPassword && body.currentPassword) {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });
    if (!user || !user.hashedPassword) {
      return NextResponse.json(
        { message: "Usuário não encontrado." },
        { status: 404 },
      );
    }
    const valid = await bcrypt.compare(body.currentPassword, user.hashedPassword);
    if (!valid) {
      return NextResponse.json(
        { message: "Senha atual incorreta." },
        { status: 400 },
      );
    }
    data.hashedPassword = await bcrypt.hash(body.newPassword, 10);
    // SV-1: senha nova derruba todas as sessões. Mesmo UPDATE da senha:
    // sem janela entre os dois. SV-2: esta sessão recebe a prova para se
    // renovar (`respond` abaixo); as demais caem.
    Object.assign(data, SESSION_VERSION_BUMP);
  }
  const passwordChanged = Boolean(data.hashedPassword);

  /**
   * Pós-commit: notifica a revogação e monta a resposta. `sessionVersion`
   * vem do UPDATE só para emitir a prova — não vai no corpo.
   */
  const respond = async (
    updated: Record<string, unknown> & { sessionVersion: number },
    extra: Record<string, unknown> = {},
  ) => {
    const { sessionVersion: newVersion, ...profile } = updated;
    if (!passwordChanged) return NextResponse.json({ ...profile, ...extra });
    notifySessionsRevoked({
      userId: session.user.id,
      organizationId: session.user.organizationId ?? null,
      reason: "password_change",
    });
    const sessionRenewal = await issueSessionRenewal({
      userId: session.user.id,
      newVersion,
      tokenVersion: sessionVersionFromClaim(
        (session.user as { sessionVersion?: unknown }).sessionVersion,
      ),
    });
    return NextResponse.json({
      ...profile,
      ...extra,
      ...(sessionRenewal ? { sessionRenewal } : {}),
    });
  };

  try {
    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data,
      select: { ...PROFILE_SELECT, sessionVersion: true },
    });
    return await respond(updated);
  } catch (e) {
    if (!isMissingUserChatThemeColumn(e)) throw e;
    const { chatTheme: _drop, ...dataWithoutTheme } = data;
    if (Object.keys(dataWithoutTheme).length === 0) {
      return NextResponse.json(
        {
          code: "CHAT_THEME_COLUMN_MISSING",
          message:
            "A coluna chatTheme ainda não existe no banco. Aplique as migrations (ex.: npx prisma migrate deploy).",
        },
        { status: 503 },
      );
    }
    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data: dataWithoutTheme,
      select: { ...PROFILE_SELECT_CORE, sessionVersion: true },
    });
    return await respond(updated, { chatTheme: DEFAULT_CHAT_THEME_DB });
  }
}
