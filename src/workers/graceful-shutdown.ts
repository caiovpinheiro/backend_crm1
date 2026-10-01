/**
 * Encerramento gracioso dos workers (SIGTERM/SIGINT).
 *
 * No redeploy o orquestrador manda SIGTERM e, depois do stop timeout, SIGKILL.
 * Sem handler o Node morre na hora: job BullMQ ativo vira "stalled" e é
 * reprocessado por outro worker (envio duplicado na Meta), contadores em
 * buffer se perdem e o pool do Postgres fica com conexões penduradas.
 *
 * Fluxo: roda os `steps` em ordem (cada um isolado — falha de um não impede
 * os seguintes), faz flush do logger e sai com 0. Uma segunda chamada (o
 * sinal costuma chegar duas vezes: SIGTERM do Docker + SIGINT do terminal,
 * ou dois SIGTERM) não repete nada. Se os passos travarem, o timer de
 * segurança sai com 1 antes do SIGKILL do orquestrador.
 */
import { getRootLogger, type Logger } from "@/lib/logger";

export type ShutdownStep = {
  name: string;
  run: () => unknown;
};

export type GracefulShutdownOptions = {
  /** Nome do processo nos logs (ex.: "worker-whatsapp"). */
  name: string;
  log: Logger;
  steps: ShutdownStep[];
  /** Teto total antes de forçar a saída. Default 25 s (EasyPanel/Docker: 30 s). */
  timeoutMs?: number;
  /** Injetáveis para teste. */
  exit?: (code: number) => void;
  flushLogger?: () => Promise<void>;
};

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Flush do pino (stdout). Nunca rejeita e não segura o exit por mais de 1 s. */
export function flushRootLogger(): Promise<void> {
  return new Promise<void>((resolve) => {
    const guard = setTimeout(resolve, 1_000);
    guard.unref?.();
    try {
      getRootLogger().flush(() => {
        clearTimeout(guard);
        resolve();
      });
    } catch {
      clearTimeout(guard);
      resolve();
    }
  });
}

/**
 * Monta a função de shutdown. Não registra sinais — use
 * `installGracefulShutdown` no entrypoint.
 */
export function createGracefulShutdown(
  opts: GracefulShutdownOptions,
): (signal: string) => Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const flushLogger = opts.flushLogger ?? flushRootLogger;
  let running: Promise<void> | null = null;

  return (signal: string) => {
    if (running) {
      opts.log.info({ signal }, `[${opts.name}] shutdown já em andamento — ignorando sinal`);
      return running;
    }
    running = (async () => {
      opts.log.info({ signal, timeoutMs }, `[${opts.name}] sinal recebido — encerrando`);
      let exited = false;
      const safety = setTimeout(() => {
        if (exited) return;
        exited = true;
        opts.log.error(
          { timeoutMs },
          `[${opts.name}] shutdown passou do limite — saindo à força`,
        );
        void flushLogger().finally(() => exit(1));
      }, timeoutMs);
      // Não segura o event loop: se tudo fechar antes, o processo sai sozinho.
      safety.unref?.();

      for (const step of opts.steps) {
        if (exited) return;
        try {
          await step.run();
        } catch (err) {
          opts.log.warn(
            { step: step.name, err: errMessage(err) },
            `[${opts.name}] passo de shutdown falhou`,
          );
        }
      }
      if (exited) return;
      exited = true;
      clearTimeout(safety);
      opts.log.info(`[${opts.name}] encerrado`);
      await flushLogger().catch(() => {});
      exit(0);
    })();
    return running;
  };
}

/** Registra SIGTERM/SIGINT no processo. Retorna a função (útil em teste). */
export function installGracefulShutdown(
  opts: GracefulShutdownOptions,
  proc: Pick<NodeJS.Process, "on"> = process,
): (signal: string) => Promise<void> {
  const shutdown = createGracefulShutdown(opts);
  proc.on("SIGTERM", () => void shutdown("SIGTERM"));
  proc.on("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}
