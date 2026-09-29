/**
 * Importar calendário de um arquivo ou texto colado. Linha a linha quando
 * o texto já é "data – evento"; senão (PDF de tabela, mês longe do dia),
 * o modelo do agente organiza. Em ambos os casos o resultado vai para a
 * tela revisar antes de salvar. Nenhum domínio de cliente.
 */

import { z } from "zod";
import { generateWithTools } from "@/services/ai/provider";
import type { V2CalendarEvent } from "@/lib/ai-v2/types";
import { CALENDAR_LIMITS, parseCalendarText } from "./calendar";

const STRUCTURE_SYSTEM = [
  "Você recebe o texto extraído de um calendário (PDF, planilha ou texto). A extração pode ter bagunçado a ordem: o nome do mês às vezes fica longe dos dias, e blocos de meses aparecem em sequência.",
  "Liste TODOS os eventos com data. Deduza mês e ano pela ordem dos blocos, pelos títulos (\"mês de outubro\", \"2026.2\"), pelos intervalos com data completa e pela sequência dos dias. Use o ano de referência quando o texto não disser.",
  "Não invente evento nem data que não esteja no texto. Ignore listas de feriados sem relação com os eventos, cabeçalhos e linhas soltas de números.",
  'Responda só JSON: {"events":[{"start":"AAAA-MM-DD","end":"AAAA-MM-DD (só se for período)","title":"descrição como no texto"}]}.',
].join("\n");

const eventsSchema = z.object({
  events: z.array(z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    title: z.string().min(1),
  })).max(CALENDAR_LIMITS.maxEvents),
});

export type CalendarImportResult = {
  events: V2CalendarEvent[];
  unparsed: string[];
  method: "lines" | "ai";
};

/** Texto já no formato de linhas: lê direto. Poucas linhas com data: organiza com IA. */
export async function importCalendarText(args: {
  text: string;
  defaultYear: number;
  model: string;
  apiKey: string | null;
  forceAi?: boolean;
}): Promise<CalendarImportResult> {
  const lines = args.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const direct = parseCalendarText(args.text, args.defaultYear);
  const coverage = lines.length > 0 ? direct.events.length / lines.length : 0;
  if (!args.forceAi && direct.events.length > 0 && coverage >= 0.6) {
    return { ...direct, method: "lines" };
  }
  if (!args.apiKey) {
    if (direct.events.length > 0) return { ...direct, method: "lines" };
    throw new Error("Não deu para ler as datas deste texto, e o agente não tem chave do modelo para organizar. Cole no formato \"dd/mm/aaaa – evento\", uma por linha.");
  }
  const r = await generateWithTools({
    model: args.model,
    apiKey: args.apiKey,
    system: STRUCTURE_SYSTEM,
    messages: [{ role: "user", content: `Ano de referência: ${args.defaultYear}\n\nTexto:\n${args.text.slice(0, 60_000)}` }] as never,
    temperature: 0,
    maxOutputTokens: 8000,
    maxSteps: 1,
    jsonMode: true,
  });
  const cleaned = r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: z.infer<typeof eventsSchema>;
  try {
    parsed = eventsSchema.parse(JSON.parse(cleaned));
  } catch {
    throw new Error("A organização automática não devolveu um calendário válido. Tente colar o texto no formato \"dd/mm/aaaa – evento\".");
  }
  const events = parsed.events.map((e, i) => ({
    id: `ev_${i + 1}_${e.start}`,
    start: e.start,
    ...(e.end && e.end !== e.start ? { end: e.end } : {}),
    title: e.title.trim(),
  }));
  return { events, unparsed: [], method: "ai" };
}
