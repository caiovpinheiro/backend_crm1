/**
 * Replay local (dev). Em produção use:
 *   node scripts/ops-replay-stuck-ai-inbox.mjs --apply
 *   curl -X POST "http://127.0.0.1:3000/api/cron/replay-stuck-ai?secret=$CRON_SECRET&hours=24&apply=1"
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

async function main() {
  const { replayStuckAiInbox } = await import("@/services/ai/replay-stuck-inbox");
  const { prismaBase } = await import("@/lib/prisma-base");
  const result = await replayStuckAiInbox({
    apply: process.argv.includes("--apply"),
    hours: Number.parseInt(argValue("--hours", "24"), 10) || 24,
    limit: Number.parseInt(argValue("--limit", "80"), 10) || 80,
    organizationId: argValue("--org", "").trim() || null,
    numbers: argValue("--numbers", "")
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0),
  });
  console.log(JSON.stringify(result, null, 2));
  await prismaBase.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
