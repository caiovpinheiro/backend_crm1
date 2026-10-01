/**
 * Timers dos sweepers de fundo (presença, agendadas, outbox etc.).
 *
 * Os sweepers agendam ticks com setTimeout/setInterval e não guardavam o
 * handle — no SIGTERM não havia como parar o ciclo. Agendando por aqui, o
 * shutdown do processo chama `stopBackgroundTimers()`: limpa o que está
 * pendente e recusa agendamentos novos (o encadeamento `setTimeout(tick)`
 * do fim de um tick em andamento simplesmente não acontece).
 *
 * Um tick que já começou não é interrompido; termina ou morre no exit.
 */

type Handle = ReturnType<typeof setTimeout>;

const handles = new Set<Handle>();
let stopped = false;

/** setTimeout rastreado. Depois do stop não agenda (retorna null). */
export function scheduleBackgroundTimeout(
  fn: () => void,
  ms: number,
): Handle | null {
  if (stopped) return null;
  const h = setTimeout(() => {
    handles.delete(h);
    if (stopped) return;
    fn();
  }, ms);
  handles.add(h);
  return h;
}

/** setInterval rastreado. Depois do stop não agenda (retorna null). */
export function scheduleBackgroundInterval(
  fn: () => void,
  ms: number,
): Handle | null {
  if (stopped) return null;
  const h = setInterval(() => {
    if (stopped) return;
    fn();
  }, ms);
  handles.add(h);
  return h;
}

/** Para todos os timers rastreados e bloqueia novos. Idempotente. */
export function stopBackgroundTimers(): number {
  stopped = true;
  const n = handles.size;
  for (const h of handles) {
    clearTimeout(h);
    clearInterval(h);
  }
  handles.clear();
  return n;
}

export function backgroundTimersStopped(): boolean {
  return stopped;
}

/** Só para testes. */
export function resetBackgroundTimersForTests(): void {
  stopBackgroundTimers();
  stopped = false;
}
