import type { SecretsProvider } from "./types";
import { runtimeEnv } from "@/lib/runtime-env";

/**
 * Provider que le secrets diretamente de `process.env`.
 *
 * Default em todos os deploys hoje (PR 3.3). Zero overhead, zero I/O,
 * zero rede. Compatibilidade total com .env / EasyPanel / Docker
 * Swarm secrets injetados como env vars.
 *
 * Usa `runtimeEnv` (não `process.env.KEY` estático) pra o Next não
 * congelar `undefined` no bundle quando a chave só existe no EasyPanel.
 */
export function createEnvProvider(): SecretsProvider {
  return {
    name: "env",

    get(key) {
      return runtimeEnv(key);
    },

    async prefetch() {
      // No-op: process.env ja esta em memoria.
    },

    async health() {
      return { ok: true, detail: "env-backed (no remote check needed)" };
    },
  };
}
