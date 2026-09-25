/**
 * O que o modelo pode usar num turno: ferramentas de consulta e ações.
 * Um só lugar para produção e "Testar agora", que antes decidiam cada um
 * do seu jeito. Nenhum domínio de cliente.
 */

import type { V2Action, V2AgentConfig } from "@/lib/ai-v2/types";

import { QUERY_TOOL_NAMES } from "./theme-prompt";

/** Ações que a tela libera em "O que ele pode fazer". */
export const CONFIGURABLE_ACTIONS = ["ask_with_options", "add_tag", "move_stage", "create_activity", "add_note"] as const;

type Theme = V2AgentConfig["themes"][number] | null | undefined;

/**
 * Lista de ferramentas/ações do assunto, quando ele restringe. A tela cria
 * todo assunto com `allowedTools: []` e não tem onde editar: lista vazia
 * lida como "nada permitido" deixava o agente sem busca, sem CRM e sem
 * ações sempre que um assunto estava ativo. Vazia = sem restrição do assunto.
 */
export function themeToolRestriction(theme: Theme): Set<string> | null {
  return theme?.allowedTools && theme.allowedTools.length > 0 ? new Set(theme.allowedTools) : null;
}

/**
 * Modelos de mensagem liberados no turno. A tela grava os do assunto em
 * `allowedMessageModelIds`; `messageModelIds` é o nome legado.
 */
export function allowedMessageModelIdsFor(config: V2AgentConfig, theme: Theme): string[] {
  if (theme?.allowedMessageModelIds?.length) return theme.allowedMessageModelIds;
  if (theme?.messageModelIds?.length) return theme.messageModelIds;
  return config.allowedMessageModelIds ?? [];
}

/** Ações que o modelo pode devolver em `actions` (handoff é tratado à parte). */
export function allowedActionTypes(config: V2AgentConfig, theme: Theme): Set<string> {
  const restriction = themeToolRestriction(theme);
  const allowed = new Set<string>([
    ...(restriction ?? config.enabledTools ?? []),
    "close_conversation",
    "set_theme",
    "set_variable",
  ]);
  // A lista de mensagens prontas liberadas é a permissão: com ela, enviar
  // uma mensagem pronta vale mesmo que o assunto não liste a ação.
  if (allowedMessageModelIdsFor(config, theme).length > 0) allowed.add("send_message_model");
  return allowed;
}

/**
 * Ferramentas de consulta de uma lista (do assunto ou global). Uma lista só
 * com ações não restringe as consultas: liberar "etiquetar" não pode tirar
 * a busca nos materiais. Sem nenhuma consulta na lista = sem restrição.
 */
export function queryToolRestriction(list: Iterable<string> | null | undefined): Set<string> | null {
  const queries = [...(list ?? [])].filter((t) => QUERY_TOOL_NAMES.includes(t));
  return queries.length > 0 ? new Set(queries) : null;
}

/**
 * Etiqueta e etapa só das listas escolhidas na tela. Lista vazia não
 * restringe (agentes de antes da lista: etiqueta que não existe no CRM já
 * não é aplicada). Vale para o que o modelo devolve; atalhos automáticos
 * têm o valor fixo que a pessoa escreveu.
 */
export function actionValueAllowed(config: V2AgentConfig, action: V2Action): boolean {
  const a = action as { type: string; tag?: unknown; stageId?: unknown };
  if (a.type === "add_tag") {
    const tags = config.actionOptions?.tags ?? [];
    const tag = typeof a.tag === "string" ? a.tag.trim().toLowerCase() : "";
    return tags.length === 0 || (!!tag && tags.some((t) => t.trim().toLowerCase() === tag));
  }
  if (a.type === "move_stage") {
    const stages = config.actionOptions?.stageIds ?? [];
    return stages.length === 0 || (typeof a.stageId === "string" && stages.includes(a.stageId));
  }
  return true;
}

/**
 * Ações liberadas no turno, com o formato de cada uma. Antes o modelo só
 * via os nomes, e só quando o assunto restringia: não sabia que campos
 * mandar, e etiqueta e etapa saíam inventadas.
 */
export function actionsGuide(allowed: Set<string>, options: { tags: string[]; stages: Array<{ id: string; name: string }> }): string {
  const lines: string[] = [];
  if (allowed.has("ask_with_options")) {
    lines.push('- Perguntar com botões: {"type":"ask_with_options","options":["Opção 1","Opção 2"]}. A pergunta vai na reply; de 2 a 3 opções curtas. Use quando o cliente precisa escolher entre caminhos definidos.');
  }
  if (allowed.has("add_tag")) {
    lines.push(
      options.tags.length > 0
        ? `- Etiquetar o cliente: {"type":"add_tag","tag":"<nome>"}. Só estas etiquetas: ${options.tags.join("; ")}. Use quando as instruções pedirem ou o pedido se encaixar claramente numa delas.`
        : '- Etiquetar o cliente: {"type":"add_tag","tag":"<nome>"}. Só com etiquetas citadas nas instruções.',
    );
  }
  if (allowed.has("move_stage") && options.stages.length > 0) {
    lines.push(`- Mover o negócio de etapa: {"type":"move_stage","stageId":"<id>"}. Etapas: ${options.stages.map((s) => `${s.id} (${s.name})`).join("; ")}. Só quando as instruções pedirem.`);
  }
  if (allowed.has("create_activity")) {
    lines.push('- Criar tarefa para a equipe: {"type":"create_activity","activityType":"TASK","content":"o que precisa ser feito e por quê"}. Use quando algo depende da equipe e não precisa transferir agora.');
  }
  if (allowed.has("add_note")) {
    lines.push('- Anotação interna: {"type":"add_note","content":"resumo do que o cliente informou"}. O cliente não vê.');
  }
  if (lines.length === 0) return "";
  return [
    "# Ações que você pode fazer",
    "Devolva em actions, junto com a reply, só quando fizer sentido neste turno. Nunca diga ao cliente que fez algo que não está em actions.",
    ...lines,
  ].join("\n");
}

/** Aceita opções como string ou `{ label }` (formato livre do LLM). */
export function normalizeAskOptions(raw: unknown[] | undefined): Array<{ label: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string }> = [];
  for (const opt of raw) {
    const label =
      typeof opt === "string"
        ? opt
        : opt && typeof opt === "object" && typeof (opt as { label?: unknown }).label === "string"
          ? (opt as { label: string }).label
          : "";
    if (label.trim()) out.push({ label: label.trim() });
  }
  return out.slice(0, 10);
}
