/**
 * Gera o JSON estático de um WhatsApp Flow (Flow JSON v5) a partir do modelo
 * normalizado no CRM (telas + campos). Um único ecrã Meta com secções por tela.
 *
 * @see https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson/
 * @see https://developers.facebook.com/docs/whatsapp/flows/changelogs/
 */

/** Versão aceita para *publicar* (5.0 está frozen desde set/2025 — erro 139002). */
export const WA_FLOW_JSON_VERSION = "7.3";

export type CrmFlowFieldInput = {
  fieldKey: string;
  label: string;
  /** TEXT | EMAIL | PHONE | TEXTAREA | DROPDOWN | RADIO | MULTI_SELECT | DATE */
  fieldType: string;
  required: boolean;
  options?: string[];
};

export type CrmFlowScreenInput = {
  title: string;
  fields: CrmFlowFieldInput[];
};

function mapInputType(fieldType: string): "text" | "email" | "phone" {
  const t = fieldType.toUpperCase();
  if (t === "EMAIL") return "email";
  if (t === "PHONE") return "phone";
  return "text";
}

/** Nomes que a Meta rejeita ou que colidem com o Form / payload `${form.*}`. */
const RESERVED_FIELD_KEYS = new Set([
  "none",
  "form",
  "data",
  "success",
  "error",
  "error_message",
  "payload",
  "screen",
  "footer",
]);

export function sanitizeFlowFieldKey(raw: string, fallbackIndex = 1): string {
  let s = raw
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(s)) s = `c_${s}`;
  s = s.slice(0, 80);
  if (!s || RESERVED_FIELD_KEYS.has(s.toLowerCase())) return `campo_${fallbackIndex}`;
  return s;
}

/** Se a chave é reservada (ex.: none), usa o rótulo. */
export function resolveFlowFieldKey(fieldKey: string, label: string, fallbackIndex = 1): string {
  const raw = fieldKey.trim();
  const source = raw && !RESERVED_FIELD_KEYS.has(raw.toLowerCase()) ? raw : label;
  return sanitizeFlowFieldKey(source, fallbackIndex);
}

function slugOptionId(title: string, index: number): string {
  const s = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (s || `opt_${index + 1}`).slice(0, 40);
}

function buildDataSource(options?: string[]): { id: string; title: string }[] {
  const opts = (options ?? []).map((o) => o.trim()).filter(Boolean);
  if (opts.length === 0) {
    return [
      { id: "opcao_1", title: "Opção 1" },
      { id: "opcao_2", title: "Opção 2" },
    ];
  }
  const used = new Set<string>();
  return opts.map((title, i) => {
    let id = slugOptionId(title, i);
    if (used.has(id)) id = `${id}_${i + 1}`.slice(0, 40);
    used.add(id);
    return { id, title: title.slice(0, 80) };
  });
}

function buildFieldComponent(f: CrmFlowFieldInput, index: number): Record<string, unknown> {
  const key = resolveFlowFieldKey(f.fieldKey, f.label, index + 1);
  const label = f.label.trim().slice(0, 80) || key;
  const t = f.fieldType.toUpperCase();

  if (t === "TEXTAREA") {
    return { type: "TextArea", name: key, label, required: f.required };
  }
  if (t === "DROPDOWN" || t === "SELECT") {
    return {
      type: "Dropdown",
      name: key,
      label,
      required: f.required,
      "data-source": buildDataSource(f.options),
    };
  }
  if (t === "RADIO") {
    return {
      type: "RadioButtonsGroup",
      name: key,
      label,
      required: f.required,
      "data-source": buildDataSource(f.options),
    };
  }
  if (t === "MULTI_SELECT" || t === "CHECKBOX") {
    return {
      type: "CheckboxGroup",
      name: key,
      label,
      required: f.required,
      "data-source": buildDataSource(f.options),
    };
  }
  if (t === "DATE") {
    return { type: "DatePicker", name: key, label, required: f.required };
  }

  return {
    type: "TextInput",
    name: key,
    label,
    "input-type": mapInputType(f.fieldType),
    required: f.required,
  };
}

/**
 * Devolve o objeto Flow JSON (não stringificado) para inspeção/testes.
 */
export function buildWaFlowJsonObject(input: { screens: CrmFlowScreenInput[] }): Record<string, unknown> {
  let screens = input.screens.filter((s) => s.title.trim() || s.fields.length > 0);
  if (screens.length === 0) {
    screens = [
      {
        title: "Formulário",
        fields: [{ fieldKey: "nome", label: "Nome", fieldType: "TEXT", required: true }],
      },
    ];
  }

  const children: Record<string, unknown>[] = [];
  const formChildren: Record<string, unknown>[] = [];
  const payload: Record<string, string> = {};
  let fieldIndex = 0;
  for (const screen of screens) {
    if (screen.title.trim()) {
      children.push({ type: "TextHeading", text: screen.title.trim().slice(0, 80) });
    }
    for (const f of screen.fields) {
      const key = resolveFlowFieldKey(f.fieldKey, f.label, fieldIndex + 1);
      formChildren.push(buildFieldComponent(f, fieldIndex));
      payload[key] = `\${form.${key}}`;
      fieldIndex += 1;
    }
  }

  // `${form.x}` só é válido com um Form chamado `form`. Sem isto a Meta
  // devolve INVALID_ON_CLICK_ACTION_PAYLOAD e o publish falha.
  children.push({
    type: "Form",
    name: "form",
    children: formChildren.length
      ? formChildren
      : [{ type: "TextInput", name: "campo_1", label: "Campo", required: true, "input-type": "text" }],
  });

  children.push({
    type: "Footer",
    label: "Concluir",
    "on-click-action": {
      name: "complete",
      payload: Object.keys(payload).length ? payload : { campo_1: "${form.campo_1}" },
    },
  });

  const mainTitle = screens[0]?.title?.trim()?.slice(0, 60) || "Formulário";

  return {
    version: WA_FLOW_JSON_VERSION,
    screens: [
      {
        id: "MAIN",
        title: mainTitle,
        layout: {
          type: "SingleColumnLayout",
          children,
        },
        terminal: true,
        success: true,
      },
    ],
  };
}

/** String JSON a enviar em `flow_json` na API POST /{WABA-ID}/flows */
export function buildWaFlowJsonString(input: { screens: CrmFlowScreenInput[] }): string {
  return JSON.stringify(buildWaFlowJsonObject(input));
}
