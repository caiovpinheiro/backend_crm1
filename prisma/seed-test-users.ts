/**
 * Seed de USUÁRIOS DE TESTE + PERMISSÕES (dev local)
 * ──────────────────────────────────────────────────
 * Cria, de forma idempotente, usuários humanos em cada nível de acesso para
 * exercitar o RBAC (presets ADMIN/MANAGER/MEMBER + Grupos com escopo estilo
 * Kommo). Também popula alguns Produtos (o catálogo estava vazio) e redistribui
 * parte do mock de vendas (sh-seed-*) entre os usuários de teste — assim o
 * escopo SELF vs ALL fica observável ao logar com cada perfil.
 *
 * Uso:
 *   npm run db:seed:testusers
 *   # ou: npx tsx prisma/seed-test-users.ts
 *
 * Pré-requisitos: `npm run db:seed` (cria org EduIT + admin + presets).
 *
 * Usuários criados (senha ALEATÓRIA por usuário, gerada a cada execução e
 * impressa uma única vez no fim — não existe senha padrão):
 *   gestor@eduit.com.br     → preset Gestor (MANAGER)
 *   operador@eduit.com.br   → preset Operador (MEMBER)
 *   operador2@eduit.com.br  → preset Operador (MEMBER) + Grupo
 *
 * Só roda fora de produção: recusa NODE_ENV=production e banco cujo host não
 * seja local (localhost / 127.x / ::1). Para um banco de teste remoto,
 * SEED_TEST_USERS_ALLOW_REMOTE_DB=1 libera só a checagem de host.
 *
 * Idempotente: usuários por email (upsert), grupo por nome, produtos por SKU.
 */

import { randomBytes } from "node:crypto";

import { PrismaClient, type UserRole } from "@prisma/client";
import { hash } from "bcryptjs";

/** Host do DATABASE_URL é desta máquina? URL ilegível conta como remoto. */
function isLocalDatabaseHost(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

function assertNonProductionTarget(): void {
  if (process.env.NODE_ENV === "production") {
    console.error("✗ seed-test-users recusado: NODE_ENV=production.");
    process.exit(1);
  }
  if (
    !isLocalDatabaseHost(process.env.DATABASE_URL) &&
    process.env.SEED_TEST_USERS_ALLOW_REMOTE_DB !== "1"
  ) {
    console.error(
      "✗ seed-test-users recusado: o host do DATABASE_URL não é local.\n" +
        "  Para um banco de TESTE remoto, rode com SEED_TEST_USERS_ALLOW_REMOTE_DB=1.",
    );
    process.exit(1);
  }
}

assertNonProductionTarget();

const prisma = new PrismaClient();

const EDUIT_ORG_ID = "org_eduit";
const SEED_PREFIX = "sh-seed-";

type TestUser = {
  email: string;
  name: string;
  role: UserRole;
  phone?: string;
  signature?: string;
};

const TEST_USERS: TestUser[] = [
  {
    email: "gestor@eduit.com.br",
    name: "Gabriel Gestor",
    role: "MANAGER",
    phone: "+5511910000001",
    signature: "Gabriel · Gestão EduIT",
  },
  {
    email: "operador@eduit.com.br",
    name: "Olívia Operadora",
    role: "MEMBER",
    phone: "+5511920000002",
    signature: "Olívia · Atendimento EduIT",
  },
  {
    email: "operador2@eduit.com.br",
    name: "Otávio Operador",
    role: "MEMBER",
    phone: "+5511930000003",
    signature: "Otávio · Atendimento EduIT",
  },
];

type SeedProduct = {
  sku: string;
  name: string;
  price: number;
  description: string;
};

const PRODUCTS: SeedProduct[] = [
  { sku: "CURSO-IA", name: "Curso de IA Aplicada", price: 1490, description: "Curso online de IA aplicada (40h)." },
  { sku: "MENTORIA-VIP", name: "Mentoria VIP 6 meses", price: 3200, description: "Mentoria 1:1 quinzenal por 6 meses." },
  { sku: "PACOTE-PREMIUM", name: "Pacote Premium (Curso + Mentoria)", price: 4690, description: "Curso completo + 6 sessões de mentoria." },
  { sku: "CONSULTORIA-ENT", name: "Consultoria Enterprise 12 meses", price: 18900, description: "Consultoria estratégica anual." },
  { sku: "LICENCA-ENT", name: "Licença Enterprise Anual", price: 45000, description: "Licença corporativa anual da plataforma." },
  { sku: "BOOTCAMP-DS", name: "Bootcamp Data Science 12 semanas", price: 3490, description: "Bootcamp intensivo de Data Science." },
];

async function ensurePresetRole(organizationId: string, preset: UserRole) {
  const role = await prisma.role.findFirst({
    where: { organizationId, systemPreset: preset },
    select: { id: true, name: true },
  });
  if (!role) {
    throw new Error(
      `Preset Role "${preset}" não existe na org. Rode "npm run db:seed" antes.`,
    );
  }
  return role;
}

async function main() {
  console.log("▶ Seed de usuários de teste + permissões…");

  const org = await prisma.organization.findUnique({
    where: { id: EDUIT_ORG_ID },
    select: { id: true },
  });
  if (!org) {
    throw new Error(
      `Org "${EDUIT_ORG_ID}" não encontrada. Rode "npm run db:seed" primeiro.`,
    );
  }

  // ─── 1. Usuários de teste (upsert por email) ────────────────────────────
  // Senha aleatória por usuário a cada execução; impressa só no fim.
  const userIdByEmail = new Map<string, string>();
  const issuedPasswords = new Map<string, string>();
  for (const u of TEST_USERS) {
    const password = randomBytes(18).toString("base64url");
    issuedPasswords.set(u.email, password);
    const hashedPassword = await hash(password, 12);
    const existingUser = await prisma.user.findFirst({
      where: { email: u.email, organizationId: EDUIT_ORG_ID },
      select: { id: true },
    });
    const user = existingUser
      ? await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            name: u.name,
            role: u.role,
            organizationId: EDUIT_ORG_ID,
            type: "HUMAN",
            isSuperAdmin: false,
            isErased: false,
            phone: u.phone ?? null,
            signature: u.signature ?? null,
            hashedPassword,
          },
          select: { id: true, email: true, role: true },
        })
      : await prisma.user.create({
          data: {
            email: u.email,
            name: u.name,
            role: u.role,
            organizationId: EDUIT_ORG_ID,
            type: "HUMAN",
            isSuperAdmin: false,
            phone: u.phone ?? null,
            signature: u.signature ?? null,
            hashedPassword,
          },
          select: { id: true, email: true, role: true },
        });
    userIdByEmail.set(u.email, user.id);

    // Vincula ao preset Role correspondente (UserRoleAssignment). Sem isto o
    // loadAuthzContext acha permissions=[] e barra o usuário em rotas com can().
    const presetRole = await ensurePresetRole(EDUIT_ORG_ID, u.role);
    await prisma.userRoleAssignment.upsert({
      where: { userId_roleId: { userId: user.id, roleId: presetRole.id } },
      create: {
        userId: user.id,
        roleId: presetRole.id,
        organizationId: EDUIT_ORG_ID,
      },
      update: {},
    });
    console.log(`  ✔ ${u.email} (${u.role}) → role "${presetRole.name}"`);
  }

  // ─── 3. Produtos (catálogo estava vazio) ────────────────────────────────
  const productIdBySku = new Map<string, string>();
  for (const p of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { organizationId_sku: { organizationId: EDUIT_ORG_ID, sku: p.sku } },
      create: {
        organizationId: EDUIT_ORG_ID,
        name: p.name,
        sku: p.sku,
        price: p.price,
        description: p.description,
        isActive: true,
      },
      update: { name: p.name, price: p.price, description: p.description, isActive: true },
      select: { id: true },
    });
    productIdBySku.set(p.sku, product.id);
  }
  console.log(`  ✔ ${PRODUCTS.length} produtos garantidos`);

  // ─── 4. Redistribuir parte do mock entre os usuários de teste ───────────
  // Pega os deals de seed da org (qualquer prefixo conhecido) e distribui
  // owners variados, pra que SELF vs ALL seja visível ao logar com cada perfil.
  const seedDeals = await prisma.deal.findMany({
    where: {
      organizationId: EDUIT_ORG_ID,
      OR: [
        { externalId: { startsWith: SEED_PREFIX } },
        { externalId: { startsWith: "local-seed-" } },
      ],
    },
    orderBy: { number: "asc" },
    select: { id: true, contactId: true },
  });

  const ownersRotation = [
    userIdByEmail.get("operador@eduit.com.br")!,
    userIdByEmail.get("operador2@eduit.com.br")!,
    userIdByEmail.get("gestor@eduit.com.br")!,
  ];
  // Mantém ~metade com o admin (índices pares ficam com admin original).
  let reassigned = 0;
  for (let i = 0; i < seedDeals.length; i++) {
    if (i % 2 === 0) continue; // metade segue com o admin
    const d = seedDeals[i];
    const newOwner = ownersRotation[reassigned % ownersRotation.length];
    await prisma.deal.update({ where: { id: d.id }, data: { ownerId: newOwner } });
    if (d.contactId) {
      await prisma.contact.update({
        where: { id: d.contactId },
        data: { assignedToId: newOwner },
      });
      await prisma.conversation.updateMany({
        where: { contactId: d.contactId },
        data: { assignedToId: newOwner },
      });
    }
    reassigned++;
  }
  console.log(`  ✔ ${reassigned} deals (e contatos/conversas) redistribuídos entre os perfis de teste`);

  // ─── 5. Vincular produtos a alguns deals (DealProduct) ──────────────────
  const productList = [...productIdBySku.values()];
  let linkedProducts = 0;
  for (let i = 0; i < seedDeals.length && i < productList.length * 2; i++) {
    const d = seedDeals[i];
    const productId = productList[i % productList.length];
    const existing = await prisma.dealProduct.findFirst({
      where: { dealId: d.id, productId },
      select: { id: true },
    });
    if (existing) continue;
    const prod = PRODUCTS[i % PRODUCTS.length];
    await prisma.dealProduct.create({
      data: {
        organizationId: EDUIT_ORG_ID,
        dealId: d.id,
        productId,
        quantity: 1,
        unitPrice: prod.price,
        discount: 0,
      },
    });
    linkedProducts++;
  }
  console.log(`  ✔ ${linkedProducts} vínculos produto↔deal criados`);

  console.log("\n✅ Seed de usuários de teste concluído!\n");
  console.log("   Credenciais geradas agora (exibidas só nesta execução):");
  for (const u of TEST_USERS) {
    console.log(`   ${u.email.padEnd(28)} ${u.role.padEnd(8)} ${issuedPasswords.get(u.email)}`);
  }
  console.log("   (adm@eduit.com.br — super-admin já existente, senha não alterada)");
}

main()
  .catch((e) => {
    console.error("✗ Erro no seed de usuários de teste:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
