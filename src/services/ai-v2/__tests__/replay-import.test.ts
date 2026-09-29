import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import { mediaKind, parseTranscript, transcriptTextFromFile, transcriptToRows } from "../replay-import";
import { extractReplayPoints } from "../replay-extract";

const ANDROID = `24/09/2026 13:18 - As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.
24/09/2026 13:19 - Cliente Um: Bom dia
24/09/2026 13:19 - Cliente Um: preciso da segunda via
do boleto deste mês
24/09/2026 13:21 - Ana Equipe: Bom dia! Você emite pela área do cliente, no menu Pagamentos.
24/09/2026 13:22 - Cliente Um: <Mídia oculta>
24/09/2026 13:23 - Ana Equipe: Esta mensagem foi apagada
24/09/2026 13:24 - Cliente Um: consegui, obrigado`;

const IOS = `[24/09/2026, 13:19:42] Cliente Dois: Oi, como altero meu e-mail?
[24/09/2026, 13:20:10] Equipe Suporte: Oi! Em Meus dados, clique em Editar e salve.
[24/09/2026, 13:20:30] Cliente Dois: ‎áudio ocultado`;

describe("parseTranscript", () => {
  it("lê exportação Android: junta linhas, ignora sistema e apagada, marca mídia", () => {
    const p = parseTranscript(ANDROID);
    expect(p.participants).toEqual([
      { name: "Cliente Um", messages: 4 },
      { name: "Ana Equipe", messages: 1 },
    ]);
    expect(p.messages[1].text).toBe("preciso da segunda via\ndo boleto deste mês");
    expect(p.messages[3]).toMatchObject({ media: "document", text: "" });
    expect(p.teamGuess).toEqual(["Ana Equipe"]);
    expect(p.messages[0].at?.getHours()).toBe(13);
  });

  it("lê exportação iOS com segundos e áudio", () => {
    const p = parseTranscript(IOS);
    expect(p.participants.map((x) => x.name)).toEqual(["Cliente Dois", "Equipe Suporte"]);
    expect(p.messages[2].media).toBe("audio");
    expect(p.messages[0].at?.getSeconds()).toBe(42);
  });

  it("lê texto colado 'Nome: mensagem' sem confundir rótulo dentro da mensagem", () => {
    const p = parseTranscript(`Cliente: quero mudar o plano
Atendente: Claro! Qual plano você quer?
Obs: prefiro o anual
Cliente: o anual
Atendente: Perfeito, já te passo o link.`);
    expect(p.participants.map((x) => x.name)).toEqual(["Cliente", "Atendente"]);
    expect(p.messages[1].text).toBe("Claro! Qual plano você quer?\nObs: prefiro o anual");
  });

  it("conversa sem mensagens reconhecíveis vem vazia", () => {
    expect(parseTranscript("só um texto qualquer sem autor").messages).toHaveLength(0);
  });
});

describe("mediaKind", () => {
  it("reconhece marcador de mídia e não confunde texto comum", () => {
    expect(mediaKind("<Mídia oculta>")).toBe("document");
    expect(mediaKind("imagem ocultada")).toBe("image");
    expect(mediaKind("PTT-20260924-WA0001.opus (arquivo anexado)")).toBe("audio");
    expect(mediaKind("o valor ficou oculto")).toBeNull();
    expect(mediaKind("Bom dia")).toBeNull();
  });
});

describe("transcriptToRows + extractReplayPoints", () => {
  it("equipe marcada vira resposta humana e gera pontos", () => {
    const rows = transcriptToRows(parseTranscript(ANDROID), ["Ana Equipe"]);
    expect(rows[0]).toMatchObject({ direction: "in", authorType: "contact" });
    expect(rows[2]).toMatchObject({ direction: "out", authorType: "human" });
    const pts = extractReplayPoints(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0].clientText).toContain("segunda via");
    expect(pts[0].humanText).toContain("área do cliente");
  });

  it("texto colado sem data mantém a ordem", () => {
    const rows = transcriptToRows(parseTranscript("Cliente: a\nCliente: b\nEquipe: c resposta com conteúdo suficiente\nCliente: d"), ["Equipe"]);
    const times = rows.map((r) => r.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("transcriptTextFromFile", () => {
  it("abre o .zip da exportação e pega o _chat.txt", () => {
    const zip = zipSync({ "_chat.txt": strToU8(IOS), "IMG-0001.jpg": new Uint8Array([1, 2, 3]) });
    expect(transcriptTextFromFile("conversa.zip", zip)).toContain("Cliente Dois");
  });
  it("zip sem conversa dá erro claro", () => {
    const zip = zipSync({ "IMG-0001.jpg": new Uint8Array([1]) });
    expect(() => transcriptTextFromFile("x.zip", zip)).toThrow(/conversa/);
  });
});
