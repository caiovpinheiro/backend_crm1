import { describe, expect, it } from "vitest";

import { redactNewMessageForUnlisted } from "@/lib/sse-redact";
import {
  formatSharedContactsText,
  parseBaileysSharedContacts,
  parseMetaSharedContacts,
  parseVcard,
  sharedContactsFromJson,
} from "@/lib/shared-contact";

const joao = {
  name: {
    formatted_name: "João Silva",
    first_name: "João",
    last_name: "Silva",
  },
  phones: [{ phone: "+55 11 99999-9999", wa_id: "5511999999999", type: "CELL" }],
};

describe("contatos compartilhados da Meta", () => {
  it("1 contato com nome e telefone", () => {
    const contacts = parseMetaSharedContacts([joao]);
    expect(contacts).toEqual([
      {
        name: "João Silva",
        firstName: "João",
        lastName: "Silva",
        phones: [{ phone: "+55 11 99999-9999", waId: "5511999999999", type: "CELL" }],
        emails: [],
        company: null,
        title: null,
      },
    ]);
    expect(formatSharedContactsText(contacts)).toBe(
      "Contato compartilhado: João Silva · +55 11 99999-9999",
    );
  });

  it("vários telefones", () => {
    const contacts = parseMetaSharedContacts([
      {
        name: { formatted_name: "João Silva" },
        phones: [
          { phone: "+55 11 99999-9999", type: "CELL" },
          { phone: "+55 11 3333-3333", type: "HOME" },
        ],
      },
    ]);
    expect(contacts[0]?.phones).toHaveLength(2);
  });

  it("telefone sem nome usa o número", () => {
    const contacts = parseMetaSharedContacts([
      { phones: [{ phone: "+55 11 99999-9999" }] },
    ]);
    expect(contacts[0]?.name).toBe("+55 11 99999-9999");
  });

  it("vários contatos na mesma mensagem", () => {
    const contacts = parseMetaSharedContacts([
      joao,
      { name: { first_name: "Maria", last_name: "Souza" }, phones: [{ phone: "+55 11 88888-8888" }] },
    ]);
    expect(contacts).toHaveLength(2);
    expect(formatSharedContactsText(contacts)).toBe(
      "Contatos compartilhados: João Silva, Maria Souza",
    );
  });

  it("nome, telefone, email e empresa", () => {
    const contacts = parseMetaSharedContacts([
      {
        name: { first_name: "João", middle_name: "P", last_name: "Silva" },
        phones: [{ phone: "+55 11 99999-9999", wa_id: "5511999999999", type: "CELL" }],
        emails: [{ email: "joao@empresa.com", type: "WORK" }],
        org: { company: "Empresa X", title: "Comercial" },
      },
    ]);
    expect(contacts[0]).toMatchObject({
      name: "João P Silva",
      emails: [{ email: "joao@empresa.com", type: "WORK" }],
      company: "Empresa X",
      title: "Comercial",
    });
  });

  it("item inválido não derruba o restante", () => {
    const contacts = parseMetaSharedContacts([null, "lixo", joao, { emails: [{ email: "sem-arroba" }] }]);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.name).toBe("João Silva");
  });
});

const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Silva;João;;;",
  "FN:João Silva",
  "TEL;type=CELL;waid=5511999999999:+55 11 99999-9999",
  "TEL;type=HOME:+55 11 3333-3333",
  "EMAIL;type=WORK:joao@empresa.com",
  "ORG:Empresa X",
  "TITLE:Comercial",
  "END:VCARD",
].join("\n");

describe("vCard do Baileys", () => {
  it("contactMessage", () => {
    const contacts = parseBaileysSharedContacts({
      displayName: "João Silva",
      vcard: VCARD,
    });
    expect(contacts[0]).toMatchObject({
      name: "João Silva",
      firstName: "João",
      lastName: "Silva",
      company: "Empresa X",
      title: "Comercial",
    });
    expect(contacts[0]?.phones.map((phone) => phone.phone)).toEqual([
      "+55 11 99999-9999",
      "+55 11 3333-3333",
    ]);
  });

  it("contactsArrayMessage com dois vCards", () => {
    const contacts = parseBaileysSharedContacts({
      displayName: "João e Maria",
      contacts: [
        { displayName: "João Silva", vcard: VCARD },
        {
          displayName: "Maria Souza",
          vcard: "BEGIN:VCARD\nFN:Maria Souza\nTEL:+55 11 88888-8888\nEND:VCARD",
        },
      ],
    });
    expect(contacts.map((contact) => contact.name)).toEqual(["João Silva", "Maria Souza"]);
  });

  it("vCard malformado não lança", () => {
    expect(() => parseVcard("isto não é vcard")).not.toThrow();
    expect(parseVcard("::::")).toBeNull();
    expect(parseBaileysSharedContacts({ displayName: "João", vcard: "lixo" })[0]?.name).toBe("João");
  });
});

describe("JSON da API e do realtime", () => {
  it("aceita o array válido", () => {
    const raw = parseMetaSharedContacts([joao]);
    expect(sharedContactsFromJson(raw)).toEqual(raw);
  });

  it("JSON inválido vira null", () => {
    expect(sharedContactsFromJson({ name: "não é array" })).toBeNull();
    expect(sharedContactsFromJson([{ extra: true, phones: "não" }])).toBeNull();
  });

  it("new_message leva sharedContacts e a redação tira", () => {
    const payload = {
      organizationId: "org",
      conversationId: "c1",
      direction: "in",
      content: "Contato compartilhado: João Silva · +55 11 99999-9999",
      messageType: "contact",
      sharedContacts: parseMetaSharedContacts([joao]),
    };
    expect(payload.sharedContacts?.[0]?.name).toBe("João Silva");
    expect(redactNewMessageForUnlisted(payload)).not.toHaveProperty("sharedContacts");
    expect(redactNewMessageForUnlisted(payload).messageType).toBe("contact");
  });
});
