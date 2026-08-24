/**
 * Wrapper p/ o container de prod (não tem src/ nem tsx).
 * Destrava alunos presos na IA sem distribuição. Não manda mensagem.
 *
 *   node scripts/ops-distribute-stuck-inbound.mjs
 *   node scripts/ops-distribute-stuck-inbound.mjs --apply
 *   node scripts/ops-distribute-stuck-inbound.mjs --apply --min=15 --limit=200
 *   node scripts/ops-distribute-stuck-inbound.mjs --since=240
 */

const apply = process.argv.includes("--apply");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const secret = (process.env.CRON_SECRET ?? "").trim();
const port = process.env.PORT || "3000";

if (!secret) {
  console.error("CRON_SECRET ausente no ambiente do container.");
  process.exit(1);
}

const qs = new URLSearchParams({
  secret,
  minMinutes: String(arg("min", "15")),
  sinceMinutes: String(arg("since", "0")),
  limit: String(arg("limit", "200")),
});
if (apply) qs.set("apply", "1");
const org = arg("org", "");
if (org) qs.set("org", org);

const url = `http://127.0.0.1:${port}/api/cron/distribute-stuck-inbound?${qs}`;
const res = await fetch(url, { method: apply ? "POST" : "GET" });
const body = await res.text();
console.log(res.status, body);
if (!res.ok) process.exit(1);
