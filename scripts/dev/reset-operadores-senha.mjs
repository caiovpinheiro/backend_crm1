/**
 * Redefine a senha de TODOS os operadores (users HUMAN, nao-erased) de uma org.
 * Senha gerada = aleatoria forte por usuario (crypto.randomBytes), mostrada
 * uma unica vez no terminal com --apply. Nenhum arquivo e gravado.
 * Hash: bcrypt cost 10 (mesmo do login em src/lib/auth.ts).
 *
 * Uso:
 *   node reset-operadores-senha.mjs <orgId>            # DRY-RUN (lista quem seria resetado)
 *   node reset-operadores-senha.mjs <orgId> --apply    # aplica no banco
 *
 * Requer .env.local com DATABASE_URL (mesmo padrao dos outros scripts).
 */
import { randomBytes } from "crypto";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega .env.local manualmente
try {
  const envFile = readFileSync(resolve(__dirname, ".env.local"), "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  console.warn("Aviso: .env.local nao encontrado, usando env existente");
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient();

const orgId = process.argv[2];
const APPLY = process.argv.includes("--apply");

if (!orgId) {
  console.error("Uso: node reset-operadores-senha.mjs <orgId> [--apply]");
  process.exit(1);
}

// Senha aleatoria forte (crypto): 18 bytes -> 24 caracteres base64url.
// Nada derivado do nome do usuario.
function genPassword() {
  return randomBytes(18).toString("base64url");
}

async function main() {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true },
  });
  if (!org) {
    console.error(`Org '${orgId}' nao encontrada.`);
    process.exit(1);
  }
  console.log(`Org: ${org.name} (slug=${org.slug}, id=${org.id})`);
  console.log(APPLY ? "MODO: APLICAR\n" : "MODO: DRY-RUN (nada sera gravado)\n");

  const operadores = await prisma.user.findMany({
    where: {
      organizationId: org.id,
      type: "HUMAN",
      isErased: false,
    },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });

  if (!operadores.length) {
    console.log("Nenhum operador (HUMAN) encontrado nessa org.");
    return;
  }

  if (!APPLY) {
    // DRY-RUN nao gera senha: so lista quem seria resetado.
    console.log("Operadores que teriam a senha redefinida:\n");
    console.table(operadores.map((u) => ({ Nome: u.name, Email: u.email, Role: u.role })));
    console.log("\n>> DRY-RUN: rode novamente com --apply para gravar no banco.");
    return;
  }

  const results = [];
  for (const u of operadores) {
    const senha = genPassword();
    const hashedPassword = await bcrypt.hash(senha, 10);
    await prisma.user.update({
      where: { id: u.id },
      data: { hashedPassword },
    });
    results.push({ nome: u.name, email: u.email, role: u.role, senha });
  }

  // Exibidas UMA vez, so no terminal (nenhum arquivo e gravado). Entregue
  // cada senha por canal privado e peca a troca no primeiro acesso.
  console.log("Lista de operadores e novas senhas (exibidas so agora):\n");
  console.table(results.map((r) => ({ Nome: r.nome, Email: r.email, Role: r.role, Senha: r.senha })));
  console.log(`\n✅ ${results.length} senha(s) atualizada(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
