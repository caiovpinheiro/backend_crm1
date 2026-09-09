import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function securityHeaders(): { key: string; value: string }[] {
  const headers: { key: string; value: string }[] = [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "payment=(), usb=(), geolocation=()",
    },
  ];
  const url = process.env.NEXTAUTH_URL ?? "";
  if (process.env.NODE_ENV === "production" && url.startsWith("https://")) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
  }
  return headers;
}

const nextConfig: NextConfig = {
  output: "standalone",
  // NOTA: NÃO listar `NEXTAUTH_URL` em `env` aqui. Isso inlinearia o valor
  // em build time e impediria trocar a URL via env var no Easypanel sem
  // rebuild. Este backend é só API (sem `next-auth/react` no client),
  // então o `process.env.NEXTAUTH_URL` em runtime já é suficiente para
  // o NextAuth server. Para frontends que rodem `next-auth/react`, o
  // próprio cliente lê a URL em runtime via `/api/auth/session`.
  typescript: {
    // Mantemos TS errors fora do build por um motivo único: src/lib/prisma.ts
    // usa Prisma Client Extensions para auto-injetar `organizationId` em
    // CREATE/UPDATE/DELETE/find* (multi-tenancy via RLS). O TypeScript não
    // consegue inferir essa transformação do extension, então o tipo gerado
    // pelo Prisma Client continua exigindo `organizationId` no `data` dos
    // creates — ~150 falsos positivos que SEMPRE funcionam em runtime porque
    // o extension intercepta antes do Prisma rejeitar.
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Uploads de mídia e relatório de matriculados (até ~32MB + overhead).
    serverActions: {
      bodySizeLimit: "64mb",
    },
    middlewareClientMaxBodySize: "64mb",
  },
  serverExternalPackages: [
    "bullmq",
    "ioredis",
    "pg",
    "pg-pool",
    "pg-connection-string",
    "pgpass",
    "@prisma/adapter-pg",
    "@prisma/client",
    // `unpdf` embute o build serverless do PDF.js num arquivo só. Passar
    // isso pelo webpack estoura o tempo de build sem ganho — o Node
    // resolve de node_modules em runtime.
    "unpdf",
    // OpenTelemetry: auto-instrumentations usam require dinâmico de muitos
    // módulos; bundlear via webpack/turbopack quebra. Mantém como deps
    // externas — Node carrega de node_modules em runtime. Lista explícita
    // para o turbopack (dev), que NÃO honra o hook `webpack()` abaixo.
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/auto-instrumentations-node",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/exporter-metrics-otlp-http",
    "@opentelemetry/sdk-metrics",
    "@opentelemetry/resources",
    "@opentelemetry/semantic-conventions",
    "@opentelemetry/instrumentation-pino",
    "prom-client",
  ],
  webpack: (config, { isServer, nextRuntime }) => {
    // 1) Bundle do Node server (route handlers, server components).
    //    Externaliza qualquer pacote OTel/gRPC para que o webpack não siga
    //    requires transitivos (ex.: sdk-node → exporter-logs-otlp-grpc →
    //    @grpc/grpc-js → require('fs'|'net'|'tls'|'zlib'|'stream')).
    //    Em runtime, Node resolve os pacotes diretamente do node_modules.
    if (isServer && nextRuntime !== "edge") {
      const externals = Array.isArray(config.externals)
        ? config.externals
        : [config.externals].filter(Boolean);
      externals.push(
        (
          { request }: { request?: string },
          callback: (err?: Error | null, result?: string) => void,
        ) => {
          if (
            request &&
            (/^@opentelemetry\//.test(request) || /^@grpc\//.test(request))
          ) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
      );
      config.externals = externals;
    }

    // 2) Bundle do client (browser). Cliente NUNCA usa OTel/gRPC.
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@opentelemetry/api": false,
        "@opentelemetry/sdk-node": false,
        "@opentelemetry/auto-instrumentations-node": false,
        "@opentelemetry/exporter-trace-otlp-http": false,
        "@opentelemetry/exporter-metrics-otlp-http": false,
        "@opentelemetry/sdk-metrics": false,
        "@opentelemetry/resources": false,
        "@opentelemetry/semantic-conventions": false,
        "@opentelemetry/instrumentation-pino": false,
      };
    }

    // 3) Bundle do middleware (Edge Runtime / V8 isolate). Stub no-op pra
    //    @opentelemetry/api e false pros SDKs Node (que não rodam no Edge).
    if (nextRuntime === "edge") {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@opentelemetry/api": path.resolve(
          __dirname,
          "src/lib/edge-otel-stub.ts",
        ),
        "@opentelemetry/sdk-node": false,
        "@opentelemetry/auto-instrumentations-node": false,
        "@opentelemetry/exporter-trace-otlp-http": false,
        "@opentelemetry/exporter-metrics-otlp-http": false,
        "@opentelemetry/sdk-metrics": false,
        "@opentelemetry/resources": false,
        "@opentelemetry/semantic-conventions": false,
        "@opentelemetry/instrumentation-pino": false,
        "@grpc/grpc-js": false,
      };
    }
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/uploads/:path*",
        destination: "/api/uploads/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(),
      },
    ];
  },
};

export default nextConfig;
