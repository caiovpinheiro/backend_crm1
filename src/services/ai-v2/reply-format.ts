/**
 * Ajustes de forma na resposta ao cliente. Nenhum domínio de cliente.
 */

/**
 * Passo a passo escrito numa linha só ("Siga: 1. Acesse… 2. Clique… 3. …")
 * vira uma linha por passo. Só age numa sequência 1, 2, 3… (2+ passos) que
 * não está no início de linha; número solto no texto ("6 a 9. Depois") não
 * forma sequência e fica como está.
 */
export function breakInlineSteps(text: string): string {
  const markers: Array<{ index: number; n: number; lineStart: boolean }> = [];
  const re = /(^|[\s:;,])(\d{1,2})\.\s+(?=\S)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const index = m.index + m[1].length;
    const before = text.slice(0, index);
    markers.push({ index, n: Number(m[2]), lineStart: before === "" || /\n\s*$/.test(before) });
  }
  // Sequência que começa em 1 e sobe de 1 em 1.
  let best: typeof markers = [];
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].n !== 1) continue;
    const run = [markers[i]];
    for (let j = i + 1; j < markers.length && run.length < 30; j++) {
      if (markers[j].n === run[run.length - 1].n + 1) run.push(markers[j]);
    }
    if (run.length > best.length) best = run;
  }
  if (best.length < 2 || best.every((x) => x.lineStart)) return text;

  let out = text;
  // De trás para frente, para os índices continuarem valendo.
  for (const marker of [...best].reverse()) {
    if (marker.lineStart) continue;
    const head = out.slice(0, marker.index).replace(/[ \t]+$/, "");
    out = `${head}\n${out.slice(marker.index)}`;
  }
  return out;
}
