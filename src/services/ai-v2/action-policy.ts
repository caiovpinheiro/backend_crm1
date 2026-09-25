/**
 * O que o modelo pode usar num turno: ferramentas de consulta e ações.
 * Um só lugar para produção e "Testar agora", que antes decidiam cada um
 * do seu jeito. Nenhum domínio de cliente.
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";

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
