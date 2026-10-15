/**
 * Conta de e-mail do passo `send_email`.
 *
 * Sintoma (DNA Work, out/26): a conta conectada em /email não aparecia no
 * picker "Canais" do passo e o motor ignorava o envio (log "OK" sem
 * e-mail). O picker agora grava `EmailAccount.id` no mesmo contrato dos
 * canais WhatsApp (`channelScope`/`channelIds`/`channelId`) e o motor
 * resolve a conta a partir dele.
 */
import { describe, expect, it } from "vitest";

import { isStepIncomplete, readSendEmailAccountIds } from "../automation-workflow";

const DOCUMENTOS = "acc_documentos";
const FINANCEIRO = "acc_financeiro";

describe("readSendEmailAccountIds", () => {
  it("conta marcada no picker (scope selected) vem na ordem marcada", () => {
    expect(
      readSendEmailAccountIds({
        channelScope: "selected",
        channelIds: [FINANCEIRO, DOCUMENTOS],
        channelId: "",
      }),
    ).toEqual([FINANCEIRO, DOCUMENTOS]);
  });

  it("'Selecionar tudo' = vazio (motor escolhe a conta da org)", () => {
    expect(
      readSendEmailAccountIds({ channelScope: "all", channelIds: [], channelId: "" }),
    ).toEqual([]);
  });

  it("uma conta selecionada vira channelId sem duplicar", () => {
    expect(
      readSendEmailAccountIds({
        channelScope: "selected",
        channelIds: [DOCUMENTOS],
        channelId: DOCUMENTOS,
      }),
    ).toEqual([DOCUMENTOS]);
  });

  it("channelId legado e accountId explícito entram como fallback", () => {
    expect(readSendEmailAccountIds({ channelId: DOCUMENTOS })).toEqual([DOCUMENTOS]);
    expect(readSendEmailAccountIds({ accountId: FINANCEIRO })).toEqual([FINANCEIRO]);
  });

  it("descarta ids de mockup do editor sem conta conectada", () => {
    expect(
      readSendEmailAccountIds({
        channelScope: "selected",
        channelIds: ["mock-email-noreply", DOCUMENTOS],
      }),
    ).toEqual([DOCUMENTOS]);
  });

  it("config ausente ou inválida = vazio", () => {
    expect(readSendEmailAccountIds(undefined)).toEqual([]);
    expect(readSendEmailAccountIds({ channelIds: "x" })).toEqual([]);
  });
});

describe("isStepIncomplete(send_email)", () => {
  it("'Para' vazio não marca o passo como incompleto — cai no e-mail do contato", () => {
    expect(isStepIncomplete("send_email", { to: "", subject: "Olá", body: "Segue." })).toBe(false);
  });

  it("assunto ou corpo vazios marcam incompleto", () => {
    expect(isStepIncomplete("send_email", { to: "", subject: "", body: "Segue." })).toBe(true);
    expect(isStepIncomplete("send_email", { to: "", subject: "Olá", body: "" })).toBe(true);
  });
});
