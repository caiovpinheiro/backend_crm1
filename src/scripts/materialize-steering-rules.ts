/**
 * Move para o banco o texto de regras que hoje o runner injeta do pack.
 *
 * Enquanto `AIAgentConfig.steeringRules` está vazio, o runtime completa com
 * `fallbackRules(archetype)` do vertical pack. Isso faz o agente obedecer a
 * um documento que o operador não vê na tela, não consegue editar e nem
 * sabe que existe — inclusive instruções para chamar ferramenta que ele
 * desligou. Regra de produto é configuração; configuração mora no banco.
 *
 * O texto é montado POR ORGANIZAÇÃO (leva nome da instituição e URLs da
 * config do tenant), então cada agente é processado dentro do contexto da
 * org dele. O conteúdo gravado é exatamente o que o agente já recebia: este
 * script não reescreve regra de cliente nenhum.
 *
 * RODE ANTES do deploy que remove o fallback do runner. Depois dele, agente
 * com `steeringRules` vazio fica sem as regras.
 *
 * Local:
 *   npx tsx src/scripts/materialize-steering-rules.ts            # simulação
 *   npx tsx src/scripts/materialize-steering-rules.ts --apply
 *   npx tsx src/scripts/materialize-steering-rules.ts --apply --org <slug>
 *
 * EasyPanel (/app):
 *   node dist/workers/materialize-steering-rules.js --apply
 *
 * prismaBase: script fora de RequestContext (varre todas as orgs).
 */
import { fallbackSteeringRules } from "@/lib/ai-agents/system-prompt";
import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";

function arg(flag: string, fallback = ""): string {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const orgSlug = arg("--org").trim();

  const organizationId = orgSlug
    ? ((
        await prismaBase.organization.findUnique({
          where: { slug: orgSlug },
          select: { id: true },
        })
      )?.id ?? null)
    : null;
  if (orgSlug && !organizationId) {
    console.error(`Organização "${orgSlug}" não encontrada.`);
    process.exit(1);
  }

  const agents = await prismaBase.aIAgentConfig.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      verticalPack: { not: null },
      OR: [{ steeringRules: null }, { steeringRules: "" }],
    },
    select: {
      id: true,
      organizationId: true,
      archetype: true,
      verticalPack: true,
      user: { select: { name: true } },
    },
  });

  console.log(
    `${agents.length} agente(s) com regras vindas do pack${apply ? "" : " (simulação)"}.`,
  );

  let written = 0;
  let empty = 0;
  for (const a of agents) {
    // Contexto da org: o texto do pack resolve nome e URLs do tenant.
    const rules = await runWithContext(
      { organizationId: a.organizationId, userId: "script", isSuperAdmin: false },
      () => fallbackSteeringRules(a.archetype, a.verticalPack),
    );
    const name = a.user?.name ?? a.id;
    if (!rules.trim()) {
      // Arquétipo sem regra no pack: nada a materializar, nada se perde.
      empty += 1;
      console.log(`  - ${name} (${a.archetype}): pack não define regras`);
      continue;
    }
    console.log(`  + ${name} (${a.archetype}): ${rules.length} caracteres`);
    if (apply) {
      await prismaBase.aIAgentConfig.update({
        where: { id: a.id },
        data: { steeringRules: rules },
      });
      written += 1;
    }
  }

  console.log(
    apply
      ? `Gravado em ${written} agente(s); ${empty} sem regra no pack.`
      : `Simulação: ${agents.length - empty} agente(s) receberiam texto. Rode com --apply.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prismaBase.$disconnect());
