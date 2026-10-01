/**
 * Wrapper p/ o container de prod (não tem src/ nem tsx).
 *
 *   node scripts/ops-halt-inbound-burst.mjs
 *   node scripts/ops-halt-inbound-burst.mjs --apply
 *   node scripts/ops-halt-inbound-burst.mjs --apply --hours=6
 *   node scripts/ops-halt-inbound-burst.mjs --apply --all-open
 */

const apply = process.argv.includes("--apply");
const allOpen = process.argv.includes("--all-open");
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const hours = hoursArg ? hoursArg.slice("--hours=".length) : "6";
const phoneArg = process.argv.find((a) => a.startsWith("--phone="));
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
if (allOpen) qs.set("allOpen", "1");
if (phoneArg) qs.set("phoneNumberId", phoneArg.slice("--phone=".length));

const url = `http://127.0.0.1:${port}/api/cron/halt-inbound-burst?${qs}`;
const res = await fetch(url, { method: apply ? "POST" : "GET" });
const body = await res.text();
console.log(res.status, body);
if (!res.ok) process.exit(1);
