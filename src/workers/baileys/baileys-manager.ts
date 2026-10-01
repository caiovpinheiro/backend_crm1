import { prisma } from "@/lib/prisma";
// prismaBase sem org-scope: worker precisa listar canais cross-tenant no
// bootstrap. Cada canal depois executa sob seu proprio withSystemContext.
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { BaileysSession } from "./baileys-session";
import { syncChannelGroups } from "./sync-groups";
import { getLogger } from "@/lib/logger";

const log = getLogger("worker.baileys.baileys-manager");

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

    log.info({ count: channels.length }, "[baileys-manager] canais BAILEYS_MD para reconectar");

    for (const ch of channels) {
      await withSystemContext(ch.organizationId, () => this.connect(ch.id));
    }
  }

  async connect(channelId: string): Promise<void> {
    const existing = this.sessions.get(channelId);
    if (existing?.socket) {
      log.info({ channelId }, "[baileys-manager] Sessão já existe — ignorando");
      return;
    }

    const ch = await prismaBase.channel.findUnique({
      where: { id: channelId },
      select: { organizationId: true, provider: true },
    });
    if (!ch || ch.provider !== "BAILEYS_MD") {
      log.warn({ channelId }, "[baileys-manager] canal ausente ou não é BAILEYS_MD");
      return;
    }

    log.info({ channelId }, "[baileys-manager] Iniciando sessão");
    const session = new BaileysSession(channelId);
    this.sessions.set(channelId, session);

    try {
      await withSystemContext(ch.organizationId, () => session.connect());
    } catch (err) {
      log.error({ channelId, err }, "[baileys-manager] Erro ao conectar");
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
      log.info(
        { channelId },
        "[baileys-manager] Sem sessão em memória — reabrindo só para desvincular o aparelho",
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

  async syncGroups(channelId: string): Promise<void> {
    await syncChannelGroups(this, channelId);
  }

  async shutdownAll(): Promise<void> {
    for (const [id, session] of this.sessions) {
      log.info({ channelId: id }, "[baileys-manager] Encerrando sessão");
      await session.disconnect().catch(() => {});
    }
    this.sessions.clear();
  }
}
