import { NextResponse } from "next/server";

import {
  canSeeHealthDetail,
  getHealthSnapshot,
  healthUptimeSec,
  type HealthCheckResult,
} from "@/lib/health-check";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Página `/health` entregue como HTML puro via Route Handler.
 *
 * Por que não uma `page.tsx`?
 *  - No dev server, o RootLayout carrega Providers (Auth, SSE, WebSocket,
 *    query client) que mantêm requests abertas e fazem o spinner do browser
 *    girar por segundos/minutos na primeira carga. Para um status page que
 *    precisa ser *instantâneo* e *resiliente*, isso é inaceitável.
 *  - Route Handler retornando `text/html` bypassa totalmente o runtime React:
 *    zero chunks, zero providers, zero hidratação. Carrega em qualquer
 *    browser, funciona offline com auto-refresh nativo via meta tag.
 *
 * Mantemos `/api/health` separado para monitores externos (JSON).
 *
 * Pública só com o estado agregado ("Operacional"/"Degradado"). Os cartões
 * de Postgres/Redis, latências e uptime aparecem apenas com `HEALTH_TOKEN`
 * ou sessão de super-admin — mesma regra do `/api/health`
 * (`@/lib/health-check`).
 */

type CheckResult = HealthCheckResult;

function formatUptime(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function latencyTone(ms: number): string {
  if (ms < 50) return "#047857"; // emerald-700
  if (ms < 200) return "#b45309"; // amber-700
  return "#be123c"; // rose-700
}

function renderCheck(label: string, iconSvg: string, c: CheckResult): string {
  const isOk = c.ok;
  const pillBg = isOk ? "#ecfdf5" : "#fff1f2";
  const pillFg = isOk ? "#047857" : "#be123c";
  const dot = isOk ? "#10b981" : "#f43f5e";
  const body = isOk
    ? `<div style="margin-top:12px;display:flex;align-items:baseline;gap:4px">
         <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:24px;font-weight:900;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;color:${latencyTone(c.latencyMs)}">${c.latencyMs}</span>
         <span style="font-size:12px;font-weight:600;color:#94a3b8">ms</span>
       </div>`
    : `<p style="margin:12px 0 0;font-size:12px;font-weight:500;color:#be123c;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${escapeHtml(c.error)}</p>`;
  return `
    <div style="border-radius:16px;border:1px solid rgba(0,0,0,0.06);background:#fff;padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.025em;color:#94a3b8">
          <span style="color:${isOk ? "#475569" : "#be123c"};display:inline-flex">${iconSvg}</span>${label}
        </div>
        <span style="display:inline-flex;align-items:center;gap:4px;border-radius:9999px;background:${pillBg};color:${pillFg};padding:2px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.025em">
          <span style="width:6px;height:6px;border-radius:9999px;background:${dot}"></span>${isOk ? "OK" : "Falha"}
        </span>
      </div>
      ${body}
    </div>`;
}

const ICON_DB = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>`;
const ICON_ZAP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
const ICON_ACTIVITY = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;
const ICON_SHIELD_OK = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`;
const ICON_SHIELD_ALERT = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;
const ICON_SERVER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>`;

export async function GET(request: Request) {
  const [snapshot, detail] = await Promise.all([
    getHealthSnapshot(),
    canSeeHealthDetail(request),
  ]);
  const { db, redis, ok } = snapshot;
  const uptimeSec = healthUptimeSec();
  const timestamp = new Date().toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const overallBorder = ok ? "#a7f3d0" : "#fde68a";
  const overallBg = ok ? "#ecfdf5" : "#fffbeb";
  const overallIconBg = ok ? "#059669" : "#d97706";
  const overallTitle = ok ? "#064e3b" : "#78350f";
  const overallBody = ok ? "#047857" : "#b45309";
  const overallDot = ok ? "#10b981" : "#f59e0b";
  const overallLabel = ok ? "Operacional" : "Degradado";
  const overallMessage = ok
    ? "Todos os serviços estão respondendo normalmente"
    : "Uma ou mais dependências estão com problemas";

  const detailHtml = detail
    ? `<div style="margin-top:16px;display:grid;gap:12px;grid-template-columns:1fr 1fr">
      ${renderCheck("Postgres", ICON_DB, db)}
      ${renderCheck("Redis", ICON_ZAP, redis)}
    </div>

    <div style="margin-top:16px;border-radius:16px;border:1px solid rgba(0,0,0,0.06);background:#fff;padding:16px">
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.025em;color:#94a3b8">${ICON_SERVER}Runtime</div>
      <dl style="margin:12px 0 0;display:grid;grid-template-columns:1fr 1fr;row-gap:12px;font-size:13px">
        <dt style="color:#64748b">Uptime</dt>
        <dd style="margin:0;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;font-variant-numeric:tabular-nums;color:#0f172a">${formatUptime(uptimeSec)}</dd>
        <dt style="color:#64748b">HTTP</dt>
        <dd style="margin:0;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;font-variant-numeric:tabular-nums;color:#0f172a">${ok ? 200 : 503}</dd>
        <dt style="color:#64748b">Timestamp</dt>
        <dd style="margin:0;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#334155">${escapeHtml(timestamp)}</dd>
      </dl>
    </div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <title>System Health</title>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f8fafc;color:#0f172a;min-height:100dvh;padding:40px 16px}
    @media (min-width:640px){body{padding:64px 24px}}
    .shell{max-width:640px;margin:0 auto}
    @keyframes ping{75%,100%{transform:scale(2);opacity:0}}
    .pulse{position:absolute;inset:0;border-radius:9999px;animation:ping 2s cubic-bezier(0,0,0.2,1) infinite;opacity:0.6}
  </style>
</head>
<body>
  <div class="shell">
    <header style="margin-bottom:24px;display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:40px;height:40px;border-radius:16px;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center">${ICON_ACTIVITY}</div>
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:900;letter-spacing:-0.02em;color:#0f172a">System Health</h1>
          <p style="margin:0;font-size:12px;font-weight:500;color:#64748b">Status em tempo real</p>
        </div>
      </div>
      <a href="/health" style="display:inline-flex;align-items:center;gap:8px;border-radius:12px;border:1px solid rgba(0,0,0,0.06);background:#fff;padding:6px 12px;font-size:12px;font-weight:600;color:#334155;text-decoration:none">Atualizar</a>
    </header>

    <div style="border-radius:16px;border:1px solid ${overallBorder};background:${overallBg};padding:20px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:40px;height:40px;border-radius:12px;background:${overallIconBg};color:#fff;display:flex;align-items:center;justify-content:center">${ok ? ICON_SHIELD_OK : ICON_SHIELD_ALERT}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px">
            <p style="margin:0;font-size:16px;font-weight:900;letter-spacing:-0.02em;color:${overallTitle}">${overallLabel}</p>
            <span style="position:relative;display:inline-flex;width:8px;height:8px">
              <span class="pulse" style="background:${overallDot}"></span>
              <span style="position:relative;width:8px;height:8px;border-radius:9999px;background:${overallDot}"></span>
            </span>
          </div>
          <p style="margin:2px 0 0;font-size:12px;font-weight:500;color:${overallBody}">${overallMessage}</p>
        </div>
      </div>
    </div>

    ${detailHtml}

    <footer style="margin-top:24px;display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:500;color:#94a3b8">
      <span>Atualiza automaticamente a cada 10s</span>
      <a href="/api/health" target="_blank" rel="noreferrer" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#94a3b8;text-decoration:none">/api/health</a>
    </footer>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: ok ? 200 : 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
