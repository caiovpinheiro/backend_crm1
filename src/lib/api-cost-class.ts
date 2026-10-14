/**
 * Classe de custo de uma chamada à API (rota + método). Mapa central: o
 * limitador por usuário (`api-cost-limit.ts`) e a proteção contra sobrecarga
 * (`overload-guard.ts`) decidem pela classe, nunca pela rota solta.
 *
 * Classes
 * ───────
 * - `essential` (a): SEM limite e nunca recusada por sobrecarga. Envio de
 *   mensagem (texto, anexo, mídia, template, produto, encaminhar), anexos,
 *   mover negócio, salvar edição (POST/PUT/PATCH/DELETE de entidades),
 *   login/logout e `/api/auth/*`.
 * - `cached_read` (b): leituras comuns (cacheadas / 304). Limite alto.
 * - `heavy_read` (c): leituras caras — board do funil, contato, negócio,
 *   histórico de mensagens, calling-context, agendadas e qualquer GET com
 *   busca (`?search=` / `?q=` não vazio). Token bucket por usuário.
 * - `accessory` (d): presença, ping, digitando, alertas, status de agente
 *   (leitura). Limite baixo; primeira a ser recusada sob sobrecarga.
 *
 * Fora do mapa
 * ────────────
 * - GET/HEAD fora do mapa → `cached_read`: leitura é o que um loop de render
 *   repete, então precisa de teto; o teto é alto o bastante para nenhuma tela
 *   normal encostar nele.
 * - Escrita fora do mapa → `essential`: escrita é ação do usuário (salvar,
 *   mover, enviar). Recusar perde trabalho dele, e escrita em loop já tem os
 *   limites próprios das rotas (Bearer, org, bulk). Na dúvida, não bloquear.
 * - Sem método/rota (handler chamado fora do middleware) → `essential`.
 *
 * Sem dependência de Node: o middleware (Edge) também pode importar.
 */

export const API_COST_CLASSES = ["essential", "cached_read", "heavy_read", "accessory"] as const;
export type ApiCostClass = (typeof API_COST_CLASSES)[number];

/** Letra da classe no desenho original (a–d), para log e documentação. */
export const API_COST_CLASS_LETTER: Record<ApiCostClass, "a" | "b" | "c" | "d"> = {
  essential: "a",
  cached_read: "b",
  heavy_read: "c",
  accessory: "d",
};

type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
type Rule = {
  /** Métodos a que a regra se aplica; `*` = todos. */
  methods: readonly Method[] | "*";
  /** Casa o pathname inteiro (sem query). `:id` = um segmento. */
  pattern: RegExp;
  cls: ApiCostClass;
  /** Por que está aqui (aparece nos testes e na revisão). */
  note: string;
};

const SEG = "[^/]+";
const p = (path: string): RegExp =>
  new RegExp(`^${path.replace(/:id/g, SEG).replace(/\/\*\*$/, "(?:/.*)?")}/?$`);

const READ: readonly Method[] = ["GET", "HEAD"];
const WRITE: readonly Method[] = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Mapa central. A primeira regra que casa vence — as essenciais vêm antes
 * para que nenhuma regra de leitura/acessória capture envio por engano.
 */
export const API_COST_RULES: readonly Rule[] = [
  // ── (a) essenciais ────────────────────────────────────────────────────
  { methods: "*", pattern: p("/api/auth/**"), cls: "essential", note: "login/logout/sessão (NextAuth, MFA, senha)" },
  { methods: "*", pattern: p("/api/me/sessions/revoke-all"), cls: "essential", note: "sair de todos os dispositivos" },
  { methods: WRITE, pattern: p("/api/conversations/:id/messages"), cls: "essential", note: "enviar mensagem" },
  { methods: WRITE, pattern: p("/api/conversations/:id/attachments"), cls: "essential", note: "enviar anexo/mídia" },
  { methods: WRITE, pattern: p("/api/conversations/:id/template"), cls: "essential", note: "enviar template" },
  { methods: WRITE, pattern: p("/api/conversations/:id/products"), cls: "essential", note: "enviar produto" },
  { methods: WRITE, pattern: p("/api/conversations/:id/forward"), cls: "essential", note: "encaminhar mensagem" },
  { methods: WRITE, pattern: p("/api/conversations/create"), cls: "essential", note: "iniciar conversa" },
  { methods: WRITE, pattern: p("/api/deals/:id/messages"), cls: "essential", note: "enviar mensagem pelo negócio" },
  { methods: WRITE, pattern: p("/api/whatsapp-groups/:id/messages"), cls: "essential", note: "enviar mensagem em grupo" },
  { methods: WRITE, pattern: p("/api/messages/**"), cls: "essential", note: "reação/favorito/edição de mensagem" },
  { methods: WRITE, pattern: p("/api/deals/:id/move"), cls: "essential", note: "mover negócio" },
  { methods: WRITE, pattern: p("/api/uploads/**"), cls: "essential", note: "upload de anexo" },
  { methods: "*", pattern: p("/api/storage/**"), cls: "essential", note: "baixar anexo (storage)" },
  { methods: "*", pattern: p("/api/uploads/**"), cls: "essential", note: "baixar anexo (uploads legado)" },
  { methods: "*", pattern: p("/api/media/**"), cls: "essential", note: "mídia do chat (proxy/áudio)" },
  { methods: WRITE, pattern: p("/api/agents/:id/status"), cls: "essential", note: "agente muda o próprio status (Online/Ausente)" },
  { methods: WRITE, pattern: p("/api/agents/me/activity"), cls: "essential", note: "renova a sessão por inatividade" },

  // ── (d) acessórias ────────────────────────────────────────────────────
  { methods: "*", pattern: p("/api/presence/beat"), cls: "accessory", note: "batida única: presença de uso + quem está vendo" },
  { methods: "*", pattern: p("/api/presence/heartbeat"), cls: "accessory", note: "quem está vendo" },
  { methods: "*", pattern: p("/api/agents/me/ping"), cls: "accessory", note: "presença de uso" },
  { methods: "*", pattern: p("/api/conversations/:id/typing"), cls: "accessory", note: "digitando…" },
  { methods: READ, pattern: p("/api/activities/alerts"), cls: "accessory", note: "alertas de atividade (polling)" },
  { methods: READ, pattern: p("/api/agents/:id/status"), cls: "accessory", note: "status de agente (leitura)" },

  // ── (b) leituras comuns explícitas ────────────────────────────────────
  { methods: READ, pattern: p("/api/me/live"), cls: "cached_read", note: "voláteis do shell (status do agente, não lidas) — fora do bootstrap v2" },

  // ── (c) leituras pesadas ──────────────────────────────────────────────
  { methods: READ, pattern: p("/api/pipelines/:id/board"), cls: "heavy_read", note: "board do funil" },
  { methods: READ, pattern: p("/api/pipelines/:id/board/columns"), cls: "heavy_read", note: "colunas do board" },
  { methods: READ, pattern: p("/api/contacts/:id"), cls: "heavy_read", note: "ficha do contato" },
  { methods: READ, pattern: p("/api/deals/:id"), cls: "heavy_read", note: "negócio" },
  { methods: READ, pattern: p("/api/conversations/:id/calling-context"), cls: "heavy_read", note: "contexto de ligação" },
  { methods: READ, pattern: p("/api/conversations/:id/messages"), cls: "heavy_read", note: "histórico de mensagens" },
  { methods: READ, pattern: p("/api/scheduled-messages"), cls: "heavy_read", note: "mensagens agendadas" },
  { methods: READ, pattern: p("/api/scheduled-messages/:id"), cls: "heavy_read", note: "mensagem agendada" },
];

/** Parâmetros de busca que tornam qualquer GET uma leitura pesada. */
export const API_COST_SEARCH_PARAMS = ["search", "q"] as const;

/** `true` se algum parâmetro de busca vem preenchido. */
export function hasSearchParam(search: URLSearchParams | string | null | undefined): boolean {
  if (!search) return false;
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return API_COST_SEARCH_PARAMS.some((k) => (params.get(k)?.trim() ?? "") !== "");
}

export type ApiCostRequest = {
  method?: string | null;
  /** Pathname (sem query). */
  path?: string | null;
  /** GET com `search`/`q` preenchido. */
  hasSearch?: boolean;
};

/** Classe da chamada. Ver a regra de "fora do mapa" no topo. */
export function classifyApiRequest(req: ApiCostRequest): ApiCostClass {
  const method = (req.method ?? "").toUpperCase();
  const path = (req.path ?? "").split("?")[0];
  if (!method || !path) return "essential";
  if (method === "OPTIONS") return "essential";
  for (const rule of API_COST_RULES) {
    if (rule.methods !== "*" && !rule.methods.includes(method as Method)) continue;
    if (rule.pattern.test(path)) return rule.cls;
  }
  const isRead = method === "GET" || method === "HEAD";
  if (!isRead) return "essential";
  if (req.hasSearch) return "heavy_read";
  return "cached_read";
}
