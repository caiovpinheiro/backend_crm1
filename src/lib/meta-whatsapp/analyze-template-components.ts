import { isFlowDefinitionButton } from "@/lib/meta-whatsapp/is-flow-definition-button";

export type TemplateButton = {
  /** QUICK_REPLY | URL | PHONE_NUMBER | FLOW | COPY_CODE ... */
  type: string;
  /** Rótulo visível do botão (ex.: "Quero"). */
  text: string;
  /** URL (só para botões URL). */
  url: string | null;
};

export type TemplateComponentsAnalysis = {
  hasButtons: boolean;
  /** Tipos distintos de botão (ex.: FLOW, URL, QUICK_REPLY), ordenados. */
  buttonTypes: string[];
  /** Botões na ordem em que aparecem no template, com rótulo. */
  buttons: TemplateButton[];
  /** Texto do componente BODY (para preview). */
  bodyText: string | null;
  /** Texto do componente HEADER quando `format = TEXT` (pode ter placeholders). */
  headerText: string | null;
  /** Texto do componente FOOTER. */
  footerText: string | null;
  hasVariables: boolean;
  flowAction: string | null;
  flowId: string | null;
  /** `format` do componente HEADER (Graph). `null` quando o template não tem header. */
  headerFormat: "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Detecta placeholders `{{1}}`, `{{nome}}`, etc. */
function textHasVariablePlaceholders(text: string): boolean {
  return /\{\{[^}]+\}\}/.test(text);
}

/**
 * Analisa o array `components` retornado pela Graph API (`message_templates`)
 * e metadados opcionais do template (ex.: `parameter_format` no nível raiz).
 */
export function analyzeTemplateComponents(
  components: unknown[] | null | undefined,
  options?: { parameterFormat?: string | null },
): TemplateComponentsAnalysis {
  const buttonTypesSet = new Set<string>();
  const buttons: TemplateButton[] = [];
  let bodyText: string | null = null;
  let headerText: string | null = null;
  let footerText: string | null = null;
  let hasVariables = false;
  let flowAction: string | null = null;
  let flowId: string | null = null;
  let headerFormat: TemplateComponentsAnalysis["headerFormat"] = null;

  if (options?.parameterFormat?.trim().toUpperCase() === "NAMED") {
    hasVariables = true;
  }

  if (!Array.isArray(components)) {
    return {
      hasButtons: false,
      buttonTypes: [],
      buttons: [],
      bodyText: null,
      headerText: null,
      footerText: null,
      hasVariables,
      flowAction: null,
      flowId: null,
      headerFormat: null,
    };
  }

  for (const c of components) {
    const comp = asRecord(c);
    if (!comp) continue;
    const type = String(comp.type ?? "").toUpperCase();

    if (type === "FOOTER") {
      const footer = typeof comp.text === "string" ? comp.text : "";
      if (footer) footerText = footer;
    }

    if (type === "BODY" || type === "HEADER") {
      const text = typeof comp.text === "string" ? comp.text : "";
      if (type === "BODY" && text) bodyText = text;
      if (type === "HEADER" && text) headerText = text;
      if (textHasVariablePlaceholders(text)) hasVariables = true;
      const pf = String(comp.parameter_format ?? comp.parameterFormat ?? "").toUpperCase();
      if (pf === "NAMED") hasVariables = true;

      if (type === "HEADER") {
        const format = String(comp.format ?? "").toUpperCase();
        if (format === "TEXT" || format === "IMAGE" || format === "VIDEO" || format === "DOCUMENT") {
          headerFormat = format;
        } else if (text) {
          headerFormat = "TEXT";
        } else {
          headerFormat = "NONE";
        }
      }
    }

    if (type === "BUTTONS" && Array.isArray(comp.buttons)) {
      for (const b of comp.buttons) {
        const btn = asRecord(b);
        if (!btn) continue;
        const rawType = String(btn.type ?? "").toUpperCase();
        const label = typeof btn.text === "string" ? btn.text : "";
        const url = typeof btn.url === "string" ? btn.url : null;
        if (isFlowDefinitionButton(btn)) {
          buttonTypesSet.add("FLOW");
          buttons.push({ type: "FLOW", text: label, url: null });
          if (flowAction == null) {
            const fa = btn.flow_action ?? btn.flowAction;
            if (typeof fa === "string" && fa.trim()) flowAction = fa.trim();
          }
          if (flowId == null) {
            const fid = btn.flow_id ?? btn.flowId;
            if (fid != null && String(fid).trim()) flowId = String(fid);
          }
        } else if (rawType) {
          buttonTypesSet.add(rawType);
          buttons.push({ type: rawType, text: label, url });
          // URL dinâmica (`https://x/{{1}}`): o sufixo é parâmetro do envio.
          if (rawType === "URL" && url && textHasVariablePlaceholders(url)) hasVariables = true;
        }
      }
    }
  }

  const buttonTypes = Array.from(buttonTypesSet).sort();
  return {
    hasButtons: buttonTypes.length > 0,
    buttonTypes,
    buttons,
    bodyText,
    headerText,
    footerText,
    hasVariables,
    flowAction,
    flowId,
    headerFormat,
  };
}
