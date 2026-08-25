/**
 * Metadados das variáveis de corpo/cabeçalho que o operador preenche no envio
 * (alinhado a `WhatsAppTemplateConfig.operatorVariables`).
 */

export type OperatorVariableMeta = {
  key: string;
  label: string;
  example?: string;
};

/**
 * A Meta só promove a parâmetro o marcador posicional (`{{1}}`) ou o nomeado
 * simples — minúsculas, dígitos e underscore (`{{nome_curso}}`). Qualquer
 * outra coisa entre chaves (ponto, maiúscula, hífen, espaço) é texto literal
 * do corpo aprovado: o template conta como SEM parâmetros e mandar
 * `components` para ele devolve 132000.
 */
export function isMetaPlaceholderKey(key: string): boolean {
  return /^[a-z0-9_]+$/.test(key);
}

/** Extrai chaves únicas na ordem de aparição: `{{1}}`, `{{nome}}`, etc. */
export function extractPlaceholderKeysFromBodyText(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const re = /\{\{([^}]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const k = m[1].trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
}

/** Só as chaves que a Meta realmente aceita como parâmetro. */
export function extractMetaPlaceholderKeys(text: string): string[] {
  return extractPlaceholderKeysFromBodyText(text).filter(isMetaPlaceholderKey);
}

/**
 * O contrário: os tokens entre chaves que a Meta ignora. Serve para avisar o
 * operador de que o corpo aprovado tem marcador que nunca vira parâmetro.
 */
export function extractUnsupportedPlaceholderTokens(text: string): string[] {
  return extractPlaceholderKeysFromBodyText(text).filter((k) => !isMetaPlaceholderKey(k));
}

/** Preserva labels/exemplos já gravados quando as chaves continuam iguais. */
export function mergeOperatorVariables(
  bodyText: string,
  previous: OperatorVariableMeta[] | null | undefined,
): OperatorVariableMeta[] {
  const keys = extractPlaceholderKeysFromBodyText(bodyText);
  const prevByKey = new Map((previous ?? []).map((v) => [v.key, v]));
  return keys.map((key) => {
    const old = prevByKey.get(key);
    const ex = old?.example?.trim();
    return {
      key,
      label: old?.label?.trim() || key,
      ...(ex ? { example: ex } : {}),
    };
  });
}
