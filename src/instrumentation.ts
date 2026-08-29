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

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      const { startOtel } = await import("@/lib/otel-sdk");
      await startOtel();
    } catch (err) {
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
    console.warn("[instrumentation] warn-public-do-managed-hosts falhou:", err);
  }
}
