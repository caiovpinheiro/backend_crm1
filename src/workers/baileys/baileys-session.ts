import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type BaileysEventMap,
  type AnyMessageContent,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { Prisma } from "@prisma/client";
import QRCode from "qrcode";

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { sseBus } from "@/lib/sse-bus";
import { withSystemContext } from "@/lib/webhook-context";
import { usePostgresAuthState } from "./auth-state-postgres";
import { handleBaileysMessage } from "./message-handler";
import { registerLidMapping, getMapSize, clearChannelMap, loadPersistedMappings, fixLidContacts } from "./lid-resolver";

const RECONNECT_MAX_RETRIES = 8;
const RECONNECT_BASE_DELAY_MS = 2_000;
const QR_TIMEOUT_MS = 60_000;

export class BaileysSession {
  channelId: string;
  socket: WASocket | null = null;
  private retryCount = 0;
  private qrTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  // Cacheado no `connect()` p/ que cada `messages.upsert` rode sob
  // withSystemContext sem fazer roundtrip ao DB por mensagem. Sem o
  // contexto, ensureOpenDealForContact falhava silenciosamente —
  // contato + conversa criavam, mas o deal "Lead de Entrada" não.
  private organizationId: string | null = null;

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  async connect(): Promise<void> {
    // Cache do organizationId do channel — usado em todo callback
    // `messages.upsert` para garantir AsyncLocalStorage scope.
    if (!this.organizationId) {
      const ch = await prismaBase.channel.findUnique({
        where: { id: this.channelId },
        select: { organizationId: true },
      });
      if (!ch) {
        console.error(`[baileys:${this.channelId}] channel não existe — abortando connect`);
        return;
      }
      this.organizationId = ch.organizationId;
    }

    if (this.destroyed) return;

    const loaded = await loadPersistedMappings(this.channelId);
    if (loaded > 0) {
      console.info(`[baileys:${this.channelId}] carregou ${loaded} mapeamentos LID→phone do banco`);
    }

    const { state, saveCreds } = await usePostgresAuthState(this.channelId);

    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      console.info(`[baileys:${this.channelId}] usando versão WA ${version.join(".")}`);
    } catch {
      version = [2, 3000, 1034074495];
      console.warn(`[baileys:${this.channelId}] fallback para versão ${version.join(".")}`);
    }

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys),
      },
      version,
      printQRInTerminal: false,
      browser: ["CRM Eduit", "Chrome", "4.0.0"],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    this.socket = sock;

    sock.ev.on("creds.update", () => {
      const orgId = this.organizationId;
      if (!orgId) return;
      void withSystemContext(orgId, saveCreds);
    });

    sock.ev.on("connection.update", (update) => {
      void this.handleConnectionUpdate(update);
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      let newMappings = 0;
      for (const c of contacts as Array<{ id?: string; lid?: string }>) {
        if (c.lid && c.id && c.id.endsWith("@s.whatsapp.net")) {
          registerLidMapping(this.channelId, c.lid, c.id);
          newMappings++;
        }
      }
      console.info(
        `[baileys:${this.channelId}] contacts.upsert: ${contacts.length} contatos, ${newMappings} LIDs mapeados (total ${getMapSize(this.channelId)})`,
      );
      if (newMappings > 0) {
        fixLidContacts(this.channelId).then((fixed) => {
          if (fixed > 0) console.info(`[baileys:${this.channelId}] ${fixed} contatos com LID corrigidos`);
        }).catch(() => {});
      }
    });

    sock.ev.on("contacts.update", (updates) => {
      for (const c of updates as Array<{ id?: string; lid?: string }>) {
        if (c.lid && c.id && c.id.endsWith("@s.whatsapp.net")) {
          registerLidMapping(this.channelId, c.lid, c.id);
        }
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      const orgId = this.organizationId;
      if (!orgId) {
        console.warn(`[baileys:${this.channelId}] mensagens recebidas sem organizationId cacheado — descartando`);
        return;
      }
      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        // CRITICAL: o callback `sock.ev.on` é disparado fora do
        // AsyncLocalStorage scope estabelecido em BaileysManager. Sem
        // o `withSystemContext` aqui, queries scoped (prisma extension
        // + withOrgFromCtx) e helpers que dependem de `getOrgIdOrThrow`
        // (ex.: ensureOpenDealForContact → criação do deal "Lead de
        // Entrada") falhavam silenciosamente — contato e conversa eram
        // criados, mas o deal não.
        void withSystemContext(orgId, () => handleBaileysMessage(this.channelId, msg, sock));
      }
    });

    sock.ev.on("messages.update", (updates) => {
      // Mesmo motivo do messages.upsert: callback fora do ALS → precisa
      // withSystemContext, senão prisma scoped joga e o ACK (incl. read)
      // nunca grava — ticks azuis nunca aparecem ao vivo.
      for (const u of updates) {
        const status = u.update?.status;
        if (status !== undefined && status !== null && u.key?.id) {
          void this.handleMessageStatusUpdate(u.key.id, status as number);
        }
      }
    });
  }

  private async handleMessageStatusUpdate(wamid: string, baileysStatus: number) {
    const statusMap: Record<number, string> = { 2: "sent", 3: "delivered", 4: "read" };
    const s = statusMap[baileysStatus];
    if (!s) return;

    const orgId = this.organizationId;
    if (!orgId) {
      console.warn(
        `[baileys:${this.channelId}] status ${s} sem organizationId cacheado — descartando`,
      );
      return;
    }

    try {
      await withSystemContext(orgId, async () => {
        const msg = await prisma.message.findFirst({
          where: { externalId: wamid },
          select: { id: true, externalId: true, sendStatus: true, conversationId: true },
        });
        if (!msg) return;

        const priority: Record<string, number> = {
          failed: 0,
          sent: 1,
          delivered: 2,
          read: 3,
        };
        // sendStatus pode vir em MAIÚSCULAS de outros caminhos — normaliza.
        const current = (msg.sendStatus ?? "").toLowerCase();
        if ((priority[s] ?? 0) <= (priority[current] ?? -1)) return;

        await prisma.message.update({
          where: { id: msg.id },
          data: { sendStatus: s },
        });

        // O front usa `externalId ?? id` como id da bolha; publicar só o
        // UUID interno faz o update otimista do tick (incl. read azul)
        // nunca casar. Envia bubbleId + internalId, igual ao path Meta.
        sseBus.publish("message_status", {
          organizationId: orgId,
          conversationId: msg.conversationId,
          messageId: msg.externalId ?? msg.id,
          internalId: msg.id,
          status: s,
        });
      });
    } catch (err) {
      console.warn(`[baileys:${this.channelId}] Erro ao atualizar status:`, err);
    }
  }

  private async patchChannel(
    data: Prisma.ChannelUpdateInput,
    status?: string,
  ): Promise<void> {
    const orgId = this.organizationId;
    if (!orgId) {
      console.warn(`[baileys:${this.channelId}] patchChannel sem organizationId`);
      return;
    }
    await withSystemContext(orgId, async () => {
      await prisma.channel.update({
        where: { id: this.channelId },
        data,
      });
    });
    try {
      sseBus.publish("channel_updated", {
        organizationId: orgId,
        channelId: this.channelId,
        status: status ?? (typeof data.status === "string" ? data.status : undefined),
      });
    } catch {
      /* best-effort */
    }
  }

  private async handleConnectionUpdate(
    update: Partial<BaileysEventMap["connection.update"]>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.clearQrTimer();
      try {
        const qrDataUri = await QRCode.toDataURL(qr, { margin: 1 });
        await this.patchChannel({ status: "QR_READY", qrCode: qrDataUri }, "QR_READY");
        console.info(`[baileys:${this.channelId}] QR code gerado`);

        this.qrTimer = setTimeout(() => {
          console.info(`[baileys:${this.channelId}] QR expirado — timeout`);
          void this.patchChannel(
            { status: "DISCONNECTED", qrCode: null },
            "DISCONNECTED",
          );
        }, QR_TIMEOUT_MS);
      } catch (e) {
        console.error(`[baileys:${this.channelId}] erro ao gerar QR:`, e);
      }
    }

    if (connection === "open") {
      this.clearQrTimer();
      this.retryCount = 0;
      const me = this.socket?.user;
      const phone = me?.id?.split(":")[0] ?? me?.id?.split("@")[0] ?? null;

      await this.patchChannel(
        {
          status: "CONNECTED",
          qrCode: null,
          lastConnectedAt: new Date(),
          phoneNumber: phone,
        },
        "CONNECTED",
      );
      console.info(`[baileys:${this.channelId}] conectado — ${phone ?? "sem número"}`);
      const { enqueueBaileysControl } = await import("@/lib/queue");
      void enqueueBaileysControl({ channelId: this.channelId, action: "sync-groups" });
    }

    if (connection === "close") {
      this.clearQrTimer();
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : undefined;

      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.info(`[baileys:${this.channelId}] deslogado — limpando sessão`);
        const orgId = this.organizationId;
        if (orgId) {
          await withSystemContext(orgId, async () => {
            await prisma.baileysAuthKey.deleteMany({ where: { channelId: this.channelId } });
          });
        }
        await this.patchChannel(
          { status: "DISCONNECTED", qrCode: null, sessionData: Prisma.JsonNull },
          "DISCONNECTED",
        );
        this.socket = null;
        return;
      }

      if (this.destroyed) {
        this.socket = null;
        return;
      }

      if (this.retryCount >= RECONNECT_MAX_RETRIES) {
        console.error(`[baileys:${this.channelId}] máximo de tentativas atingido — FAILED`);
        await this.patchChannel({ status: "FAILED", qrCode: null }, "FAILED");
        this.socket = null;
        return;
      }

      const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.retryCount);
      this.retryCount++;
      console.info(
        `[baileys:${this.channelId}] desconectado (status=${statusCode}) — reconectando em ${delay}ms (tentativa ${this.retryCount})`,
      );

      await this.patchChannel({ status: "CONNECTING" }, "CONNECTING");

      setTimeout(() => {
        if (!this.destroyed) void this.connect();
      }, delay);
    }
  }

  async sendMessage(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> {
    if (!this.socket) throw new Error("Socket não conectado");
    return this.socket.sendMessage(jid, content);
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.clearQrTimer();
    clearChannelMap(this.channelId);
    try {
      this.socket?.end(undefined);
    } catch {
      /* best-effort */
    }
    this.socket = null;
    await this.patchChannel({ status: "DISCONNECTED", qrCode: null }, "DISCONNECTED");
  }

  async logout(): Promise<void> {
    this.clearQrTimer();
    clearChannelMap(this.channelId);
    if (!this.socket) {
      await this.connect();
      await this.waitForOpen(8_000);
    } else if (!this.socket.user) {
      await this.waitForOpen(4_000);
    }
    this.destroyed = true;
    try {
      if (this.socket) {
        await this.socket.logout();
        console.info(`[baileys:${this.channelId}] logout enviado ao WhatsApp`);
      }
    } catch (err) {
      console.warn(`[baileys:${this.channelId}] logout falhou:`, err);
      try {
        this.socket?.end(undefined);
      } catch {
        /* best-effort */
      }
    }
    this.socket = null;
    const orgId = this.organizationId;
    if (orgId) {
      await withSystemContext(orgId, async () => {
        await prisma.baileysAuthKey.deleteMany({ where: { channelId: this.channelId } });
      });
    }
    await this.patchChannel(
      { status: "DISCONNECTED", qrCode: null, sessionData: Prisma.JsonNull },
      "DISCONNECTED",
    );
  }

  private waitForOpen(ms: number): Promise<void> {
    if (this.socket?.user) return Promise.resolve();
    const sock = this.socket;
    if (!sock) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sock.ev.off("connection.update", onUp);
        resolve();
      }, ms);
      const onUp = (update: Partial<BaileysEventMap["connection.update"]>) => {
        if (update.connection === "open") {
          clearTimeout(timer);
          sock.ev.off("connection.update", onUp);
          resolve();
        }
      };
      sock.ev.on("connection.update", onUp);
    });
  }

  private clearQrTimer() {
    if (this.qrTimer) {
      clearTimeout(this.qrTimer);
      this.qrTimer = null;
    }
  }
}
