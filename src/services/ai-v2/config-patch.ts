/**
 * Alterações pontuais na configuração do agente, no formato que a revisão
 * com IA devolve: caminho + operação. O caminho usa pontos e seletores:
 *   "fallback.noSource.message"
 *   "themes[id=t1].when"                    (item de lista pelo id)
 *   "rules[id=r1].conditions[0].values"     (item pela posição)
 * Operações: "set" (troca o valor), "add" (acrescenta a uma lista, sem
 * repetir), "remove" (tira da lista o valor; sem valor, tira o item
 * selecionado no fim do caminho). Nada é aplicado sem validar a config.
 * Nenhum domínio de cliente.
 */

export type V2ConfigChange = { path: string; op: "set" | "add" | "remove"; value?: unknown };

/**
 * Campos de publicação: quem atende (números de teste, canais), o modelo e a
 * autonomia. Sugestão automática (revisão com IA, escuta da equipe) nunca
 * mexe neles — tirar os números de teste fazia o agente atender todo mundo.
 */
export const PROTECTED_CONFIG_PATHS = ["allowedPhoneNumbers", "channelIds", "model", "autonomyMode"];

/** A alteração toca um campo de publicação. */
export function touchesProtectedPath(path: string): boolean {
  const head = path.trim().split(/[.[]/)[0];
  return PROTECTED_CONFIG_PATHS.includes(head);
}

/** Nomes que levariam ao protótipo dos objetos: nunca aceitos num caminho. */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Um passo do caminho: chave de objeto ou item de lista. */
type Step = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "match"; field: string; equals: string };

export function parseConfigPath(path: string): Step[] {
  const steps: Step[] = [];
  for (const raw of path.split(".")) {
    const m = /^([A-Za-z_][\w-]*)((?:\[[^\]]+\])*)$/.exec(raw.trim());
    if (!m || FORBIDDEN_KEYS.has(m[1])) throw new Error(`Caminho inválido: ${path}`);
    steps.push({ kind: "key", key: m[1] });
    for (const s of m[2].matchAll(/\[([^\]]+)\]/g)) {
      const inner = s[1].trim();
      if (/^\d+$/.test(inner)) steps.push({ kind: "index", index: Number(inner) });
      else {
        const eq = /^([\w-]+)=(.+)$/.exec(inner);
        if (!eq || FORBIDDEN_KEYS.has(eq[1])) throw new Error(`Seletor inválido: [${inner}]`);
        steps.push({ kind: "match", field: eq[1], equals: eq[2].replace(/^["']|["']$/g, "") });
      }
    }
  }
  if (steps.length === 0) throw new Error(`Caminho vazio`);
  return steps;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Chave concreta do passo dentro do contêiner atual. */
function resolve(container: unknown, step: Step, path: string): string | number {
  if (step.kind === "key") {
    if (!container || typeof container !== "object" || Array.isArray(container)) throw new Error(`Não é um objeto: ${path}`);
    return step.key;
  }
  if (!Array.isArray(container)) throw new Error(`Não é uma lista: ${path}`);
  const index = step.kind === "index"
    ? step.index
    : container.findIndex((it) => it && typeof it === "object" && String((it as Record<string, unknown>)[step.field]) === step.equals);
  if (index < 0 || index >= container.length) throw new Error(`Item não encontrado: ${path}`);
  return index;
}

/** Valor atual no caminho (para mostrar "de → para"). Caminho inexistente: undefined. */
export function getAtPath(config: unknown, path: string): unknown {
  try {
    let cur: unknown = config;
    for (const step of parseConfigPath(path)) {
      if (cur === undefined || cur === null) return undefined;
      cur = (cur as Record<string | number, unknown>)[resolve(cur, step, path)];
    }
    return cur;
  } catch {
    return undefined;
  }
}

function applyOne(root: unknown, ch: V2ConfigChange): void {
  const steps = parseConfigPath(ch.path);
  let cur: unknown = root;
  // Anda até o contêiner do último passo, criando objetos que faltam.
  for (let i = 0; i < steps.length - 1; i++) {
    const key = resolve(cur, steps[i], ch.path);
    const holder = cur as Record<string | number, unknown>;
    if (!Object.hasOwn(holder, key) || holder[key] === undefined || holder[key] === null) {
      if (steps[i + 1].kind !== "key") throw new Error(`Lista não existe: ${ch.path}`);
      holder[key] = {};
    }
    cur = holder[key];
  }
  const last = steps[steps.length - 1];
  const key = resolve(cur, last, ch.path);
  const holder = cur as Record<string | number, unknown>;
  if (ch.op === "set") {
    holder[key] = ch.value;
    return;
  }
  if (ch.op === "remove" && ch.value === undefined) {
    if (last.kind === "key" || !Array.isArray(cur)) throw new Error(`“remove” sem valor exige um item selecionado: ${ch.path}`);
    (cur as unknown[]).splice(key as number, 1);
    return;
  }
  const items = Array.isArray(ch.value) ? ch.value : [ch.value];
  if (ch.op === "add") {
    const list = holder[key] ?? [];
    if (!Array.isArray(list)) throw new Error(`“add” exige uma lista: ${ch.path}`);
    for (const it of items) if (!list.some((x) => same(x, it))) list.push(it);
    holder[key] = list;
    return;
  }
  if (ch.op === "remove") {
    const list = holder[key];
    if (!Array.isArray(list)) throw new Error(`“remove” exige uma lista: ${ch.path}`);
    holder[key] = list.filter((x) => !items.some((it) => same(x, it)));
    return;
  }
  throw new Error(`Operação inválida: ${String((ch as { op?: unknown }).op)}`);
}

/** Aplica as alterações numa cópia. Erro em qualquer uma: exceção, nada muda. */
export function applyConfigChanges<T>(config: T, changes: V2ConfigChange[]): T {
  const out = structuredClone(config);
  for (const ch of changes) applyOne(out, ch);
  return out;
}
