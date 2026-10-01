/**
 * Verificação sintética do vertical pack (sem DB).
 *
 * Uso:
 *   npx tsx scripts/verify-vertical-pack-null.ts
 *
 * Ordem dos interceptos academic (documentada):
 *   pre_assignee:  first_access → greeting_self_serve → …
 *   post_assignee: attendance_scope → inaugural → retention →
 *                  course_shopping → greeting_only → …
 *   (ver src/verticals/academic/intercepts.ts)
 */

import { getVerticalPack } from "../src/verticals";
import { fallbackSteeringRules } from "../src/lib/ai-agents/system-prompt";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function main() {
  assert(getVerticalPack(null) === null, "getVerticalPack(null) === null");
  assert(
    getVerticalPack(undefined) === null,
    "getVerticalPack(undefined) === null",
  );
  assert(getVerticalPack("") === null, 'getVerticalPack("") === null');
  assert(
    getVerticalPack("unknown-pack") === null,
    "unknown pack → null",
  );

  const academic = getVerticalPack("academic");
  assert(academic, "academic pack exists");
  assert(academic.id === "academic", "academic.id");

  const atendimentoRules = academic.fallbackRules("ATENDIMENTO");
  assert(
    atendimentoRules.includes("Blackboard") ||
      atendimentoRules.includes("portal") ||
      atendimentoRules.includes("matrícula") ||
      atendimentoRules.includes("matricula") ||
      atendimentoRules.toLowerCase().includes("aluno"),
    "academic fallbackRules(ATENDIMENTO) contains academic terms",
  );
  assert(
    academic.fallbackRules("SDR") === "",
    'academic.fallbackRules("SDR") === ""',
  );

  assert(
    fallbackSteeringRules("ATENDIMENTO", null) === "",
    "fallbackSteeringRules with null pack is empty",
  );
  assert(
    fallbackSteeringRules("ATENDIMENTO", "academic").length > 0,
    "fallbackSteeringRules(ATENDIMENTO, academic) non-empty",
  );

  assert(
    academic.inboxPolicyDefaults?.interceptRetention === true &&
      academic.inboxPolicyDefaults?.interceptCourseShopping === true &&
      academic.inboxPolicyDefaults?.inauguralEnabled === true,
    "academic inboxPolicyDefaults all true",
  );

  const phases = academic.intercepts.map((i) => `${i.phase}:${i.name}`);
  console.log("Intercept order:");
  for (const p of phases) console.log(`  - ${p}`);

  console.log("OK — vertical pack null/academic checks passed.");
  process.exit(0);
}

main();
