import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";

/**
 * Seed multi-tenant. Cria (idempotente):
 *   - Organization `EduIT` (id fixo `org_eduit`) — super-admin lives here.
 *   - User super-admin com email e senha configuráveis via env:
 *       SEED_ADMIN_EMAIL    (default: adm@eduit.com.br)
 *       SEED_ADMIN_PASSWORD (default: senha random só na criação — impressa no log)
 *         Se definido no .env, o seed também ATUALIZA o hash em usuário já existente
 *         (útil quando você perdeu a senha aleatória do primeiro run).
 *   - Pipeline default + tags + lossReasons da org EduIT.
 *
 * Ao adicionar novas entidades ao seed, sempre passe `organizationId`.
 * Em runtime, a Prisma Extension exige contexto — mas aqui usamos o
 * PrismaClient direto (sem extension), entao injetamos manualmente.
 */
const prisma = new PrismaClient();

const EDUIT_ORG_ID = "org_eduit";
const DEFAULT_ADMIN_EMAIL = "adm@eduit.com.br";

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() || DEFAULT_ADMIN_EMAIL;
  const passwordFromEnv = Boolean(process.env.SEED_ADMIN_PASSWORD?.trim());
  const adminPassword =
    process.env.SEED_ADMIN_PASSWORD?.trim() || randomBytes(12).toString("base64url");
  const hashedPassword = await hash(adminPassword, 12);

  const org = await prisma.organization.upsert({
    where: { id: EDUIT_ORG_ID },
    update: {},
    create: {
      id: EDUIT_ORG_ID,
      name: "EduIT",
      slug: "eduit",
      status: "ACTIVE",
      primaryColor: "#1e3a8a",
      onboardingCompletedAt: new Date(),
    },
  });
  console.log("Organização criada/atualizada:", org.name);

  const existingAdmin = await prisma.user.findFirst({
    where: { email: adminEmail, organizationId: EDUIT_ORG_ID },
  });
  const admin = existingAdmin
    ? await prisma.user.update({
        where: { id: existingAdmin.id },
        data: {
          organizationId: EDUIT_ORG_ID,
          isSuperAdmin: true,
          ...(passwordFromEnv ? { hashedPassword } : {}),
        },
      })
    : await prisma.user.create({
        data: {
          name: "Admin EduIT",
          email: adminEmail,
          hashedPassword,
          role: "ADMIN",
          organizationId: EDUIT_ORG_ID,
          isSuperAdmin: true,
        },
      });
  console.log("Usuário super-admin criado:", admin.email);
  if (passwordFromEnv) {
    console.log("  ✓ Senha do admin definida/atualizada a partir de SEED_ADMIN_PASSWORD.");
  } else {
    console.log(
      `\n  ⚠ Senha gerada aleatoriamente (defina SEED_ADMIN_PASSWORD pra controlar ou repetir login):\n  → ${adminPassword}\n`,
    );
  }
  if (!process.env.SEED_ADMIN_EMAIL) {
    console.log(
      `  ℹ Email do super-admin: ${adminEmail} (defina SEED_ADMIN_EMAIL pra customizar).`,
    );
  }

  const existingDefault = await prisma.pipeline.findFirst({
    where: { organizationId: EDUIT_ORG_ID, isDefault: true },
    select: { id: true, name: true },
  });
  const maxPipelineNumber = existingDefault
    ? null
    : await prisma.pipeline.aggregate({
        where: { organizationId: EDUIT_ORG_ID },
        _max: { number: true },
      });
  const defaultPipeline =
    existingDefault ??
    (await prisma.pipeline.create({
      data: {
        organizationId: EDUIT_ORG_ID,
        name: "Pipeline Principal",
        slug: "pipeline-principal",
        number: (maxPipelineNumber?._max.number ?? 0) + 1,
        isDefault: true,
        stages: {
          create: [
            { organizationId: EDUIT_ORG_ID, name: "Qualificação", slug: "qualificacao", number: 1, position: 0, color: "#6366f1", winProbability: 10, rottingDays: 7, isIncoming: true },
            { organizationId: EDUIT_ORG_ID, name: "Contato Feito", slug: "contato-feito", number: 2, position: 1, color: "#8b5cf6", winProbability: 25, rottingDays: 14 },
            { organizationId: EDUIT_ORG_ID, name: "Proposta Enviada", slug: "proposta-enviada", number: 3, position: 2, color: "#a855f7", winProbability: 50, rottingDays: 14 },
            { organizationId: EDUIT_ORG_ID, name: "Negociação", slug: "negociacao", number: 4, position: 3, color: "#f59e0b", winProbability: 75, rottingDays: 21 },
            { organizationId: EDUIT_ORG_ID, name: "Fechamento", slug: "fechamento", number: 5, position: 4, color: "#22c55e", winProbability: 90, rottingDays: 7 },
          ],
        },
      },
      select: { id: true, name: true },
    }));
  console.log("Pipeline default:", defaultPipeline.name);

  const tags = ["Quente", "Frio", "VIP", "Parceiro", "Indicação"];
  const tagColors = ["#ef4444", "#3b82f6", "#f59e0b", "#22c55e", "#8b5cf6"];
  for (let i = 0; i < tags.length; i++) {
    const name = tags[i];
    const existing = await prisma.tag.findFirst({
      where: { organizationId: EDUIT_ORG_ID, name },
      select: { id: true },
    });
    if (!existing) {
      await prisma.tag.create({
        data: {
          organizationId: EDUIT_ORG_ID,
          name,
          color: tagColors[i],
        },
      });
    }
  }
  console.log("Tags garantidas:", tags.join(", "));

  console.log("Seed multi-tenant concluído com sucesso!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
