/**
 * Emulação dos scripts Lua de `lib/cache/message-versions.ts`
 * (`-- crm:msgs-bump` e `-- crm:msgs-state`) para os Redis falsos dos
 * testes. O ZSET do diário mora num `Map` à parte (os fakes só guardam
 * texto); a versão usa o armazenamento de texto do fake, como o `INCR`.
 *
 * Uso: `const emu = fakeMsgsScripts({ get, set })` e, no `eval` do fake,
 * `const out = emu.eval(script, numKeys, rest); if (out !== undefined) return out;`.
 */
export type TextStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type FakeMsgsScripts = {
  /** `undefined` = script que não é deste módulo (o fake segue o dele). */
  eval(script: string, numKeys: number, rest: string[]): unknown;
  /** Membros do diário (ordem de score) — para afirmar nos testes. */
  log(key: string): string[];
  reset(): void;
};

export function fakeMsgsScripts(store: TextStore): FakeMsgsScripts {
  const zsets = new Map<string, Array<[number, string]>>();

  function zadd(key: string, score: number, member: string): void {
    const list = (zsets.get(key) ?? []).filter(([, m]) => m !== member);
    list.push([score, member]);
    list.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    zsets.set(key, list);
  }

  function trim(key: string, max: number): void {
    const list = zsets.get(key) ?? [];
    if (list.length > max) zsets.set(key, list.slice(list.length - max));
  }

  function bump(keys: string[], args: string[]): number {
    const [ver, log] = keys as [string, string];
    const [seed, , suffix, max, by] = args as [string, string, string, string, string];
    if (store.get(ver) === null) {
      store.set(ver, seed);
      zadd(log, Number(seed), `${seed}:seed`);
    }
    const v = Number(store.get(ver)) + Number(by);
    store.set(ver, String(v));
    zadd(log, v, `${v}:${suffix}`);
    trim(log, Number(max));
    return v;
  }

  function state(keys: string[], args: string[]): unknown[] {
    const nfam = Number(args[0]);
    const seed = args[1]!;
    const limit = Number(args[3]);
    const fams = keys.slice(0, nfam).map((k) => store.get(k) ?? "");
    const out: unknown[] = [fams];
    let c = 0;
    for (let i = nfam; i < keys.length; i += 2) {
      c++;
      const ver = keys[i]!;
      const log = keys[i + 1]!;
      let cur = store.get(ver);
      if (cur === null) {
        store.set(ver, seed);
        zadd(log, Number(seed), `${seed}:seed`);
        cur = seed;
      }
      const cursor = args[3 + c] ?? "";
      let first = "";
      let items: string[] = [];
      if (cursor !== "" && Number(cur) > Number(cursor)) {
        const list = zsets.get(log) ?? [];
        first = list[0]?.[1] ?? "";
        items = list
          .filter(([score]) => score > Number(cursor))
          .slice(0, limit + 1)
          .map(([, m]) => m);
      }
      out.push([cur, first, items]);
    }
    return out;
  }

  return {
    eval(script, numKeys, rest) {
      const marker = /--\s*crm:([\w-]+)/.exec(script)?.[1];
      const keys = rest.slice(0, numKeys);
      const args = rest.slice(numKeys);
      if (marker === "msgs-bump") return bump(keys, args);
      if (marker === "msgs-state") return state(keys, args);
      return undefined;
    },
    log(key) {
      return (zsets.get(key) ?? []).map(([, m]) => m);
    },
    reset() {
      zsets.clear();
    },
  };
}
