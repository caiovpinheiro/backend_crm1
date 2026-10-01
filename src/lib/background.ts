import { after } from "next/server";

import { getLogger } from "@/lib/logger";

const log = getLogger("background");

/**
 * Executa `task` DEPOIS da resposta HTTP, sem que o handler espere por ela.
 *
 * Usa `after()` do Next (o servidor mantém o processo vivo até a tarefa
 * terminar). Fora de um escopo de requisição (`after` lança) a tarefa roda
 * solta no event loop. Erros são logados com `label` e nunca propagam — a
 * resposta já foi enviada.
 *
 * Só para trabalho curto e idempotente (um e-mail transacional). Trabalho
 * pesado continua indo para o BullMQ.
 */
export function runInBackground(label: string, task: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await task();
    } catch (err) {
      log.error({ err, label }, "tarefa em segundo plano falhou");
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}
