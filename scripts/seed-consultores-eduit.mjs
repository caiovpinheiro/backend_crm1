/**
 * Seed dos consultores academicos (migracao DataCrazy -> EduIT CRM).
 *
 * Idempotente: pode rodar quantas vezes quiser. Cria/atualiza:
 *   1) Departamentos: Acolhimento, Retencao, Atendimento (por org).
 *   2) Usuarios HUMAN (upsert por email) com senha temporaria.
 *   3) UserRoleAssignment (preset MEMBER) — se o preset existir na org.
 *   4) DepartmentMember (vinculo organizacional N:N).
 *   5) AgentPermission.allowedDepartmentIds — o que REALMENTE controla o
 *      acesso ao inbox / distribuicao por departamento.
 *   6) DistributionResponsible — participa=true + queueLimit (volume ~25),
 *      igual DataCrazy. NAO altera presenca (online/offline).
 *
 * Fonte dos e-mails: GET /api/crm/attendants do DataCrazy (22/07/2026).
 * Removidos a pedido: Debora Mani, Jessica Castro, Gustavo.
 *
 * Uso (dentro do container do backend, que tem DATABASE_URL + prisma):
 *   node scripts/seed-consultores-eduit.mjs            # aplica
 *   DRY_RUN=1 node scripts/seed-consultores-eduit.mjs  # so mostra o plano
 *   ORG_ID=xxx node scripts/seed-consultores-eduit.mjs # forca a org
 *   CONSULTOR_TEMP_PASSWORD=... node ...                # troca a senha padrao
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// O runner (Next standalone) EMPACOTA o bcryptjs no bundle do app e nao o
// deixa como pacote resolvivel em node_modules -> um script avulso quebra com
// ERR_MODULE_NOT_FOUND. Para nao depender disso, tentamos importar o bcryptjs
// e, se falhar, usamos um hash bcrypt pre-computado da senha padrao (cost 12,
// compativel com o bcryptjs.compare do login).
const PRECOMPUTED_HASH =
  "$2b$12$RTKZ8cGWvEhQYRc41/cO9OZ4tc.J6gi8FoinZIRKqZxwdvW3PJzt2"; // "Eduit@!20"

async function makeHash(pw) {
  try {
    const { hash } = await import("bcryptjs");
    return await hash(pw, 12);
  } catch {
    if (pw !== "Eduit@!20") {
      console.error(
        "❌ bcryptjs indisponivel e a senha != padrao — nao consigo gerar o hash.\n" +
          "   Rode com a senha padrao ou disponibilize o bcryptjs.",
      );
      process.exit(1);
    }
    console.warn("  ⚠ bcryptjs nao resolvido no runner — usando hash pre-computado da senha padrao.");
    return PRECOMPUTED_HASH;
  }
}

const TEMP_PASSWORD = process.env.CONSULTOR_TEMP_PASSWORD ?? "Eduit@!20";
const DRY_RUN = process.env.DRY_RUN === "1";
// Por seguranca em prod: NAO reseta a senha de quem ja existe (pode ja ter
// trocado). Senha so e definida ao CRIAR um usuario novo. Para forcar o reset
// de todos para a senha temporaria, rode com RESET_PASSWORDS=1.
const RESET_PASSWORDS = process.env.RESET_PASSWORDS === "1";
// Volume/limite de fila por consultor (igual DataCrazy: ~25 por consultor).
// queueLimit no motor = teto de deals OPEN simultaneos como owner (0 = sem
// limite). Ajustavel via QUEUE_LIMIT=NN. 0 desliga o limite.
const QUEUE_LIMIT = Number.parseInt(process.env.QUEUE_LIMIT ?? "25", 10);

// key interno -> definicao do departamento.
// create=true => reusa se ja existir (findFirst por nome antes de criar, logo
// nao duplica) e CRIA se faltar. Em prod ("Cruzeiro EaD") a org nasce sem
// nenhum departamento, entao os 3 precisam poder ser criados.
const DEPARTMENTS = [
  { key: "acolhimento", name: "Acolhimento", color: "#8B5CF6", icon: "🤝", create: true },
  { key: "retencao", name: "Retenção", color: "#EF4444", icon: "🔁", create: true },
  { key: "atendimento", name: "Atendimento - SAC", color: "#3B82F6", icon: "🎧", create: true },
];

// Regras de departamento (produção):
//  - Wesley + Danubia -> Acolhimento + Retencao
//  - Marilia -> Acolhimento
//  - Demais consultores -> Atendimento ("Atendimento - SAC")
const CONSULTORES = [
  { name: "Wesley Guerreiro", email: "wesley.guerreiro@cruzeiroead.com.br", depts: ["acolhimento", "retencao"] },
  { name: "Danubia", email: "danubia.sousa@cruzeiroead.com.br", depts: ["acolhimento", "retencao"] },
  { name: "Marilia Souza", email: "marilia.nascimento@cruzeiroead.com.br", depts: ["acolhimento"] },
  { name: "Beatriz", email: "beatriz.andrade@cruzeiroead.com.br", depts: ["atendimento"] },
  { name: "Breno", email: "breno.silva@cruzeiroead.com.br", depts: ["atendimento"] },
  { name: "Camila Ferreira", email: "erica.ferreira@cruzeiroead.com.br", depts: ["atendimento"] },
  { name: "Emanuel Felipe", email: "emanuel.felipe@cruzeiroead.com.br", depts: ["atendimento"] },
  { name: "Felipe Guimaraes", email: "felipe.guimaraes@cruzeiroead.com.br", depts: ["atendimento"] },
  { name: "Joyce", email: "joyce.pereira@cruzeiroead.com.br", depts: ["atendimento"] },
  { name: "Julia", email: "julia.rodrigues@cruzeiroead.com.br", depts: ["atendimento"] },
  { name: "Mariana", email: "mariana.vecoso@cruzeiroead.com.br", depts: ["atendimento"] },
];

async function resolveOrgId() {
  if (process.env.ORG_ID) return process.env.ORG_ID;
  const admin = await prisma.user.findFirst({
    where: { email: "admin@eduit.com.br" },
    select: { organizationId: true },
  });
  if (admin?.organizationId) return admin.organizationId;
  // fallback: org com mais usuarios HUMAN
  const grouped = await prisma.user.groupBy({
    by: ["organizationId"],
    where: { type: "HUMAN", organizationId: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { organizationId: "desc" } },
    take: 1,
  });
  return grouped[0]?.organizationId ?? null;
}

async function ensureDepartments(orgId) {
  const map = {};
  for (const d of DEPARTMENTS) {
    let dep = await prisma.department.findFirst({
      where: { organizationId: orgId, name: d.name },
      select: { id: true, name: true },
    });
    if (!dep) {
      if (!d.create) {
        console.error(
          `  ❌ [dept] "${d.name}" nao encontrado (create=false). ` +
            `Confira o nome exato no CRM (Configuracoes > Equipe > Departamentos).`,
        );
        process.exit(1);
      }
      if (DRY_RUN) {
        console.log(`  [dept] CRIARIA "${d.name}"`);
        map[d.key] = `dryrun-${d.key}`;
        continue;
      }
      dep = await prisma.department.create({
        data: {
          organizationId: orgId,
          name: d.name,
          color: d.color,
          icon: d.icon,
          distributionEnabled: true,
        },
        select: { id: true, name: true },
      });
      console.log(`  [dept] criado "${dep.name}" (${dep.id})`);
    } else {
      console.log(`  [dept] ja existe "${dep.name}" (${dep.id})`);
      await prisma.department.update({
        where: { id: dep.id },
        data: { distributionEnabled: true },
      });
    }
    map[d.key] = dep.id;
  }
  return map;
}

async function memberPresetRoleId(orgId) {
  const r = await prisma.role.findFirst({
    where: { organizationId: orgId, systemPreset: "MEMBER" },
    select: { id: true },
  });
  return r?.id ?? null;
}

async function main() {
  const orgId = await resolveOrgId();
  if (!orgId) {
    console.error("❌ Nao consegui resolver a organizacao. Passe ORG_ID=...");
    process.exit(1);
  }
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true },
  });
  console.log(`Org alvo: ${org?.name ?? "?"} (${orgId})`);
  console.log(`Senha temporaria: ${TEMP_PASSWORD}${DRY_RUN ? "  [DRY_RUN]" : ""}\n`);

  const deptMap = await ensureDepartments(orgId);
  const memberRoleId = await memberPresetRoleId(orgId);
  if (!memberRoleId) {
    console.warn(
      "  ⚠ preset Role MEMBER nao encontrado na org — pulo o role assignment.\n" +
        "     (Um admin abrindo /settings/permissions auto-cura os assignments.)\n",
    );
  }

  const hashed = await makeHash(TEMP_PASSWORD);
  let created = 0;
  let updated = 0;

  for (const c of CONSULTORES) {
    const email = c.email.trim().toLowerCase();
    const deptIds = c.depts.map((k) => deptMap[k]).filter(Boolean);

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true, organizationId: true },
    });

    if (DRY_RUN) {
      console.log(
        `  [user] ${existing ? "ATUALIZARIA" : "CRIARIA"} ${c.name} <${email}> -> [${c.depts.join(", ")}]`,
      );
      continue;
    }

    let user;
    if (existing) {
      user = await prisma.user.update({
        where: { email },
        // Nao rebaixa role de quem ja e ADMIN/MANAGER; so garante HUMAN e org.
        // Senha so e resetada com RESET_PASSWORDS=1 (default: nao mexe).
        data: {
          name: c.name,
          type: "HUMAN",
          organizationId: orgId,
          ...(RESET_PASSWORDS ? { hashedPassword: hashed } : {}),
        },
        select: { id: true, role: true },
      });
      updated++;
      console.log(
        `  [user] atualizado ${c.name} <${email}> (${user.id})${RESET_PASSWORDS ? " [senha resetada]" : ""}`,
      );
    } else {
      user = await prisma.user.create({
        data: {
          name: c.name,
          email,
          hashedPassword: hashed,
          type: "HUMAN",
          role: "MEMBER",
          organizationId: orgId,
        },
        select: { id: true, role: true },
      });
      created++;
      console.log(`  [user] criado ${c.name} <${email}> (${user.id})`);
    }

    // Role assignment (preset MEMBER) — idempotente.
    if (memberRoleId) {
      await prisma.userRoleAssignment.upsert({
        where: { userId_roleId: { userId: user.id, roleId: memberRoleId } },
        create: { userId: user.id, roleId: memberRoleId, organizationId: orgId },
        update: {},
        select: { userId: true },
      });
    }

    // DepartmentMember (vinculo organizacional) — idempotente.
    for (const depId of deptIds) {
      await prisma.departmentMember.upsert({
        where: { departmentId_userId: { departmentId: depId, userId: user.id } },
        create: { organizationId: orgId, departmentId: depId, userId: user.id },
        update: {},
        select: { userId: true },
      });
    }

    // AgentPermission.allowedDepartmentIds — controla o inbox/distribuicao.
    await prisma.agentPermission.upsert({
      where: { userId: user.id },
      create: { organizationId: orgId, userId: user.id, allowedDepartmentIds: deptIds },
      update: { allowedDepartmentIds: deptIds },
      select: { userId: true },
    });

    // DistributionResponsible — participa do motor + limite de fila (volume).
    // Nao mexe em presenca (online/offline) nem em lastExecutionAt.
    // Nao reescreve queueLimit no update — o admin pode ter baixado o
    // teto na tela de Distribuicao (mesma regra do roster sync em runtime).
    await prisma.distributionResponsible.upsert({
      where: { organizationId_userId: { organizationId: orgId, userId: user.id } },
      create: {
        organizationId: orgId,
        userId: user.id,
        participates: true,
        queueLimit: QUEUE_LIMIT,
      },
      update: { participates: true },
      select: { userId: true },
    });

    console.log(
      `         depts=[${c.depts.join(", ")}] inbox=${deptIds.length} volume=${QUEUE_LIMIT} ok`,
    );
  }

  console.log(
    `\nResumo: ${created} criados, ${updated} atualizados, ${CONSULTORES.length} consultores no total.` +
      (DRY_RUN ? "  (DRY_RUN — nada gravado)" : ""),
  );
}

main()
  .catch((e) => {
    console.error("❌ Erro:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
