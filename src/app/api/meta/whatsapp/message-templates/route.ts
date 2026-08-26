import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { isMetaGraphError } from "@/lib/meta-whatsapp/client";
import { extractMetaPlaceholderKeys } from "@/lib/meta-whatsapp/operator-template-variables";
import { resolveMetaTemplatesClient } from "@/lib/meta-whatsapp/resolve-templates-client";
import { prisma } from "@/lib/prisma";

function requireAdminOrManager(session: { user?: { role?: string } }): NextResponse | null {
  const r = session.user?.role;
  if (r !== "ADMIN" && r !== "MANAGER") {
    return NextResponse.json({ message: "Apenas administrador ou gestor." }, { status: 403 });
  }
  return null;
}

/**
 * Timeout pra baixar a mídia de exemplo (HEADER IMAGE/VIDEO/DOCUMENT) de uma
 * URL HTTPS externa antes de subir via Resumable Upload API. Mesmo racional
 * do `GRAPH_TIMEOUT_MS` do client: falhar cedo com erro claro em vez de
 * pendurar a requisição até o proxy reverso devolver 502.
 */
const HEADER_MEDIA_FETCH_TIMEOUT_MS = 20_000;

/**
 * Resolve os bytes da mídia de exemplo do HEADER (IMAGE/VIDEO/DOCUMENT) a
 * partir de `headerMediaUrl` — aceita upload interno (`/api/storage/...`
 * tenant-scoped ou `/uploads/...` legacy) ou URL HTTPS pública. Mesmo
 * padrão usado pelo executor de automações ao resolver mídia de envio
 * (ver `resolveTemplateHeaderMediaParam` em `automation-executor.ts`).
 */
async function resolveHeaderMediaBuffer(
  mediaUrl: string,
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const trimmed = mediaUrl.trim();
  const { parseStoragePath, readStoredFile, mimeFromFilename } = await import(
    "@/lib/storage/local"
  );
  const parsedStorage = parseStoragePath(trimmed);
  const isLegacyLocal = !parsedStorage && trimmed.startsWith("/uploads/");

  if (parsedStorage) {
    const stored = await readStoredFile(
      parsedStorage.orgId,
      parsedStorage.bucket,
      parsedStorage.fileName,
    );
    if (!stored) {
      throw new Error(`Arquivo da mídia de exemplo não encontrado em storage (${trimmed}).`);
    }
    return { buffer: stored.buffer, mimeType: stored.mimeType, fileName: parsedStorage.fileName };
  }

  if (isLegacyLocal) {
    const { readFile } = await import("fs/promises");
    const { join, basename } = await import("path");
    const filePath = join(process.cwd(), "public", trimmed);
    const buffer = await readFile(filePath);
    const fileName = basename(trimmed);
    return { buffer, mimeType: mimeFromFilename(fileName), fileName };
  }

  if (trimmed.startsWith("https://")) {
    let res: Response;
    try {
      res = await fetch(trimmed, {
        cache: "no-store",
        signal: AbortSignal.timeout(HEADER_MEDIA_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new Error(
          `Tempo limite ao baixar a mídia de exemplo do cabeçalho (${HEADER_MEDIA_FETCH_TIMEOUT_MS}ms): ${trimmed}`,
        );
      }
      throw new Error(
        `Falha ao baixar a mídia de exemplo do cabeçalho (${trimmed}): ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!res.ok) {
      throw new Error(`Falha ao baixar a mídia de exemplo do cabeçalho (HTTP ${res.status}): ${trimmed}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
    const fileName = trimmed.split("?")[0].split("/").pop() || "header-media";
    const mimeType = contentType || mimeFromFilename(fileName);
    return { buffer, mimeType, fileName };
  }

  throw new Error(
    `URL da mídia de exemplo inválida — use uma URL HTTPS pública ou um caminho de upload interno (/api/storage/... ou /uploads/...): ${trimmed}`,
  );
}

/**
 * Marcadores do texto na ordem que a Meta espera no `example`. Posicional é
 * ordenado pelo número (`{{2}}` antes de `{{10}}`); nomeado mantém a ordem de
 * aparição, que é a ordem em que o operador leu o texto.
 */
function orderedPlaceholderKeys(text: string): string[] {
  const keys = extractMetaPlaceholderKeys(text);
  const allNumeric = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  return allNumeric ? [...keys].sort((a, b) => Number(a) - Number(b)) : keys;
}

/** Mapa `marcador -> exemplo` vindo da tela de criação (`{ "1": "Aux. Logística" }`). */
function readExampleMap(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out.set(k.trim(), v.trim());
  }
  return out;
}

/**
 * `example` do componente de texto no formato exigido pela Graph. Sem ele a
 * Meta rejeita qualquer template que tenha variável.
 *
 * POSITIONAL: `{ body_text: [[ "v1", "v2" ]] }` (o corpo é uma matriz — uma
 * linha por conjunto de exemplos) e `{ header_text: [ "v1" ] }` (o cabeçalho
 * é plano). NAMED: `{ body_text_named_params: [{ param_name, example }] }`.
 *
 * @returns `null` quando o texto não tem marcador — aí o componente vai sem
 *   `example`, que é o que a Meta espera de um texto fixo.
 */
function buildTextExample(
  kind: "body" | "header",
  parameterFormat: "POSITIONAL" | "NAMED",
  keys: string[],
  examples: Map<string, string>,
): Record<string, unknown> | null {
  if (keys.length === 0) return null;
  if (parameterFormat === "NAMED") {
    return {
      [`${kind}_text_named_params`]: keys.map((key) => ({
        param_name: key,
        example: examples.get(key) ?? "",
      })),
    };
  }
  const values = keys.map((key) => examples.get(key) ?? "");
  return { [`${kind}_text`]: kind === "body" ? [values] : values };
}

/**
 * GET: lista templates da WABA (Graph `message_templates`).
 * POST: cria template — corpo assistido ou `{ "raw": true, "payload": { ... } }` (JSON oficial Meta).
 *
 * Credenciais Meta vêm do canal Cloud API da organização (não do env global),
 * para evitar vazamento multi-tenant entre tenants.
 */
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const url = new URL(request.url);
      const channelId = url.searchParams.get("channelId");
      const resolved = await resolveMetaTemplatesClient({
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
        channelId,
      });
      if (!resolved.ok) return resolved.response;

      const after = url.searchParams.get("after") ?? undefined;
      const lim = url.searchParams.get("limit");
      const limit = lim ? Number.parseInt(lim, 10) : undefined;

      const data = await resolved.client.listMessageTemplates({
        after,
        limit: Number.isFinite(limit) ? limit : undefined,
      });

      // Templates que o operador ocultou no CRM saem da lista. A Meta não tem
      // esse conceito: quando ela recusa a exclusão, o template volta a cada
      // refresh. `includeHidden=1` traz de volta (tela "mostrar ocultos").
      const includeHidden = url.searchParams.get("includeHidden") === "1";
      const hidden = await prisma.whatsAppTemplateConfig.findMany({
        where: { hiddenAt: { not: null } },
        select: { metaTemplateId: true, metaTemplateName: true },
      });
      const hiddenIds = new Set(hidden.map((h) => h.metaTemplateId));
      const hiddenNames = new Set(hidden.map((h) => h.metaTemplateName));

      const payload =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {};
      const rows = Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>[])
        : [];
      const marked = rows.map((row) => ({
        ...row,
        hiddenInCrm:
          hiddenIds.has(String(row.id ?? "")) ||
          hiddenNames.has(String(row.name ?? "")),
      }));

      return NextResponse.json({
        ...payload,
        data: includeHidden ? marked : marked.filter((r) => !r.hiddenInCrm),
        hiddenCount: marked.filter((r) => r.hiddenInCrm).length,
      });
    } catch (e: unknown) {
      console.error("[meta-templates] GET", e);
      const msg = e instanceof Error ? e.message : "Erro ao listar templates na Meta.";
      return NextResponse.json({ message: msg }, { status: 502 });
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const roleDenied = requireAdminOrManager(session);
      if (roleDenied) return roleDenied;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }
      const b = body as Record<string, unknown>;
      const url = new URL(request.url);
      const channelIdFromQuery = url.searchParams.get("channelId");
      const channelIdFromBody =
        typeof b.channelId === "string" && b.channelId.trim() ? b.channelId.trim() : null;

      const resolved = await resolveMetaTemplatesClient({
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
        channelId: channelIdFromBody ?? channelIdFromQuery,
      });
      if (!resolved.ok) return resolved.response;

      const metaClient = resolved.client;

      if (b.raw === true && b.payload && typeof b.payload === "object" && !Array.isArray(b.payload)) {
        const data = await metaClient.createMessageTemplate(b.payload as Record<string, unknown>);
        return NextResponse.json(data, { status: 201 });
      }

      const nameRaw = typeof b.name === "string" ? b.name.trim().toLowerCase() : "";
      const name = nameRaw.replace(/-/g, "_");
      const language =
        typeof b.language === "string" && b.language.trim() ? b.language.trim() : "pt_BR";
      const category = (typeof b.category === "string" ? b.category.trim() : "").toUpperCase();
      const validCat = ["UTILITY", "MARKETING", "AUTHENTICATION"].includes(category);

      if (!name || !/^[a-z0-9_]+$/.test(name)) {
        return NextResponse.json(
          { message: "Nome inválido: use apenas letras minúsculas, números e sublinhado (ex.: cobranca_vencida)." },
          { status: 400 },
        );
      }
      if (!validCat) {
        return NextResponse.json(
          { message: "Categoria inválida. Use UTILITY, MARKETING ou AUTHENTICATION." },
          { status: 400 },
        );
      }

      const bodyText = typeof b.body === "string" ? b.body.trim() : "";
      if (!bodyText) {
        return NextResponse.json({ message: "Texto do corpo (body) é obrigatório." }, { status: 400 });
      }

      const parameterFormat = b.parameterFormat === "NAMED" ? "NAMED" : "POSITIONAL";
      const components: Record<string, unknown>[] = [];

      // Templates AUTHENTICATION têm corpo fixo da Meta (o `{{1}}` é o código
      // OTP) e não aceitam `example`; para os demais o exemplo é obrigatório
      // sempre que houver marcador.
      const wantsExamples = category !== "AUTHENTICATION";
      const bodyExamples = readExampleMap(b.bodyExamples);
      const headerExamples = readExampleMap(b.headerExamples);
      const headerTextRaw = typeof b.headerText === "string" ? b.headerText.trim() : "";
      const bodyKeys = wantsExamples ? orderedPlaceholderKeys(bodyText) : [];
      const headerKeys =
        wantsExamples && b.headerFormat === "TEXT" ? orderedPlaceholderKeys(headerTextRaw) : [];

      const missingExamples = [
        ...bodyKeys.filter((k) => !bodyExamples.has(k)).map((k) => `corpo {{${k}}}`),
        ...headerKeys.filter((k) => !headerExamples.has(k)).map((k) => `cabeçalho {{${k}}}`),
      ];
      if (missingExamples.length > 0 && !b.bodyExample && !b.headerExample) {
        return NextResponse.json(
          {
            message: `A Meta rejeita template com variável sem exemplo. Informe um valor de exemplo para: ${missingExamples.join(", ")}.`,
          },
          { status: 400 },
        );
      }

      const headerFormat = typeof b.headerFormat === "string" ? b.headerFormat : "NONE";
      if (headerFormat === "TEXT") {
        const ht = headerTextRaw;
        if (ht) {
          const hc: Record<string, unknown> = { type: "HEADER", format: "TEXT", text: ht };
          const headerExample =
            b.headerExample && typeof b.headerExample === "object"
              ? (b.headerExample as Record<string, unknown>)
              : buildTextExample("header", parameterFormat, headerKeys, headerExamples);
          if (headerExample) hc.example = headerExample;
          components.push(hc);
        }
      } else if (headerFormat === "IMAGE" || headerFormat === "VIDEO" || headerFormat === "DOCUMENT") {
        const headerMediaUrl = typeof b.headerMediaUrl === "string" ? b.headerMediaUrl.trim() : "";
        if (!headerMediaUrl) {
          return NextResponse.json(
            {
              message: `Cabeçalho ${headerFormat}: informe a URL (ou faça upload) da mídia de exemplo — a Meta exige isso ao criar o template.`,
            },
            { status: 400 },
          );
        }
        try {
          const { buffer, mimeType, fileName } = await resolveHeaderMediaBuffer(headerMediaUrl);
          const headerHandle = await metaClient.uploadResumableHandle(buffer, mimeType, fileName);
          components.push({
            type: "HEADER",
            format: headerFormat,
            example: { header_handle: [headerHandle] },
          });
        } catch (mediaErr: unknown) {
          console.error("[meta-templates] header media", mediaErr);
          const msg =
            mediaErr instanceof Error ? mediaErr.message : "Erro ao preparar a mídia de exemplo do cabeçalho.";
          return NextResponse.json({ message: msg }, { status: 400 });
        }
      }

      if (category === "AUTHENTICATION") {
        const compBody: Record<string, unknown> = {
          type: "BODY",
          text: bodyText,
          add_security_recommendation: Boolean(b.addSecurityRecommendation),
        };
        components.push(compBody);
        const minutes = typeof b.codeExpirationMinutes === "number" ? b.codeExpirationMinutes : 10;
        if (minutes > 0) {
          components.push({ type: "FOOTER", code_expiration_minutes: minutes });
        }
        const otpType =
          typeof b.otpType === "string" && b.otpType.trim() ? b.otpType.trim() : "COPY_CODE";
        const otpText =
          typeof b.otpButtonText === "string" && b.otpButtonText.trim()
            ? b.otpButtonText.trim().slice(0, 25)
            : "Copiar código";
        components.push({
          type: "BUTTONS",
          buttons: [{ type: "OTP", otp_type: otpType, text: otpText }],
        });
      } else {
        const compBody: Record<string, unknown> = { type: "BODY", text: bodyText };
        const bodyExample =
          b.bodyExample && typeof b.bodyExample === "object"
            ? (b.bodyExample as Record<string, unknown>)
            : buildTextExample("body", parameterFormat, bodyKeys, bodyExamples);
        if (bodyExample) compBody.example = bodyExample;
        components.push(compBody);

        const footer = typeof b.footer === "string" ? b.footer.trim() : "";
        if (footer) {
          components.push({ type: "FOOTER", text: footer });
        }

        if (Array.isArray(b.buttons) && b.buttons.length > 0) {
          components.push({ type: "BUTTONS", buttons: b.buttons });
        }
      }

      const payload: Record<string, unknown> = {
        name,
        language,
        category,
        components,
      };

      if (category === "MARKETING" || category === "UTILITY") {
        payload.parameter_format = parameterFormat;
      }

      const data = await metaClient.createMessageTemplate(payload);
      return NextResponse.json(data, { status: 201 });
    } catch (e: unknown) {
      console.error("[meta-templates] POST", e);
      // Rejeição de validação da Meta (exemplo faltando, formato de parâmetro
      // trocado…) precisa chegar legível ao operador, com o `fbtrace_id`.
      if (isMetaGraphError(e)) {
        return NextResponse.json(
          {
            message: e.toPersistedString(),
            code: e.code,
            subcode: e.subcode,
            fbtraceId: e.fbtraceId,
          },
          { status: 502 },
        );
      }
      const msg = e instanceof Error ? e.message : "Erro ao criar template na Meta.";
      return NextResponse.json({ message: msg }, { status: 502 });
    }
  });
}
