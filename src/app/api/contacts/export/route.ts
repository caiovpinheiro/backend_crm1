import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { csvDate, toCsv } from "@/lib/csv-stringify";
import { resolveContactDisplayName } from "@/lib/display-name";
import { prisma } from "@/lib/prisma";

const MAX_ROWS = 100_000;

/**
 * GET /api/contacts/export
 *
 * Exporta contatos em CSV (1 linha por contato), com colunas estáveis +
 * campos personalizados (`cf_*`). Nomes de coluna seguem o importador
 * (`/api/contacts/import`) onde aplicável, permitindo round-trip.
 *
 * Apenas ADMIN/MANAGER (mesma regra do import).
 */
export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const role = (authResult.user as { role?: string }).role;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json(
          { message: "Apenas administradores e gerentes podem exportar dados." },
          { status: 403 },
        );
      }
      const denied = await requirePermissionForUser(authResult.user, "contact:view");
      if (denied) return denied;

      const contactFields = await prisma.customField.findMany({
        where: { entity: "contact" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });

      // Campos personalizados do NEGÓCIO — viram colunas "Negócio — <campo>"
      // no export de contatos, para o relatório por telefone sempre trazer os
      // dados da matrícula (cpf, curso, email, email_academico, rgm, polo,
      // nascimento, situação...). Cada campo mantém sua própria coluna.
      const dealFields = await prisma.customField.findMany({
        where: { entity: "deal" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
      // ID do email pessoal do negócio — usado como fallback da coluna "E-mail"
      // base do contato (email_academico NÃO entra aqui, é campo distinto).
      const dealPersonalEmailCfId =
        dealFields.find((f) => f.name === "email")?.id ?? null;

      const contacts = await prisma.contact.findMany({
        take: MAX_ROWS,
        orderBy: [{ createdAt: "asc" }],
        include: {
          company: { select: { name: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          tags: { include: { tag: { select: { name: true } } } },
          customFields: { select: { customFieldId: true, value: true } },
          // Títulos dos negócios (mais recentes) — fallback de nome quando o
          // `name` do contato for placeholder (telefone/"Lead ...").
          deals: {
            select: {
              title: true,
              customFields: { select: { customFieldId: true, value: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 20,
          },
        },
      });

      // Headers em PT-BR natural. Custom fields exportados com o nome real
      // do campo (sem prefixo) — auto-mapping casa por nome.
      const baseHeaders = [
        "Nome",
        "E-mail",
        "Telefone",
        "Ciclo de vida",
        "Origem",
        "Empresa",
        "Responsável",
        "E-mail do responsável",
        "Tags",
        "ID da fonte do anúncio",
        "CTWA CLID",
        "Campanha do anúncio",
        "Criado em",
        "Atualizado em",
      ];
      const cfHeaders = contactFields.map((f) => f.name);
      const dealCfHeaders = dealFields.map((f) => `Negócio — ${f.name}`);
      const headers = [...baseHeaders, ...cfHeaders, ...dealCfHeaders];

      const rows = contacts.map((c) => {
        const cfMap = new Map(c.customFields.map((v) => [v.customFieldId, v.value]));
        // Valor de um cf do negócio: primeiro não-vazio entre os negócios do
        // contato (mais recentes primeiro).
        const dealCfValue = (cfId: string): string => {
          for (const d of c.deals) {
            const v = d.customFields.find((x) => x.customFieldId === cfId)?.value;
            if (typeof v === "string" && v.trim() !== "") return v;
          }
          return "";
        };
        const row: Record<string, unknown> = {
          "Nome": resolveContactDisplayName(c.name, ...c.deals.map((d) => d.title)),
          "E-mail":
            c.email ||
            (dealPersonalEmailCfId ? dealCfValue(dealPersonalEmailCfId) : ""),
          "Telefone": (c.phone ?? "").replace(/^\+/, ""),
          "Ciclo de vida": c.lifecycleStage,
          "Origem": c.source ?? "",
          "Empresa": c.company?.name ?? "",
          "Responsável": c.assignedTo?.name ?? "",
          "E-mail do responsável": c.assignedTo?.email ?? "",
          "Tags": c.tags.map((t) => t.tag.name).join("; "),
          "ID da fonte do anúncio": c.adSourceId ?? "",
          "CTWA CLID": c.adCtwaClid ?? "",
          "Campanha do anúncio": c.adResolvedCampaignName ?? "",
          "Criado em": csvDate(c.createdAt),
          "Atualizado em": csvDate(c.updatedAt),
        };
        for (const f of contactFields) {
          row[f.name] = cfMap.get(f.id) ?? "";
        }
        for (const f of dealFields) {
          row[`Negócio — ${f.name}`] = dealCfValue(f.id);
        }
        return row;
      });

      const csv = toCsv(headers, rows);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `contatos-${stamp}.csv`;

      return new NextResponse("\ufeff" + csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Export-Total": String(rows.length),
          "Access-Control-Expose-Headers":
            "Content-Disposition, X-Export-Total",
        },
      });
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao exportar contatos." }, { status: 500 });
  }
}
