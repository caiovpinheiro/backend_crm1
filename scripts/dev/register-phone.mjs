import pkg from '@next/env';
pkg.loadEnvConfig(process.cwd());
import { createDecipheriv } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const PREFIX = 'enc:v1:';

function decrypt(v) {
  if (!v) return null;
  if (!v.startsWith(PREFIX)) return v;
  const key = Buffer.from(process.env.KEYRING_SECRET.trim(), 'base64');
  const buf = Buffer.from(v.slice(PREFIX.length), 'base64url');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// PIN da verificação em duas etapas do número: obrigatório, vem do ambiente
// e nunca é impresso.
const PIN = (process.env.WHATSAPP_REGISTER_PIN ?? "").trim();
if (!/^\d{6}$/.test(PIN)) {
  console.error("Defina WHATSAPP_REGISTER_PIN com o PIN de 6 dígitos da verificação em duas etapas.");
  process.exit(1);
}

const [ch] = await db.channel.findMany({
  where: { provider: 'META_CLOUD_API' },
  select: { config: true }
});

const token = decrypt(String(ch.config.accessToken));
const phoneNumberId = ch.config.phoneNumberId ?? '1078521802020361';

console.log('Registrando número', phoneNumberId, 'no WhatsApp Cloud API...');
console.log('(Isso vai mudar o status de PENDING → CONNECTED)\n');

const res = await fetch(
  `https://graph.facebook.com/v20.0/${phoneNumberId}/register`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      pin: PIN,
    }),
  }
);

const data = await res.json();
console.log('HTTP Status:', res.status);
console.log('Resposta:', JSON.stringify(data, null, 2));

if (data.success) {
  console.log('\n✅ Número registrado com sucesso!');
  console.log("PIN de duas etapas definido (valor de WHATSAPP_REGISTER_PIN, não exibido).");

  // Verificar novo status
  await new Promise(r => setTimeout(r, 2000));
  const r2 = await fetch(
    `https://graph.facebook.com/v20.0/${phoneNumberId}?fields=id,status,platform_type,throughput`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const status = await r2.json();
  console.log('\nNovo status:', JSON.stringify(status, null, 2));
} else {
  console.log('\n❌ Falha no registro:', JSON.stringify(data));
}

await db.$disconnect();
