import { prisma } from "@/lib/prisma";
// prismaBase sem org-scope: worker precisa listar canais cross-tenant no
// bootstrap. Cada canal depois executa sob seu proprio withSystemContext.
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { BaileysSession } from "./baileys-session";

/**
 * Manages multiple Baileys sessions (one per BAILEYS_MD channel).
 * On startup, reconnects all channels that were previously CONNECTED.
 */
export class BaileysManager {
  private sessions = new Map<string, BaileysSession>();

  async startAll(): Promise<void> {
    const channels = await prismaBase.channel.findMany({
      where: {
        provider: "BAILEYS_MD",
        status: { in: ["CONNECTED", "CONNECTING"] },
      },
      select: { id: true, organizationId: true },
    });

    console.info(`[baileys-manager] ${channels.length} canal(is) BAILEYS_MD para reconectar`);

    for (const ch of channels) {
      await withSystemContext(ch.organizationId, () => this.connect(ch.id));
    }
  }

  async connect(channelId: string): Promise<void> {
    const existing = this.sessions.get(channelId);
    if (existing?.socket) {
      console.info(`[baileys-manager] Sessão ${channelId} já existe — ignorando`);
      return;
    }

    const ch = await prismaBase.channel.findUnique({
      where: { id: channelId },
      select: { organizationId: true, provider: true },
    });
    if (!ch || ch.provider !== "BAILEYS_MD") {
      console.warn(`[baileys-manager] canal ${channelId} ausente ou não é BAILEYS_MD`);
      return;
    }

    console.info(`[baileys-manager] Iniciando sessão ${channelId}`);
    const session = new BaileysSession(channelId);
    this.sessions.set(channelId, session);

    try {
      await withSystemContext(ch.organizationId, () => session.connect());
    } catch (err) {
      console.error(`[baileys-manager] Erro ao conectar ${channelId}:`, err);
      await withSystemContext(ch.organizationId, () =>
        prisma.channel.update({
          where: { id: channelId },
          data: { status: "FAILED" },
        }),
      ).catch(() => {});
    }
  }

  async disconnect(channelId: string): Promise<void> {
    const session = this.sessions.get(channelId);
    if (session) {
      await session.disconnect();
      this.sessions.delete(channelId);
    }
  }

  async logout(channelId: string): Promise<void> {
    let session = this.sessions.get(channelId);
    if (!session) {
      const ch = await prismaBase.channel.findUnique({
        where: { id: channelId },
        select: { organizationId: true, provider: true },
      });
      if (!ch || ch.provider !== "BAILEYS_MD") return;
      console.info(
        `[baileys-manager] Sem sessão em memória — reabrindo ${channelId} só para desvincular o aparelho`,
      );
      session = new BaileysSession(channelId);
      this.sessions.set(channelId, session);
      await withSystemContext(ch.organizationId, () => session.connect());
    }
    await session.logout();
    this.sessions.delete(channelId);
  }

  getSession(channelId: string): BaileysSession | undefined {
    return this.sessions.get(channelId);
  }

  async shutdownAll(): Promise<void> {
    for (const [id, session] of this.sessions) {
      console.info(`[baileys-manager] Encerrando sessão ${id}`);
      await session.disconnect().catch(() => {});
    }
    this.sessions.clear();
  }
}
