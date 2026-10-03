/**
 * Hook de arranque do servidor Node.
 *
 * NOTE: Heavy server-only modules (pg, ioredis, prisma) CANNOT be imported here
 * — even via dynamic import() — because Next.js bundles instrumentation.ts for
 * both Node.js and Edge runtimes, and webpack traces the dependency graph.
 *
 * The timeout sweeper is started lazily from src/lib/sse-bus.ts instead,
 * which is only loaded by server-side API routes.
 *
 * Exception: o SDK do OpenTelemetry (PR 2.2) pode ser inicializado aqui
 * via dynamic import condicional. Ele só roda quando:
 *   - NEXT_RUNTIME === "nodejs"
 *   - OTEL_EXPORTER_OTLP_ENDPOINT está setado
 *
 * Pacotes OTel já estão em `serverExternalPackages` no next.config.ts pra
 * não serem bundleados pelo webpack/turbopack.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Parada graciosa (B6): SIGTERM → health 503, SSE fechado com retry e
  // jitter, requisições em curso terminam (teto 25 s), depois sai. Só no
  // servidor de produção da API; `next dev` mantém o Ctrl+C do Next.
  // O entrypoint exporta NEXT_MANUAL_SIG_HANDLE=true (o Next não registra o
  // handler dele, que esperava os streams SSE até o SIGKILL).
  // API_GRACEFUL_SHUTDOWN=0 desliga. Módulo sem pg/ioredis/prisma/logger.
  const appMode = (process.env.APP_MODE ?? "api").trim().toLowerCase() || "api";
  if (
    process.env.NODE_ENV === "production" &&
    (appMode === "api" || appMode === "api-public") &&
    process.env.API_GRACEFUL_SHUTDOWN !== "0"
  ) {
    try {
      const { installApiGracefulShutdown, apiShutdownTimingsFromEnv } = await import(
        "@/lib/api-shutdown"
      );
      const timings = apiShutdownTimingsFromEnv();
      const emit = (level: string, msg: string, extra?: Record<string, unknown>) => {
        // eslint-disable-next-line no-console -- instrumentation também é empacotado para o runtime Edge; o logger (pino + AsyncLocalStorage) não pode entrar aqui
        console.log(JSON.stringify({ level, time: Date.now(), appMode, msg, ...extra }));
      };
      installApiGracefulShutdown({
        ...timings,
        log: {
          info: (msg, extra) => emit("info", msg, extra),
          warn: (msg, extra) => emit("warn", msg, extra),
          error: (msg, extra) => emit("error", msg, extra),
        },
      });
      emit("info", "[api-shutdown] handler de SIGTERM instalado", {
        ...timings,
        nextManualSigHandle: Boolean(process.env.NEXT_MANUAL_SIG_HANDLE),
        keepAliveTimeoutMs: Number(process.env.KEEP_ALIVE_TIMEOUT) || null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console -- instrumentation também é empacotado para o runtime Edge; o logger (pino + AsyncLocalStorage) não pode entrar aqui
      console.warn("[instrumentation] parada graciosa não instalada:", err);
    }
  }

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      const { startOtel } = await import("@/lib/otel-sdk");
      await startOtel();
    } catch (err) {
      // eslint-disable-next-line no-console -- instrumentation também é empacotado para o runtime Edge; o logger (pino + AsyncLocalStorage) não pode entrar aqui
      console.warn("[instrumentation] OTel SDK falhou ao iniciar:", err);
    }
  }

  // PR 3.3: Pre-warm secrets provider. Pra `env` provider e no-op.
  // Pra Infisical/Doppler, baixa todos os secrets uma vez e cacheia.
  // Falha aqui NAO derruba o boot — providers tem fallback pra
  // process.env.
  try {
    const { secrets } = await import("@/lib/secrets");
    await secrets.prefetch();
  } catch (err) {
    // eslint-disable-next-line no-console -- instrumentation também é empacotado para o runtime Edge; o logger (pino + AsyncLocalStorage) não pode entrar aqui
    console.warn("[instrumentation] secrets.prefetch falhou:", err);
  }

  // VPC hygiene: avisa hostname público DigitalOcean (sem private-).
  // Módulo só parseia URL + console.warn — sem pg/ioredis/prisma.
  // Idempotente com o hook em prisma-base.ts (workers).
  try {
    const { warnPublicDoManagedHosts } = await import(
      "@/lib/warn-public-do-managed-hosts"
    );
    warnPublicDoManagedHosts();
  } catch (err) {
    // eslint-disable-next-line no-console -- instrumentation também é empacotado para o runtime Edge; o logger (pino + AsyncLocalStorage) não pode entrar aqui
    console.warn("[instrumentation] warn-public-do-managed-hosts falhou:", err);
  }
}
