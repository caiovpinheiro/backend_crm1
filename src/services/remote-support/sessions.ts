/**
 * Sessões de suporte remoto: o que o CRM guarda e orquestra.
 *
 * Fluxo: atendente inicia → o CRM cria um grupo exclusivo no MeshCentral e
 * devolve o link da página do cliente (`/suporte/{token}`) → a página baixa o
 * Assistant (só no Windows) → o cliente abre, aceita e conecta → o
 * atendente pede um link de controle com prazo → encerrar (ou expirar) apaga
 * o grupo no MeshCentral. A expiração é preguiçosa (na leitura), sem worker.
 */
import { randomBytes } from "node:crypto";

import type { RemoteSupportSession, RemoteSupportStatus } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { REMOTE_SUPPORT_WIDGET_SLUG } from "@/services/organization-widgets";

import {
  assistantDownloadUrl,
  createControlLink,
  createSessionGroup,
  listGroupNodes,
  MeshCentralError,
  type MeshNode,
  teardownSessionGroup,
} from "./meshcentral";

const log = getLogger("remote-support");

/** Validade da sessão/link do cliente (min). */
const SESSION_MINUTES = (() => {
  const n = Number(process.env.REMOTE_SUPPORT_SESSION_MINUTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
})();
/** Prazo máximo de um link de controle (min) — limitado ao que resta da sessão. */
const CONTROL_LINK_MAX_MINUTES = 30;
const ACTIVE_STATUSES: RemoteSupportStatus[] = ["WAITING", "CONNECTED"];
const HISTORY_LIMIT = 10;

export class RemoteSupportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RemoteSupportError";
  }
}

const withCreator = { createdBy: { select: { id: true, name: true } } } as const;
type SessionRow = RemoteSupportSession & { createdBy: { id: string; name: string | null } };

export type RemoteSupportSessionDto = {
  id: string;
  status: RemoteSupportStatus;
  contactId: string;
  /** Só enquanto ativa — depois do fim o link não serve para nada. */
  clientLink: string | null;
  deviceName: string | null;
  /** Assistant do cliente conectado agora. `null` = não consultado / servidor indisponível. */
  deviceOnline: boolean | null;
  expiresAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string | null };
};

function isActive(s: { status: RemoteSupportStatus }): boolean {
  return ACTIVE_STATUSES.includes(s.status);
}

/** Token da página do cliente: 32 caracteres base64url, impossível de adivinhar. */
const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function newClientToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Página pública do cliente, no frontend (mesma base dos e-mails de senha). */
function clientPageUrl(token: string | null): string | null {
  const base = (process.env.NEXTAUTH_URL ?? "").trim().replace(/\/$/, "");
  return token && base ? `${base}/suporte/${token}` : null;
}

function serializeSession(s: SessionRow, deviceOnline: boolean | null = null): RemoteSupportSessionDto {
  return {
    id: s.id,
    status: s.status,
    contactId: s.contactId,
    clientLink: isActive(s) && s.meshId ? clientPageUrl(s.clientToken) : null,
    deviceName: s.deviceName,
    deviceOnline: isActive(s) ? deviceOnline : null,
    expiresAt: s.expiresAt.toISOString(),
    connectedAt: s.connectedAt?.toISOString() ?? null,
    endedAt: s.endedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    createdBy: s.createdBy,
  };
}

/** Aceita CUID ou número do contato (o prisma com escopo reescreve id numérico). */
async function resolveContact(contactIdOrNumber: string): Promise<{ id: string; name: string }> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactIdOrNumber },
    select: { id: true, name: true },
  });
  if (!contact) throw new RemoteSupportError("Contato não encontrado.", 404);
  return contact;
}

/**
 * Corta o acesso e apaga o grupo sem derrubar a operação: o status no banco é a
 * fonte da verdade. Falha aqui pode deixar o Assistant conectado — vai como erro.
 */
async function dropGroup(meshId: string | null): Promise<void> {
  if (!meshId) return;
  try {
    await teardownSessionGroup(meshId);
  } catch (err) {
    log.error(`Falha ao encerrar o grupo ${meshId} no MeshCentral:`, err);
  }
}

async function closeSession(s: SessionRow, status: "ENDED" | "EXPIRED"): Promise<SessionRow> {
  await dropGroup(s.meshId);
  return prisma.remoteSupportSession.update({
    where: { id: s.id },
    data: { status, endedAt: new Date() },
    include: withCreator,
  });
}

async function expireIfStale(s: SessionRow): Promise<SessionRow> {
  if (isActive(s) && s.expiresAt.getTime() <= Date.now()) return closeSession(s, "EXPIRED");
  return s;
}

async function getRow(id: string): Promise<SessionRow> {
  const s = await prisma.remoteSupportSession.findFirst({ where: { id }, include: withCreator });
  if (!s) throw new RemoteSupportError("Sessão de suporte não encontrada.", 404);
  return s;
}

export async function startSession(opts: {
  orgId: string;
  userId: string;
  contactIdOrNumber: string;
}): Promise<RemoteSupportSessionDto> {
  const contact = await resolveContact(opts.contactIdOrNumber);

  // Já existe uma ativa para este contato? Reaproveita — não cria grupo órfão.
  const existing = await prisma.remoteSupportSession.findFirst({
    where: { contactId: contact.id, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
    include: withCreator,
  });
  if (existing) {
    const fresh = await expireIfStale(existing);
    if (isActive(fresh)) return serializeSession(fresh);
  }

  const session = await prisma.remoteSupportSession.create({
    data: {
      organizationId: opts.orgId,
      contactId: contact.id,
      createdById: opts.userId,
      clientToken: newClientToken(),
      expiresAt: new Date(Date.now() + SESSION_MINUTES * 60_000),
    },
    include: withCreator,
  });

  try {
    const meshId = await createSessionGroup(
      `Bwipo ${session.id}`,
      `Suporte remoto — ${contact.name}`.slice(0, 200),
    );
    const updated = await prisma.remoteSupportSession.update({
      where: { id: session.id },
      data: { meshId },
      include: withCreator,
    });
    return serializeSession(updated);
  } catch (err) {
    await prisma.remoteSupportSession.update({
      where: { id: session.id },
      data: { status: "FAILED", endedAt: new Date() },
    });
    throw err;
  }
}

/** Lê a sessão e confere no MeshCentral se o Assistant do cliente conectou. */
async function refreshRow(id: string): Promise<{ row: SessionRow; deviceOnline: boolean | null }> {
  const s = await expireIfStale(await getRow(id));
  if (!isActive(s) || !s.meshId) return { row: s, deviceOnline: null };

  let nodes: MeshNode[];
  try {
    nodes = await listGroupNodes(s.meshId);
  } catch (err) {
    if (err instanceof MeshCentralError && err.code === "NOT_CONFIGURED") throw err;
    log.warn(`Consulta de dispositivos falhou (sessão ${s.id}):`, err);
    return { row: s, deviceOnline: null };
  }

  const device = nodes.find((n) => n.online) ?? nodes[0];
  if (!device) return { row: s, deviceOnline: false };

  if (s.status === "WAITING" || s.nodeId !== device.nodeId) {
    const row = await prisma.remoteSupportSession.update({
      where: { id: s.id },
      data: {
        status: "CONNECTED",
        nodeId: device.nodeId,
        deviceName: device.name,
        connectedAt: s.connectedAt ?? new Date(),
      },
      include: withCreator,
    });
    return { row, deviceOnline: device.online };
  }
  return { row: s, deviceOnline: device.online };
}

export async function refreshSession(id: string): Promise<RemoteSupportSessionDto> {
  const { row, deviceOnline } = await refreshRow(id);
  return serializeSession(row, deviceOnline);
}

/** Últimas sessões do contato (as vencidas são expiradas aqui mesmo). */
export async function listContactSessions(contactIdOrNumber: string): Promise<RemoteSupportSessionDto[]> {
  const contact = await resolveContact(contactIdOrNumber);
  const rows = await prisma.remoteSupportSession.findMany({
    where: { contactId: contact.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    include: withCreator,
  });
  const fresh = await Promise.all(rows.map(expireIfStale));
  return fresh.map((r) => serializeSession(r));
}

/** Link de controle com prazo; só com o Assistant do cliente online. */
export async function createSessionControlLink(
  id: string,
  guestName: string,
): Promise<{ url: string; session: RemoteSupportSessionDto }> {
  const { row, deviceOnline } = await refreshRow(id);
  if (!isActive(row)) throw new RemoteSupportError("Esta sessão já foi encerrada.", 409);
  if (!row.nodeId || deviceOnline !== true) {
    throw new RemoteSupportError("O cliente ainda não está conectado.", 409);
  }
  const remaining = Math.ceil((row.expiresAt.getTime() - Date.now()) / 60_000);
  const minutes = Math.max(1, Math.min(CONTROL_LINK_MAX_MINUTES, remaining));
  const url = await createControlLink(row.nodeId, guestName, minutes);
  return { url, session: serializeSession(row, deviceOnline) };
}

/** Encerra: apaga o grupo no MeshCentral (e o dispositivo do cliente com ele). */
export async function endSession(id: string): Promise<RemoteSupportSessionDto> {
  const s = await getRow(id);
  if (!isActive(s)) return serializeSession(s);
  return serializeSession(await closeSession(s, "ENDED"));
}

/** O que a página pública do cliente mostra. Nada do contato nem do atendente. */
export type RemoteSupportClientView = {
  /** `waiting` = falta abrir o Assistant; `connected` = já conectou; `closed` = encerrada ou vencida. */
  state: "waiting" | "connected" | "closed";
  organizationName: string;
  /** Assistant (Windows) já configurado para a sessão; só enquanto ativa. */
  downloadUrl: string | null;
  expiresAt: string | null;
};

/**
 * Leitura pela página do cliente, sem sessão de login: o token é a única
 * credencial. `prismaBase` porque não há org no contexto (a org sai da linha
 * achada pelo token). Só lê — a expiração é gravada pela leitura do atendente.
 * Org que desinstalou o widget: o link deixa de existir (404), mesmo com
 * sessão ativa no banco.
 */
export async function getClientView(token: string): Promise<RemoteSupportClientView | null> {
  if (!CLIENT_TOKEN_RE.test(token)) return null;
  const s = await prismaBase.remoteSupportSession.findUnique({
    where: { clientToken: token },
    select: {
      status: true,
      meshId: true,
      expiresAt: true,
      organizationId: true,
      organization: { select: { name: true } },
    },
  });
  if (!s) return null;
  const widget = await prismaBase.organizationWidget.findUnique({
    where: {
      organizationId_widgetSlug: {
        organizationId: s.organizationId,
        widgetSlug: REMOTE_SUPPORT_WIDGET_SLUG,
      },
    },
    select: { status: true },
  });
  if (widget?.status !== "ACTIVE") return null;
  const open = isActive(s) && Boolean(s.meshId) && s.expiresAt.getTime() > Date.now();
  return {
    state: !open ? "closed" : s.status === "CONNECTED" ? "connected" : "waiting",
    organizationName: s.organization.name,
    downloadUrl: open && s.meshId ? assistantDownloadUrl(s.meshId) : null,
    expiresAt: open ? s.expiresAt.toISOString() : null,
  };
}
