/**
 * Varredura local (dev). Em produção use:
 *   curl -fsS "http://127.0.0.1:3000/api/cron/sweep-finished-ai?secret=$CRON_SECRET&hours=72"
 *   curl -fsS -X POST "http://127.0.0.1:3000/api/cron/sweep-finished-ai?secret=$CRON_SECRET&hours=72&apply=1"
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
  const { sweepFinishedAiConversations } = await import(
    "@/services/ai/sweep-finished-ai-conversations"
  );
  const { prismaBase } = await import("@/lib/prisma-base");
  const result = await sweepFinishedAiConversations({
    apply: process.argv.includes("--apply"),
    hours: Number.parseInt(argValue("--hours", "72"), 10) || 72,
    limit: Number.parseInt(argValue("--limit", "200"), 10) || 200,
    quietMinutes: Number.parseInt(argValue("--quietMinutes", "10"), 10) || 10,
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
