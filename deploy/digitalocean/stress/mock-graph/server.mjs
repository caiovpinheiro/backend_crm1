/**
 * Mock da Meta Graph API para stress test em staging.
 *
 * O código de produção tem a URL https://graph.facebook.com/v21.0 hardcoded
 * (src/lib/meta-whatsapp/client.ts L255-257) e não expõe env de override.
 * Em vez de alterar o caminho crítico só para testar, este servidor se passa
 * pela Graph: o compose aponta graph.facebook.com para cá via extra_hosts e
 * a CA local entra no bundle que os containers já montam em /app/certs.
 * Resultado: o staging exercita o código de produção sem modificação, e
 * nenhuma chamada consegue sair do droplet.
 *
 * Os códigos de erro emitidos são os que o sistema de fato distingue:
 *   - 429 + code 130429 -> META_RATE_LIMIT_RETRY_CODES, reenfileira a campanha
 *     (src/services/campaign-builder/meta-compliance.ts L7)
 *   - 503 + code 2      -> META_TRANSIENT_SERVICE_CODES, retry interno do
 *     graphFetch antes de propagar (src/lib/meta-whatsapp/client.ts L284-288)
 *
 * Perfis via env MOCK_PROFILE: realista (default) | limpo | lento
 */
import https from "node:https";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

const PORT = Number(process.env.MOCK_PORT || 443);
const PROFILE = process.env.MOCK_PROFILE || "realista";
const BASE_LATENCY_MS = Number(process.env.MOCK_LATENCY_MS || 90);
const JITTER_MS = Number(process.env.MOCK_JITTER_MS || 40);
const RATE_LIMIT_PCT = PROFILE === "limpo" ? 0 : Number(process.env.MOCK_429_PCT || 5);
const SERVER_ERR_PCT = PROFILE === "limpo" ? 0 : Number(process.env.MOCK_503_PCT || 1);

const startedAt = Date.now();

const stats = {
  total: 0,
  byStatus: new Map(),
  byPath: new Map(),
  latencies: [],
  firstAt: null,
  lastAt: null,
};

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/** Normaliza /v21.0/1234/messages -> /messages para não explodir a cardinalidade. */
function templatize(path) {
  return path
    .replace(/^\/v\d+\.\d+/, "")
    .replace(/\/\d{6,}/g, "/{id}")
    .split("?")[0];
}

/** Perfil "lento": latência sobe para 1-3s depois de 60s de teste. */
function latencyFor() {
  if (PROFILE === "lento" && Date.now() - startedAt > 60_000) {
    return 1000 + Math.random() * 2000;
  }
  return BASE_LATENCY_MS + Math.random() * JITTER_MS;
}

function pickFailure() {
  const roll = Math.random() * 100;
  if (roll < RATE_LIMIT_PCT) {
    return {
      status: 429,
      body: {
        error: {
          message: "(#130429) Rate limit hit",
          type: "OAuthException",
          code: 130429,
          error_subcode: 2494055,
          fbtrace_id: `MOCK${Math.random().toString(36).slice(2, 12)}`,
        },
      },
    };
  }
  if (roll < RATE_LIMIT_PCT + SERVER_ERR_PCT) {
    return {
      status: 503,
      body: {
        error: {
          message: "(#2) Service temporarily unavailable",
          type: "OAuthException",
          code: 2,
          fbtrace_id: `MOCK${Math.random().toString(36).slice(2, 12)}`,
        },
      },
    };
  }
  return null;
}

let wamidSeq = 0;
function wamid() {
  wamidSeq += 1;
  return `wamid.MOCK${Date.now().toString(36)}${wamidSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function respondFor(path, body) {
  const t = templatize(path);

  if (t.endsWith("/messages")) {
    const to = body?.to || body?.recipient || "5511900000000";
    return {
      messaging_product: "whatsapp",
      contacts: [{ input: String(to), wa_id: String(to).replace(/\D/g, "") }],
      messages: [{ id: wamid(), message_status: "accepted" }],
    };
  }
  if (t.endsWith("/whatsapp_business_profile")) {
    return { data: [{ messaging_product: "whatsapp", about: "Mock", vertical: "OTHER" }] };
  }
  if (t.endsWith("/message_templates")) {
    return {
      data: [
        {
          id: "1000000000000001",
          name: "stress_template",
          language: "pt_BR",
          status: "APPROVED",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Olá {{1}}, teste de carga." }],
        },
      ],
      paging: {},
    };
  }
  if (t.endsWith("/media") || t.startsWith("/{id}")) {
    return { id: `mock-media-${Date.now()}`, url: "https://graph.facebook.com/v21.0/mock-media", mime_type: "image/jpeg" };
  }
  return { success: true, mock: true, path: t };
}

const server = https.createServer(
  {
    key: fs.readFileSync(process.env.MOCK_KEY || "/certs/mock.key"),
    cert: fs.readFileSync(process.env.MOCK_CERT || "/certs/mock.crt"),
  },
  (req, res) => {
    const t0 = performance.now();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let parsed = null;
      if (chunks.length) {
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* form-data etc. */ }
      }

      // Endpoint próprio do mock, fora do namespace da Graph.
      if (req.url === "/__stats") {
        const lat = [...stats.latencies].sort((a, b) => a - b);
        const p = (q) => (lat.length ? +lat[Math.min(lat.length - 1, Math.floor((q / 100) * lat.length))].toFixed(1) : null);
        const durSec = stats.firstAt ? (stats.lastAt - stats.firstAt) / 1000 : 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          perfil: PROFILE,
          total: stats.total,
          porStatus: Object.fromEntries(stats.byStatus),
          porRota: Object.fromEntries(stats.byPath),
          duracaoSeg: +durSec.toFixed(1),
          reqPorSeg: durSec > 0 ? +(stats.total / durSec).toFixed(1) : null,
          latenciaMs: { p50: p(50), p95: p(95), p99: p(99) },
        }, null, 2));
        return;
      }
      if (req.url === "/__reset") {
        stats.total = 0; stats.byStatus.clear(); stats.byPath.clear();
        stats.latencies.length = 0; stats.firstAt = null; stats.lastAt = null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }

      const failure = pickFailure();
      const status = failure ? failure.status : 200;
      const payload = failure ? failure.body : respondFor(req.url, parsed);

      setTimeout(() => {
        stats.total += 1;
        stats.firstAt ??= Date.now();
        stats.lastAt = Date.now();
        bump(stats.byStatus, String(status));
        bump(stats.byPath, `${req.method} ${templatize(req.url)}`);
        stats.latencies.push(performance.now() - t0);
        if (stats.latencies.length > 200_000) stats.latencies.splice(0, 100_000);

        const json = JSON.stringify(payload);
        res.writeHead(status, {
          "content-type": "application/json",
          "x-mock-graph": "1",
          "facebook-api-version": "v21.0",
        });
        res.end(json);
      }, latencyFor());
    });
  },
);

// keep-alive longo: o worker de campanha reusa a conexão entre os milhares
// de envios, e reabrir TLS a cada job distorceria a latência medida.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.on("clientError", (err, socket) => {
  if (!socket.destroyed) socket.destroy();
  console.error("[mock-graph] clientError:", err.message);
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[mock-graph] ouvindo em :${PORT} perfil=${PROFILE} latencia=${BASE_LATENCY_MS}ms+${JITTER_MS} 429=${RATE_LIMIT_PCT}% 503=${SERVER_ERR_PCT}%`,
  );
});
