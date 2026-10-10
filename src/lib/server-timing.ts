/**
 * Tempos por fase de uma requisição, para o cabeçalho `Server-Timing` e
 * para o log estruturado. Sem dependência e sem custo relevante: um
 * `performance.now()` por fase.
 *
 *   const timing = new ServerTiming();
 *   const rows = await timing.time("db", () => prisma.x.findMany(...));
 *   res.headers.set("Server-Timing", timing.header());
 *
 * Fase repetida soma (ex.: duas idas ao Redis em `cache`). `total` é medido
 * desde a criação do objeto (ou desde `startedAt`, quando informado).
 */
export class ServerTiming {
  private readonly startedAt: number;
  private readonly phases = new Map<string, { ms: number; desc?: string }>();

  constructor(startedAt: number = performance.now()) {
    this.startedAt = startedAt;
  }

  /** Soma `ms` à fase `name`. `desc` substitui a descrição anterior. */
  add(name: string, ms: number, desc?: string): void {
    const prev = this.phases.get(name);
    this.phases.set(name, {
      ms: (prev?.ms ?? 0) + Math.max(0, ms),
      desc: desc ?? prev?.desc,
    });
  }

  /** Marca só a descrição (ex.: `cache` = hit/miss), sem tempo. */
  describe(name: string, desc: string): void {
    const prev = this.phases.get(name);
    this.phases.set(name, { ms: prev?.ms ?? 0, desc });
  }

  /** Mede `fn` como a fase `name` (também quando lança). */
  async time<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }

  /** Versão síncrona de `time`. */
  timeSync<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }

  /**
   * Fase `cache` com o resultado do cache. Um relatório: `hit`/`miss`/`stale`.
   * Vários blocos (um cache por bloco): o status único quando todos iguais, senão
   * `bloco=status bloco=status`. `ms` (tempo de espera pelo cache) soma na fase.
   */
  describeCache(statuses: ReadonlyMap<string, string>, ms = 0): void {
    if (statuses.size === 0) return;
    const values = new Set(statuses.values());
    const desc =
      values.size === 1
        ? [...values][0]
        : [...statuses].map(([block, status]) => `${block}=${status}`).join(" ");
    this.add("cache", ms, desc);
  }

  totalMs(): number {
    return performance.now() - this.startedAt;
  }

  /** Fases em ms (1 casa), para o log. */
  toJSON(): Record<string, number | string> {
    const out: Record<string, number | string> = {};
    for (const [name, p] of this.phases) {
      out[name] = Math.round(p.ms * 10) / 10;
      if (p.desc) out[`${name}Desc`] = p.desc;
    }
    out.total = Math.round(this.totalMs() * 10) / 10;
    return out;
  }

  /** Valor do cabeçalho `Server-Timing` (nomes e descrições ASCII). */
  header(): string {
    const parts: string[] = [];
    for (const [name, p] of this.phases) {
      const desc = p.desc ? `;desc="${p.desc.replace(/["\\]/g, "")}"` : "";
      parts.push(`${name};dur=${p.ms.toFixed(1)}${desc}`);
    }
    parts.push(`total;dur=${this.totalMs().toFixed(1)}`);
    return parts.join(", ");
  }
}
