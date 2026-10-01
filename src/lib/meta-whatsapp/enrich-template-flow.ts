import { randomUUID } from "node:crypto";

import { analyzeTemplateComponents } from "@/lib/meta-whatsapp/analyze-template-components";
import type { MetaWhatsAppClient } from "@/lib/meta-whatsapp/client";
import { MetaFlowEnrichError } from "@/lib/meta-whatsapp/meta-flow-enrich-error";
import { isFlowDefinitionButton } from "@/lib/meta-whatsapp/is-flow-definition-button";
import { getLogger } from "@/lib/logger";

const log = getLogger("meta-whatsapp.enrich-template-flow");

export { isFlowDefinitionButton };

/**
 * Templates com botão FLOW exigem componente `button` + `sub_type: "flow"`
 * no envio, mesmo sem variáveis no corpo/cabeçalho — caso contrário a Meta
 * pode entregar só parte da mensagem (ex.: só o body).
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 * @see https://developers.facebook.com/docs/whatsapp/flows
 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Índice 0-based do botão FLOW na definição do template (Graph `message_templates`). */
export function getFlowButtonIndexFromTemplateDefinition(
  components: unknown,
): string | null {
  if (!Array.isArray(components)) return null;
  let idx = 0;
  for (const c of components) {
    const o = asRecord(c);
    if (!o || String(o.type ?? "").toUpperCase() !== "BUTTONS") continue;
    const buttons = o.buttons;
    if (!Array.isArray(buttons)) continue;
    for (const b of buttons) {
      const btn = asRecord(b);
      if (!btn) continue;
      if (isFlowDefinitionButton(btn)) return String(idx);
      idx += 1;
    }
  }
  return null;
}

function sendPayloadAlreadyHasFlowButton(components: unknown[]): boolean {
  for (const c of components) {
    const o = asRecord(c);
    if (!o) continue;
    const type = String(o.type ?? "").toLowerCase();
    const sub = String(o.sub_type ?? (o as { subType?: string }).subType ?? "").toLowerCase();
    if (type === "button" && sub === "flow") return true;
  }
  return false;
}

/** Extrai `flow_token` do primeiro componente button/flow do payload de envio. */
export function extractFlowTokenFromSendComponents(components: unknown[]): string | null {
  for (const c of components) {
    const o = asRecord(c);
    if (!o) continue;
    const type = String(o.type ?? "").toLowerCase();
    const sub = String(o.sub_type ?? (o as { subType?: string }).subType ?? "").toLowerCase();
    if (type !== "button" || sub !== "flow") continue;
    const params = o.parameters;
    if (!Array.isArray(params) || params.length === 0) continue;
    const p0 = asRecord(params[0]);
    if (!p0 || String(p0.type ?? "").toLowerCase() !== "action") continue;
    const action = asRecord(p0.action);
    const tok = action?.flow_token;
    if (typeof tok === "string" && tok.trim().length > 0) return tok.trim();
  }
  return null;
}

type ListTemplatesRow = {
  name?: string;
  language?: string;
  components?: unknown;
};

function extractTemplatesData(raw: unknown): ListTemplatesRow[] {
  const o = asRecord(raw);
  const data = o?.data;
  return Array.isArray(data) ? (data as ListTemplatesRow[]) : [];
}

function extractPagingAfter(raw: unknown): string | undefined {
  const o = asRecord(raw);
  const paging = asRecord(o?.paging);
  const cursors = asRecord(paging?.cursors);
  const a = cursors?.after;
  return typeof a === "string" && a.length > 0 ? a : undefined;
}

function pickTemplateRow(
  rows: ListTemplatesRow[],
  templateName: string,
  languageCode: string,
): ListTemplatesRow | null {
  const lang = languageCode.trim();
  const name = templateName.trim();
  const exact = rows.find(
    (r) => String(r.name ?? "") === name && String(r.language ?? "").toLowerCase() === lang.toLowerCase(),
  );
  if (exact) return exact;
  return rows.find((r) => String(r.name ?? "") === name) ?? null;
}

/** Botões planos nas secções BUTTONS da definição Graph (só para logs de diagnóstico). */
function collectFlatButtonsFromDefinitionComponents(components: unknown): unknown[] {
  if (!Array.isArray(components)) return [];
  const out: unknown[] = [];
  for (const c of components) {
    const o = asRecord(c);
    if (!o || String(o.type ?? "").toUpperCase() !== "BUTTONS") continue;
    const buttons = o.buttons;
    if (!Array.isArray(buttons)) continue;
    for (const b of buttons) out.push(b);
  }
  return out;
}

type TemplateDefinitionResolution = {
  row: ListTemplatesRow | null;
  resolutionPath:
    | "getMessageTemplateByGraphId"
    | "getMessageTemplateByGraphId_empty"
    | "getMessageTemplateByGraphId_error"
    | "listMessageTemplates"
    | "listMessageTemplates_after_gid_failure"
    | "listMessageTemplates_none";
  /**
   * Preenchido quando o GET individual (`getMessageTemplateByGraphId`) falhou e caímos
   * na listagem. Útil pra propagar a razão original caso a listagem tampouco encontre
   * o template — assim o operador vê o erro real da Meta, não só "template ausente".
   */
  gidFailureMessage?: string;
};

type ListingLookupResult = {
  row: ListTemplatesRow | null;
  /** Motivo pelo qual não achou (só populado quando row=null). Vai pro log/erro final. */
  reason?:
    | { kind: "listing_throw"; message: string; page: number }
    | { kind: "not_found"; pagesScanned: number; totalRowsScanned: number; sameNameDifferentLanguage?: string[] };
};

/**
 * Percorre `listMessageTemplates` até encontrar o template por nome+idioma.
 * Extraído pra ser reutilizado tanto no caminho sem `templateGraphId` quanto
 * como fallback quando o GET individual falha (token com escopo suficiente pra
 * listar mas não pra ler individual — gotcha comum da Graph API).
 *
 * Devolve motivo estruturado quando falha — o chamador propaga isso pro erro
 * final pra que a causa real chegue ao operador em vez de "template ausente"
 * genérico.
 */
async function findTemplateByListing(
  client: MetaWhatsAppClient,
  templateName: string,
  languageCode: string,
): Promise<ListingLookupResult> {
  let after: string | undefined;
  let totalRowsScanned = 0;
  const sameNameDifferentLanguage: Set<string> = new Set();

  // `limit: 200` — valor comprovado seguro pra `message_templates` (usado em
  // outros pontos do backend). Alguns tokens rejeitam >200 com 400.
  for (let page = 0; page < 40; page++) {
    let listRaw: unknown;
    try {
      listRaw = await client.listMessageTemplates({ limit: 200, after });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(
        { phase: "listing_fallback_threw", page, message },
        "[meta-flow-enrich] listing_fallback_threw",
      );
      return { row: null, reason: { kind: "listing_throw", message, page } };
    }
    const rows = extractTemplatesData(listRaw);
    totalRowsScanned += rows.length;

    for (const r of rows) {
      if (
        String(r.name ?? "") === templateName &&
        String(r.language ?? "").toLowerCase() !== languageCode.toLowerCase()
      ) {
        const lang = typeof r.language === "string" ? r.language : "";
        if (lang) sameNameDifferentLanguage.add(lang);
      }
    }

    const row = pickTemplateRow(rows, templateName, languageCode);
    if (row) return { row };

    after = extractPagingAfter(listRaw);
    if (!after) break;
  }

  const langHint =
    sameNameDifferentLanguage.size > 0
      ? Array.from(sameNameDifferentLanguage).sort()
      : undefined;
  log.warn(
    {
      phase: "listing_fallback_not_found",
      templateName,
      languageCode,
      totalRowsScanned,
      sameNameDifferentLanguage: langHint,
    },
    "[meta-flow-enrich] listing_fallback_not_found",
  );
  return {
    row: null,
    reason: {
      kind: "not_found",
      pagesScanned: Math.min(40, Math.ceil((totalRowsScanned || 1) / 200)),
      totalRowsScanned,
      sameNameDifferentLanguage: langHint,
    },
  };
}

function describeListingFailure(reason: ListingLookupResult["reason"]): string {
  if (!reason) return "listagem sem detalhes";
  if (reason.kind === "listing_throw") {
    return `listagem falhou na página ${reason.page}: ${reason.message}`;
  }
  const langHint = reason.sameNameDifferentLanguage
    ? ` — nome existe em outros idiomas: [${reason.sameNameDifferentLanguage.join(", ")}]`
    : "";
  return `listagem escaneou ${reason.totalRowsScanned} template(s) e não achou match${langHint}`;
}

/**
 * Resolve a linha do template (nome + idioma + components) via ID Graph
 * ou listagem paginada — evita falhar quando o template não está na primeira página.
 *
 * Ordem de tentativas quando `templateGraphId` está presente:
 *  1. `GET /{template_id}` (mais direto).
 *  2. Se (1) falhar/retornar vazio, cai pra `GET /{waba}/message_templates` paginado —
 *     necessário porque tokens que conseguem listar nem sempre conseguem GET individual
 *     (permissão granular diferente do lado da Meta).
 *  3. Só declara "template não existe" quando ambos falham.
 */
async function resolveTemplateDefinitionRow(
  client: MetaWhatsAppClient,
  args: {
    templateName: string;
    languageCode: string;
    templateGraphId?: string | null;
    strictFlowEnrich: boolean;
  },
): Promise<TemplateDefinitionResolution> {
  const gid = args.templateGraphId?.trim();
  if (gid) {
    let gidFailureMessage: string | undefined;
    let gidFailurePath:
      | "getMessageTemplateByGraphId_empty"
      | "getMessageTemplateByGraphId_error"
      | null = null;

    try {
      const raw = await client.getMessageTemplateByGraphId(gid);
      const o = asRecord(raw);
      if (o) {
        return {
          row: {
            name: typeof o.name === "string" ? o.name : args.templateName,
            language: typeof o.language === "string" ? o.language : args.languageCode,
            components: o.components,
          },
          resolutionPath: "getMessageTemplateByGraphId",
        };
      }
      gidFailurePath = "getMessageTemplateByGraphId_empty";
      gidFailureMessage = `GET message_template retornou corpo vazio para templateGraphId=${gid}`;
    } catch (e) {
      if (e instanceof MetaFlowEnrichError) throw e;
      gidFailurePath = "getMessageTemplateByGraphId_error";
      gidFailureMessage =
        e instanceof Error ? e.message : String(e);
    }

    log.warn(
      {
        phase: "gid_lookup_failed_falling_back_to_listing",
        templateGraphId: gid,
        reason: gidFailurePath,
        message: gidFailureMessage,
      },
      "[meta-flow-enrich] gid_lookup_failed_falling_back_to_listing",
    );

    const fallback = await findTemplateByListing(
      client,
      args.templateName,
      args.languageCode,
    );
    if (fallback.row) {
      return {
        row: fallback.row,
        resolutionPath: "listMessageTemplates_after_gid_failure",
      };
    }

    if (args.strictFlowEnrich) {
      throw new MetaFlowEnrichError(
        `[meta-flow-enrich] Falha ao obter template por ID Graph ${gid}` +
          (gidFailureMessage ? `: ${gidFailureMessage}` : "") +
          ` — e ${describeListingFailure(fallback.reason)}.`,
      );
    }
    return {
      row: null,
      resolutionPath: gidFailurePath ?? "getMessageTemplateByGraphId_error",
      gidFailureMessage,
    };
  }

  const result = await findTemplateByListing(
    client,
    args.templateName,
    args.languageCode,
  );
  return result.row
    ? { row: result.row, resolutionPath: "listMessageTemplates" }
    : { row: null, resolutionPath: "listMessageTemplates_none" };
}

export function buildFlowButtonComponent(
  index: string,
  flowToken: string,
  flowActionData?: Record<string, unknown> | null,
): Record<string, unknown> {
  const token = flowToken.trim();
  if (!token) {
    throw new MetaFlowEnrichError(
      "[meta-flow-enrich] flow_token vazio — use UUID por envio ou valor explícito.",
    );
  }
  const mergedActionData: Record<string, unknown> = {
    ...(flowActionData && typeof flowActionData === "object" && !Array.isArray(flowActionData)
      ? flowActionData
      : {}),
  };
  return {
    type: "button",
    sub_type: "flow",
    index,
    parameters: [
      {
        type: "action",
        action: {
          flow_token: token,
          flow_action_data: mergedActionData,
        },
      },
    ],
  };
}

export type EnrichTemplateFlowSendResult = {
  components: unknown[] | undefined;
  /** Token usado no componente Flow (UUID ou valor explícito). `null` se o template não tem botão Flow. */
  flowToken: string | null;
};

/**
 * Consulta a definição do template na Meta (por ID Graph ou listagem paginada),
 * localiza botão FLOW e acrescenta o componente exigido pela Cloud API.
 */
export async function enrichTemplateComponentsForFlowSend(
  client: MetaWhatsAppClient,
  args: {
    templateName: string;
    languageCode: string;
    components?: unknown[] | undefined;
    /** ID Graph do template (`meta_template_id` salvo em config / picker do inbox). */
    templateGraphId?: string | null;
    /** Token de correlação / sessão Flow; se omitido e o template tiver Flow, gera-se UUID v4. */
    flowToken?: string | null;
    /** Dados iniciais do fluxo; sempre fundidos em `flow_action_data` (objeto, possivelmente vazio). */
    flowActionData?: Record<string, unknown> | null;
    /**
     * Se true (default): falha se o template na Graph tiver botão Flow e o payload final
     * não incluir `button`/`sub_type: flow`; e se `templateGraphId` estiver definido,
     * falha ao não conseguir obter a definição por ID.
     */
    strictFlowEnrich?: boolean;
  },
): Promise<EnrichTemplateFlowSendResult> {
  const strictFlowEnrich = args.strictFlowEnrich !== false;
  const base =
    Array.isArray(args.components) && args.components.length > 0
      ? [...args.components]
      : [];

  log.info(
    {
      phase: "start",
      templateGraphId: args.templateGraphId ?? null,
      templateName: args.templateName,
      language: args.languageCode,
      inputPayloadAlreadyHasFlowButton: sendPayloadAlreadyHasFlowButton(base),
    },
    "[meta-flow-enrich] start",
  );

  if (sendPayloadAlreadyHasFlowButton(base)) {
    const existingTok = extractFlowTokenFromSendComponents(base);
    const out = base.length ? base : undefined;
    log.info(
      {
        phase: "final_components",
        reason: "input_already_has_flow_button",
        components: (out ?? []).length,
      },
      "[meta-flow-enrich] final_components",
    );
    return { components: out, flowToken: existingTok };
  }

  const resolved = await resolveTemplateDefinitionRow(client, {
    templateName: args.templateName,
    languageCode: args.languageCode,
    templateGraphId: args.templateGraphId ?? null,
    strictFlowEnrich,
  });
  const row = resolved.row;
  log.info(
    {
      phase: "after_resolve_definition",
      definitionFound: row != null,
      resolutionPath: resolved.resolutionPath,
    },
    "[meta-flow-enrich] after_resolve_definition",
  );

  const flowIndex = getFlowButtonIndexFromTemplateDefinition(row?.components);
  const inspectedButtons = collectFlatButtonsFromDefinitionComponents(row?.components);
  log.info(
    {
      phase: "after_flow_button_index",
      flowButtonIndex: flowIndex,
      ...(flowIndex == null ? { inspectedDefinitionButtons: inspectedButtons } : {}),
    },
    "[meta-flow-enrich] after_flow_button_index",
  );

  if (flowIndex == null) {
    const out = base.length ? base : undefined;
    log.info(
      {
        phase: "final_components",
        reason: "no_flow_button_in_definition",
        components: (out ?? []).length,
      },
      "[meta-flow-enrich] final_components",
    );
    return { components: out, flowToken: null };
  }

  const token =
    typeof args.flowToken === "string" && args.flowToken.trim().length > 0
      ? args.flowToken.trim()
      : randomUUID();

  const flowBtn = buildFlowButtonComponent(flowIndex, token, args.flowActionData ?? null);
  const merged = [...base, flowBtn];

  if (strictFlowEnrich && !sendPayloadAlreadyHasFlowButton(merged)) {
    throw new MetaFlowEnrichError(
      `[meta-flow-enrich] Template "${args.templateName}" define botão Flow (índice ${flowIndex}) mas o payload não contém componente button/flow após enriquecimento.`,
    );
  }

  log.info(
    { phase: "final_components", reason: "flow_button_appended", components: merged.length },
    "[meta-flow-enrich] final_components",
  );

  return { components: merged, flowToken: token };
}

/**
 * Resolve o `format` do componente HEADER da definição do template na Graph
 * (IMAGE/VIDEO/DOCUMENT) — usado por `send_whatsapp_template` para saber se
 * precisa exigir/injetar `headerMediaUrl` no envio (Meta erro `132012`
 * quando o header é de mídia e vem sem parâmetro).
 *
 * Reaproveita a mesma resolução de definição (GET por ID Graph com fallback
 * pra listagem) usada no enriquecimento de Flow. `strictFlowEnrich: false`
 * pois a ausência de definição aqui não deve lançar — o chamador decide
 * (ex.: cai pra `headerMediaType` explícito no config do passo).
 */
export async function resolveTemplateHeaderMediaFormat(
  client: MetaWhatsAppClient,
  args: {
    templateName: string;
    languageCode: string;
    templateGraphId?: string | null;
  },
): Promise<"IMAGE" | "VIDEO" | "DOCUMENT" | null> {
  const resolved = await resolveTemplateDefinitionRow(client, {
    templateName: args.templateName,
    languageCode: args.languageCode,
    templateGraphId: args.templateGraphId ?? null,
    strictFlowEnrich: false,
  });
  const analysis = analyzeTemplateComponents(
    (resolved.row?.components as unknown[] | undefined) ?? undefined,
  );
  return analysis.headerFormat === "IMAGE" ||
    analysis.headerFormat === "VIDEO" ||
    analysis.headerFormat === "DOCUMENT"
    ? analysis.headerFormat
    : null;
}
