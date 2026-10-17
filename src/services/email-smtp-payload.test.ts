/**
 * services/email-smtp-payload — envelope do envio pelas contas conectadas:
 * From com nome de exibição, Content-Language e <html lang> garantido.
 */
import { describe, expect, it } from "vitest";

import { buildSmtpMailPayload, ensureHtmlLang } from "./email-smtp-payload";

const sender = { email: "marcelo@eduit.com.br" };

describe("buildSmtpMailPayload", () => {
  it("From com nome de exibição quando a conta tem dono", () => {
    const p = buildSmtpMailPayload(
      { ...sender, fromName: " Marcelo Pinheiro\n" },
      { to: "x@y.com", subject: "Oi", text: "Olá" },
    );
    expect(p.from).toEqual({ name: "Marcelo Pinheiro", address: "marcelo@eduit.com.br" });
  });

  it("From só com o endereço quando não há nome (ou nome vazio)", () => {
    expect(buildSmtpMailPayload(sender, { to: "x@y.com", subject: "s", text: "t" }).from).toBe(sender.email);
    expect(buildSmtpMailPayload({ ...sender, fromName: "   " }, { to: "x@y.com", subject: "s", text: "t" }).from).toBe(
      sender.email,
    );
  });

  it("declara Content-Language pt-BR", () => {
    const p = buildSmtpMailPayload(sender, { to: "x@y.com", subject: "s", text: "t" });
    expect(p.headers["Content-Language"]).toBe("pt-BR");
  });

  it("fragmento HTML vira documento com lang; texto derivado do HTML", () => {
    const p = buildSmtpMailPayload(sender, { to: "x@y.com", subject: "s", html: "<p>Olá <b>mundo</b></p>" });
    expect(p.html).toBe('<!DOCTYPE html><html lang="pt-BR"><body><p>Olá <b>mundo</b></p></body></html>');
    expect(p.text).toBe("Olá mundo");
  });

  it("HTML em branco é descartado e o texto vira um espaço", () => {
    const p = buildSmtpMailPayload(sender, { to: "x@y.com", subject: "s", html: "<p>&nbsp;</p>" });
    expect(p.html).toBeUndefined();
    expect(p.text).toBe(" ");
  });

  it("inReplyTo ganha <> e vai também em references", () => {
    const p = buildSmtpMailPayload(sender, { to: "x@y.com", subject: "s", text: "t", inReplyTo: "abc@host" });
    expect(p.inReplyTo).toBe("<abc@host>");
    expect(p.references).toBe("<abc@host>");
    expect(buildSmtpMailPayload(sender, { to: "x@y.com", subject: "s", text: "t" }).inReplyTo).toBeUndefined();
  });
});

describe("ensureHtmlLang", () => {
  it("injeta lang em <html> sem lang", () => {
    expect(ensureHtmlLang("<html><body>x</body></html>")).toBe('<html lang="pt-BR"><body>x</body></html>');
    expect(ensureHtmlLang('<HTML dir="ltr"><body>x</body></HTML>')).toBe('<HTML lang="pt-BR" dir="ltr"><body>x</body></HTML>');
  });

  it("respeita lang já declarado pelo autor", () => {
    const doc = '<html lang="en"><body>x</body></html>';
    expect(ensureHtmlLang(doc)).toBe(doc);
  });
});
