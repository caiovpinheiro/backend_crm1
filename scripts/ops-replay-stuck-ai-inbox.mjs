/**
 * Wrapper p/ o container de prod (não tem src/ nem tsx).
 * Chama a API da própria instância.
 *
 *   node scripts/ops-replay-stuck-ai-inbox.mjs
 *   node scripts/ops-replay-stuck-ai-inbox.mjs --apply
 *   node scripts/ops-replay-stuck-ai-inbox.mjs --apply --hours=24
 */

const apply = process.argv.includes("--apply");
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const hours = hoursArg ? hoursArg.slice("--hours=".length) : "24";
const numbersArg = process.argv.find((a) => a.startsWith("--numbers="));
const secret = (process.env.CRON_SECRET ?? "").trim();
const port = process.env.PORT || "3000";

if (!secret) {
  console.error("CRON_SECRET ausente no ambiente do container.");
  process.exit(1);
}

const qs = new URLSearchParams({
  secret,
  hours: String(hours),
});
if (apply) qs.set("apply", "1");
if (numbersArg) qs.set("numbers", numbersArg.slice("--numbers=".length));

const url = `http://127.0.0.1:${port}/api/cron/replay-stuck-ai?${qs}`;
const res = await fetch(url, { method: apply ? "POST" : "GET" });
const body = await res.text();
console.log(body);
if (!res.ok) process.exit(1);
