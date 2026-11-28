import { describe, expect, it } from "vitest";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2Intake } from "@/lib/ai-v2/types";
import { activeIntakes, calendarFactsSection, intakesPromptSection } from "../calendar";
import { fixedSources, factsBackedBy } from "../no-source";

const TZ = "America/Sao_Paulo";
// Meio-dia em São Paulo do dia pedido.
const at = (isoDay: string) => new Date(`${isoDay}T15:00:00Z`);

const INTAKES: V2Intake[] = [
  { id: "g26", level: "graduacao", label: "Turma 2026.2", enrollFrom: "2026-06-01", enrollUntil: "2026-09-30", classesStart: "2026-10-05", firstPaymentDue: "10/10/2026" },
  { id: "g27", level: "graduacao", label: "Turma 2027.1", enrollFrom: "2026-10-01", enrollUntil: "2027-03-15", classesStart: "fevereiro de 2027", firstPaymentDue: "2027-02-25" },
  { id: "p27", level: "pos", label: "Turma de pós 2027", enrollFrom: "2026-11-01", enrollUntil: "2026-12-20", classesStart: "2027-01-12" },
];

describe("entradas: configuração", () => {
  it("guarda as válidas e descarta linha sem período, com período invertido ou sem início das aulas", () => {
    const c = normalizeV2Config({
      name: "A", tone: "t",
      calendar: {
        events: [],
        intakes: [
          { level: "graduacao", label: "Turma 2027.1", enrollFrom: "2026-10-01", enrollUntil: "2027-03-15", classesStart: "fevereiro de 2027", firstPaymentDue: "2027-02-25" },
          { level: "pos", enrollFrom: "2026-12-01", enrollUntil: "2026-11-01", classesStart: "2027-01-12" },
          { level: "graduacao", enrollFrom: "2026-10-01", enrollUntil: "2026-12-01", classesStart: "  " },
          { level: "qualquer", enrollFrom: "2026-01-01", enrollUntil: "2026-02-01", classesStart: "março" },
        ],
      },
    });
    const intakes = c.calendar?.intakes ?? [];
    expect(intakes).toHaveLength(2);
    expect(intakes[0]).toMatchObject({ level: "graduacao", label: "Turma 2027.1", firstPaymentDue: "2027-02-25" });
    expect(intakes[1]).toMatchObject({ level: "todos", classesStart: "março" });
  });
});

describe("entradas: qual vale hoje", () => {
  it("dentro do período, na virada e fora", () => {
    expect(activeIntakes(INTAKES, at("2026-09-30"), TZ).get("graduacao")?.id).toBe("g26");
    expect(activeIntakes(INTAKES, at("2026-10-01"), TZ).get("graduacao")?.id).toBe("g27");
    expect(activeIntakes(INTAKES, at("2027-03-15"), TZ).get("graduacao")?.id).toBe("g27");
    expect(activeIntakes(INTAKES, at("2027-03-16"), TZ).get("graduacao")).toBeNull();
  });

  it("virada pelo fuso do agente: 23h de 30/09 em São Paulo ainda é a entrada antiga", () => {
    const lateNight = new Date("2026-10-01T02:00:00Z"); // 30/09 23h em São Paulo
    expect(activeIntakes(INTAKES, lateNight, TZ).get("graduacao")?.id).toBe("g26");
  });

  it("graduação e pós separadas: cada uma com a sua entrada", () => {
    const m = activeIntakes(INTAKES, at("2026-11-26"), TZ);
    expect(m.get("graduacao")?.id).toBe("g27");
    expect(m.get("pos")?.id).toBe("p27");
    expect(activeIntakes(INTAKES, at("2026-10-15"), TZ).get("pos")).toBeNull();
  });
});

describe("entradas: prompt e conferência", () => {
  it("linhas de fato com turma, início e primeiro pagamento; nível sem entrada diz que a data vem na inscrição", () => {
    const s = intakesPromptSection(INTAKES, at("2026-10-15"), TZ);
    expect(s).toContain("# Entradas e início das aulas (calculado para hoje, 15/10/2026)");
    expect(s).toContain("Graduação: matrícula feita hoje entra na Turma 2027.1; as aulas começam em fevereiro de 2027; o primeiro pagamento vence em 25/02/2027");
    expect(s).toContain("Pós-graduação: hoje não há entrada aberta cadastrada");
    expect(s).toContain("vale a do cartão");
    expect(intakesPromptSection(undefined, at("2026-10-15"), TZ)).toBe("");
    expect(calendarFactsSection({ events: [], intakes: INTAKES }, at("2026-11-26"), TZ)).toContain("Pós-graduação: matrícula feita hoje entra na Turma de pós 2027; as aulas começam em 12/01/2027");
  });

  it("a data da entrada vigente vale como fonte na conferência", () => {
    const config = { calendar: { events: [], intakes: INTAKES }, businessHours: { timezone: TZ }, variables: [], globalRules: [], themes: [] } as never;
    const sources = fixedSources(config, null, []);
    expect(factsBackedBy("O primeiro pagamento vence em 25/02/2027.", sources)).toBe(true);
    expect(factsBackedBy("O primeiro pagamento vence em 10/03/2027.", sources)).toBe(false);
  });
});
