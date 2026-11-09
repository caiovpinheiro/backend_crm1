// prismaBase sem org-scope: worker precisa listar canais cross-tenant no
// bootstrap. Cada canal depois executa sob seu proprio withSystemContext.
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { credsAreRegistered } from "./auth-state-postgres";
import { BaileysSession } from "./baileys-session";
import { backoffDelayMs } from "./reconnect-policy";
import { PROCESS_OWNER, SESSION_LOCK_RENEW_MS, SessionLock } from "./session-lock";
import { syncChannelGroups } from "./sync-groups";
import { getLogger } from "@/lib/logger";

const log = getLogger("worker.baileys.baileys-manager");

/** Espera entre tentativas de pegar a trava de um canal que outro processo segura. */
export const LOCK_WAIT_RETRY_MS = 10_000;

/**
 * Canal que o boot reabre: tem credencial pareada (QR já lido) e não foi
 * marcado como "precisa de QR". O status salvo não importa — um deploy
 * antigo pode ter gravado DISCONNECTED. O "Desconectar" da tela faz logout
 * e apaga a credencial, então canal desligado pelo usuário nunca volta.
 * Canais CONNECTED/CONNECTING sem credencial (QR em andamento) também entram.
 */
export function shouldReconnectOnBoot(input: {
  status: string;
  sessionData: unknown;
  credsValue: unknown | null;
}): boolean {
  const last =
    input.sessionData && typeof input.sessionData === "object"
      ? (input.sessionData as { lastDisconnect?: { action?: unknown } }).lastDisconnect
      : undefined;
  if (input.status === "FAILED" && last?.action === "needs_qr") return false;
  if (credsAreRegistered(input.credsValue)) return true;
  return input.status === "CONNECTED" || input.status === "CONNECTING";
}

/**
 * Manages multiple Baileys sessions (one per BAILEYS_MD channel).
 * Uma sessão por canal neste processo, e um processo por canal no cluster
 * (trava no Redis — `session-lock.ts`).
 */
export class BaileysManager {
  private sessions = new Map<string, BaileysSession>();
  private lockWaitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lockWaitAttempts = new Map<string, number>();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(private readonly lock: SessionLock | null = null) {}

  async startAll(): Promise<void> {
    const channels = await prismaBase.channel.findMany({
      where: { provider: "BAILEYS_MD" },
      select: { id: true, organizationId: true, status: true, sessionData: true },
    });
    const creds = channels.length
      ? await prismaBase.baileysAuthKey.findMany({
          where: {
            channelId: { in: channels.map((c) => c.id) },
            keyType: "creds",
            keyId: "creds",
          },
          select: { channelId: true, value: true },
        })
      : [];
    const credsByChannel = new Map(creds.map((c) => [c.channelId, c.value]));

    const toStart = channels.filter((ch) =>
      shouldReconnectOnBoot({
        status: ch.status,
        sessionData: ch.sessionData,
        credsValue: credsByChannel.get(ch.id) ?? null,
      }),
    );

    log.info(
      { total: channels.length, reconectar: toStart.length, owner: PROCESS_OWNER },
      "[baileys-manager] canais BAILEYS_MD para reconectar",
    );

    this.startRenewLoop();
    for (const ch of toStart) {
      await withSystemContext(ch.organizationId, () => this.connect(ch.id)).catch((err) =>
        log.error({ channelId: ch.id, err }, "[baileys-manager] erro ao iniciar canal no boot"),
      );
    }
  }

  async connect(channelId: string): Promise<void> {
    if (this.shuttingDown) return;
    const existing = this.sessions.get(channelId);
    if (existing && !existing.isDestroyed) {
      if (existing.socket) {
        log.info({ channelId }, "[baileys-manager] Sessão já existe — ignorando");
        return;
      }
      // Sessão viva esperando reconexão: conecta agora em vez de criar outra.
      log.info({ channelId }, "[baileys-manager] Sessão em reconexão — conectando agora");
      await existing.connectNow();
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

    if (this.lock) {
      const got = await this.lock.acquire(channelId).catch((err) => {
        log.error({ channelId, err }, "[baileys-manager] Redis indisponível ao pegar a trava");
        return false;
      });
      if (!got) {
        const holder = await this.lock.holder(channelId).catch(() => null);
        this.scheduleLockWait(channelId, holder);
        return;
      }
    }
    this.clearLockWait(channelId);

    log.info({ channelId, owner: PROCESS_OWNER }, "[baileys-manager] Iniciando sessão");
    const session = this.newSession(channelId);
    this.sessions.set(channelId, session);

    try {
      await withSystemContext(ch.organizationId, () => session.connect());
    } catch (err) {
      // Banco/rede fora antes de abrir o socket: não desiste (antes virava
      // FAILED para sempre). Tenta de novo pela mesma regra de espera.
      log.error({ channelId, err }, "[baileys-manager] Erro ao conectar — nova tentativa agendada");
      await session.stop().catch(() => {});
      this.sessions.delete(channelId);
      this.scheduleLockWait(channelId, null, true);
    }
  }

  private newSession(channelId: string): BaileysSession {
    return new BaileysSession(channelId, {
      stillOwner: async () => (this.lock ? this.lock.renew(channelId) : true),
      onLostOwnership: () => {
        void this.dropSession(channelId, "perdeu a trava");
      },
    });
  }

  /** Encerra a sessão local sem mudar status e volta a esperar a trava. */
  private async dropSession(channelId: string, motivo: string): Promise<void> {
    const session = this.sessions.get(channelId);
    log.warn({ channelId, motivo, owner: PROCESS_OWNER }, "[baileys-manager] sessão local encerrada");
    this.sessions.delete(channelId);
    await session?.stop().catch(() => {});
    if (!this.shuttingDown) this.scheduleLockWait(channelId, null);
  }

  private scheduleLockWait(channelId: string, holder: string | null, afterError = false): void {
    if (this.shuttingDown) return;
    this.clearLockWait(channelId, false);
    const attempt = (this.lockWaitAttempts.get(channelId) ?? 0) + 1;
    this.lockWaitAttempts.set(channelId, attempt);
    const delay = afterError ? backoffDelayMs(attempt) : LOCK_WAIT_RETRY_MS;
    log.info(
      { channelId, holder, owner: PROCESS_OWNER, proximaEmMs: delay, tentativa: attempt },
      afterError
        ? "[baileys-manager] conexão falhou — tentando de novo"
        : "[baileys-manager] trava com outro processo — aguardando",
    );
    const timer = setTimeout(() => {
      this.lockWaitTimers.delete(channelId);
      void prismaBase.channel
        .findUnique({ where: { id: channelId }, select: { organizationId: true } })
        .then((ch) =>
          ch ? withSystemContext(ch.organizationId, () => this.connect(channelId)) : undefined,
        )
        .catch((err) => log.error({ channelId, err }, "[baileys-manager] nova tentativa falhou"));
    }, delay);
    this.lockWaitTimers.set(channelId, timer);
  }

  private clearLockWait(channelId: string, resetAttempts = true): void {
    const t = this.lockWaitTimers.get(channelId);
    if (t) clearTimeout(t);
    this.lockWaitTimers.delete(channelId);
    if (resetAttempts) this.lockWaitAttempts.delete(channelId);
  }

  /** Renova a trava de todo canal com sessão aberta; quem perdeu, larga. */
  private startRenewLoop(): void {
    if (!this.lock || this.renewTimer) return;
    this.renewTimer = setInterval(() => {
      void this.renewAll();
    }, SESSION_LOCK_RENEW_MS);
    if (typeof this.renewTimer.unref === "function") this.renewTimer.unref();
  }

  async renewAll(): Promise<void> {
    if (!this.lock) return;
    for (const [channelId, session] of this.sessions) {
      if (session.isDestroyed) continue;
      const ok = await this.lock.renew(channelId).catch((err) => {
        // Redis instável: não derruba o WhatsApp por isso; tenta no próximo ciclo.
        log.warn({ channelId, err }, "[baileys-manager] renovação da trava falhou (Redis)");
        return true;
      });
      if (!ok) await this.dropSession(channelId, "trava expirou ou foi tomada");
    }
  }

  async disconnect(channelId: string): Promise<void> {
    this.clearLockWait(channelId);
    const session = this.sessions.get(channelId);
    if (session) {
      await session.disconnect();
      this.sessions.delete(channelId);
    }
    await this.lock?.release(channelId).catch(() => {});
  }

  async logout(channelId: string): Promise<void> {
    this.clearLockWait(channelId);
    let session = this.sessions.get(channelId);
    if (!session || session.isDestroyed) {
      const ch = await prismaBase.channel.findUnique({
        where: { id: channelId },
        select: { organizationId: true, provider: true },
      });
      if (!ch || ch.provider !== "BAILEYS_MD") return;
      log.info(
        { channelId },
        "[baileys-manager] Sem sessão em memória — reabrindo só para desvincular o aparelho",
      );
      session = this.newSession(channelId);
      this.sessions.set(channelId, session);
      const s = session;
      await withSystemContext(ch.organizationId, () => s.connect());
    }
    await session.logout();
    this.sessions.delete(channelId);
    await this.lock?.release(channelId).catch(() => {});
  }

  getSession(channelId: string): BaileysSession | undefined {
    return this.sessions.get(channelId);
  }

  async syncGroups(channelId: string): Promise<void> {
    await syncChannelGroups(this, channelId);
  }

  /**
   * Desligamento do processo: fecha os sockets SEM mudar o status e solta
   * as travas, para o worker novo reabrir as mesmas sessões na hora.
   */
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    for (const t of this.lockWaitTimers.values()) clearTimeout(t);
    this.lockWaitTimers.clear();
    for (const [id, session] of this.sessions) {
      log.info({ channelId: id }, "[baileys-manager] Encerrando sessão (status mantido)");
      await session.stop().catch(() => {});
      await this.lock?.release(id).catch(() => {});
    }
    this.sessions.clear();
  }
}
