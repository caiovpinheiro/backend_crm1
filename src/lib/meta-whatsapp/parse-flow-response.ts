/**
 * Extrai e formata payload de respostas WhatsApp Flow (nfm_reply / flow_reply).
 */

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function sanitizeFlowFieldKey(key: string): string {
  return key.trim().replace(/[^a-zA-Z0-9_]/g, "_") || "campo";
}

/** Parseia `response_json` do webhook Meta em objeto de campos. */
export function parseWhatsappFlowResponsePayload(
  nfm: Record<string, unknown>,
): { payload: Record<string, unknown>; flowToken: string | null; flowMetaName: string | null } | null {
  const rawJson = nfm.response_json;
  let payload: Record<string, unknown> | null = null;

  if (typeof rawJson === "string" && rawJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  } else if (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson)) {
    payload = rawJson as Record<string, unknown>;
  }

  if (!payload) return null;

  const fromPayload =
    typeof payload.flow_token === "string" ? payload.flow_token.trim() : "";
  const fromNfm = typeof nfm.flow_token === "string" ? nfm.flow_token.trim() : "";
  const flowToken = fromPayload || fromNfm || null;

  const entries = Object.fromEntries(
    Object.entries(payload).filter(([k]) => k !== "flow_token" && !k.startsWith("__")),
  );

  if (Object.keys(entries).length === 0) return null;

  return {
    payload: entries,
    flowToken,
    flowMetaName: str(nfm.name) || null,
  };
}

/**
 * Converte chave crua do Meta Flows em label legível.
 *
 * Os Flows do WhatsApp serializam respostas no formato
 * `screen_<n>_Nome_Do_Campo_<idx>` (ex.: `screen_0_Nome_Completo_0`).
 * Antes, o `formatKey` só fazia uppercase da primeira letra e
 * retornava o key cru quando já tinha maiúscula — o operador via
 * `screen_0_Nome_Completo_0: ...` na inbox, ilegível.
 *
 * Agora:
 *  - remove prefixo `screen_<n>_`
 *  - remove sufixo `_<n>` (índice do campo na tela)
 *  - troca `_` por espaço
 *  - title-case por palavra
 */
// Conectivos que permanecem em minúsculo no meio do título (português
// e inglês curtos). A primeira palavra ainda é capitalizada.
const LOWERCASE_TITLE_STOPWORDS = new Set([
  "de", "do", "da", "dos", "das", "e", "ou", "a", "o", "em",
  "no", "na", "nos", "nas", "para", "por", "of", "the", "to", "and",
]);

/**
 * Normaliza uma string para comparação tolerante (matching de campos
 * Flow): remove acentos, baixa caixa e descarta tudo que não for
 * alfanumérico. Ex.: "Número de Telefone" e "Numero_de_Telefone" →
 * "numerodetelefone".
 */
export function normalizeFlowMatchKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function cleanFlowFieldLabel(k: string): string {
  let s = k.replace(/^screen_\d+_/i, "").replace(/_\d+$/, "");
  s = s.replace(/_+/g, " ").trim();
  if (!s) return "Campo";
  return s
    .split(" ")
    .map((w, idx) => {
      if (w.length === 0) return w;
      const lower = w.toLowerCase();
      if (idx > 0 && LOWERCASE_TITLE_STOPWORDS.has(lower)) return lower;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * Limpa um valor de resposta do Flow.
 *
 * Opções de single/multi-select chegam como `<idx>_Texto_Da_Opcao`
 * (ex.: `0_SIM`, `2_Noite`, `0_1_ano_do_ensino_médio`,
 * `0_Anoto_e_falo_com_o_supervisor_😅`). Removemos o índice no
 * início e voltamos os underscores pra espaço. Datas ISO viram
 * DD/MM/AAAA. Arrays e strings com vírgula viram lista limpa.
 */
function cleanFlowFieldValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    return v
      .map((item) => cleanFlowFieldValue(item))
      .filter((s) => s && s !== "—")
      .join(", ");
  }
  if (typeof v === "object") {
    return JSON.stringify(v);
  }
  let s = String(v);

  // Data ISO (YYYY-MM-DD) → DD/MM/AAAA
  const isoDate = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (isoDate) {
    return `${isoDate[3]}/${isoDate[2]}/${isoDate[1]}`;
  }

  // Multi-select pode vir como "1_Tarde, 0_Manhã" — limpa cada item
  // separadamente. Heurística: se contém ", " e mais de um termo
  // começa com "<dígito>_", trata como lista.
  if (s.includes(", ")) {
    const parts = s.split(", ");
    const allOptions = parts.every((p) => /^\d+_/.test(p));
    if (allOptions) {
      return parts.map((p) => cleanSingleOption(p)).join(", ");
    }
  }

  return cleanSingleOption(s);
}

function cleanSingleOption(s: string): string {
  // Remove índice de opção no início (ex.: "0_SIM" → "SIM")
  let cleaned = s.replace(/^\d+_/, "");
  // Converte underscores em espaços
  cleaned = cleaned.replace(/_+/g, " ").trim();
  return cleaned || "—";
}

export function formatWhatsappFlowResponse(nfm: Record<string, unknown>): string | null {
  const parsed = parseWhatsappFlowResponsePayload(nfm);
  if (!parsed) return null;

  const flowName = parsed.flowMetaName;
  // Nome do flow vem como o operador definiu na Meta (ex.:
  // `cadastro_estagiario`, `form_clt`). Só substituímos underscores
  // por espaço — não removemos prefixo numérico (não é uma opção
  // de single-select).
  const prettyName = flowName ? flowName.replace(/_+/g, " ").trim() : null;
  const headerLabel = prettyName
    ? `📋 *Resposta do formulário* — _${prettyName}_`
    : `📋 *Resposta do formulário*`;

  // Layout pergunta / resposta com linha em branco entre pares.
  // WhatsApp renderiza *bold* e _italic_ nativamente, então o
  // operador vê hierarquia visual sem precisar parsear texto.
  const blocks = Object.entries(parsed.payload).map(([k, v]) => {
    const label = cleanFlowFieldLabel(k);
    const value = cleanFlowFieldValue(v);
    return `*${label}*\n↳ ${value}`;
  });

  const full = `${headerLabel}\n\n${blocks.join("\n\n")}`;
  // Limite ampliado de 1000 → 2000 chars porque formulários com 6+
  // campos chegavam truncados em produção.
  return full.length > 2000 ? `${full.slice(0, 2000)}…` : full;
}
