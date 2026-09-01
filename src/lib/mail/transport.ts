import https from "node:https";

import { getLogger } from "@/lib/logger";
import { runtimeEnv } from "@/lib/runtime-env";

const log = getLogger("mail");

const DEFAULT_FROM_EMAIL = "no-reply@bwipo.com";
const DEFAULT_FROM_NAME = "Bwipo";
const MAILJET_SEND_PATH = "/v3.1/send";
const MAILJET_HOST = ["api", "mailjet", "com"].join(".");
const SEND_TIMEOUT_MS = 15_000;

/** Nomes montados em runtime — o bundler não consegue inlinear `undefined`. */
function smtpKey(
  part: "HOST" | "PORT" | "USER" | "PASS" | "FROM" | "FROM_EMAIL" | "FROM_NAME",
): string {
  return ["SMTP", part].join("_");
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super("SMTP não configurado.");
    this.name = "MailNotConfiguredError";
  }
}

export function resolveFromAddress(): { address: string; name: string } {
  const namedEmail = runtimeEnv(smtpKey("FROM_EMAIL"));
  const namedName = runtimeEnv(smtpKey("FROM_NAME"));
  const combined = runtimeEnv(smtpKey("FROM"));
  if (namedEmail) {
    return { address: namedEmail, name: namedName || DEFAULT_FROM_NAME };
  }
  if (combined) {
    const m = combined.match(/^(.*)<([^>]+)>$/);
    if (m) {
      return {
        name: m[1].trim().replace(/^"|"$/g, "") || DEFAULT_FROM_NAME,
        address: m[2].trim(),
      };
    }
    return { address: combined, name: namedName || DEFAULT_FROM_NAME };
  }
  return { address: DEFAULT_FROM_EMAIL, name: namedName || DEFAULT_FROM_NAME };
}

type MailjetSendBody = {
  Messages?: Array<{
    Status?: string;
    Errors?: Array<{ ErrorCode?: string; ErrorMessage?: string }>;
  }>;
  ErrorMessage?: string;
  ErrorCode?: string;
};

function mailjetAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

function postMailjetSend(user: string, pass: string, payload: unknown): Promise<MailjetSendBody> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: MAILJET_HOST,
        port: 443,
        path: MAILJET_SEND_PATH,
        method: "POST",
        family: 4,
        headers: {
          Authorization: mailjetAuthHeader(user, pass),
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: MailjetSendBody = {};
          try {
            parsed = raw ? (JSON.parse(raw) as MailjetSendBody) : {};
          } catch {
            reject(new Error(`Mailjet HTTP ${res.statusCode}: resposta inválida`));
            return;
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const msg =
              parsed.ErrorMessage ||
              parsed.Messages?.[0]?.Errors?.[0]?.ErrorMessage ||
              `HTTP ${res.statusCode}`;
            reject(new Error(`Mailjet HTTP ${res.statusCode}: ${msg}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.setTimeout(SEND_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Mailjet HTTP timeout após ${SEND_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const user = runtimeEnv(smtpKey("USER"));
  const pass = runtimeEnv(smtpKey("PASS"));
  if (!user || !pass) {
    log.warn(
      {
        smtpUser: Boolean(user),
        smtpPass: Boolean(pass),
        smtpFromEmail: Boolean(runtimeEnv(smtpKey("FROM_EMAIL"))),
      },
      "SMTP_USER/SMTP_PASS ausentes — e-mail transacional não enviado",
    );
    throw new MailNotConfiguredError();
  }

  const from = resolveFromAddress();
  try {
    const result = await postMailjetSend(user, pass, {
      Messages: [
        {
          From: { Email: from.address, Name: from.name },
          To: [{ Email: input.to }],
          Subject: input.subject,
          TextPart: input.text,
          HTMLPart: input.html,
        },
      ],
    });
    const status = result.Messages?.[0]?.Status;
    if (status && status !== "success") {
      const msg = result.Messages?.[0]?.Errors?.[0]?.ErrorMessage || status;
      throw new Error(`Mailjet rejeitou o envio: ${msg}`);
    }
  } catch (err) {
    log.error({ err }, "Falha ao enviar e-mail transacional");
    throw err;
  }
}
