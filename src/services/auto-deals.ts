/**
 * auto-deals — Garante destino para inbounds quando o contato AINDA NÃO
 * possui histórico de deals.
 *
 * Histórico:
 *  - v1: auto-criava deal só pra contato NOVO. Contatos antigos sem deal
 *    ficavam órfãos no Painel CRM do Inbox ("Nenhum negócio aberto").
 *  - v2: passou a chamar `ensureOpenDealForContact` em TODO inbound,
 *    criando deal sempre que não houvesse OPEN — mesmo com WON/LOST no
 *    histórico. Resolveu os órfãos mas trouxe efeito colateral: cliente
 *    com deal LOST que voltasse a conversar re-disparava `deal_created`
 *    a cada mensagem, executando automações que não deveriam rodar de
 *    novo (ex.: boas-vindas pra lead já descartado).
 *  - v3 (jun/2026): "controle pelos gatilhos" — o backend NÃO reabre
 *    lead descartado nem recria deal pra cliente que já comprou. Quem
 *    decide o que fazer ao chegar uma mensagem em contato com deal
 *    fechado é a automação que o operador configurou (ex.: trigger
 *    `message_received` filtrando por `dealStatus=LOST` + step
 *    `create_deal` para reativação manual).
 *
 * Regra atual (default `reopenLostContacts: false`):
 *  - Contato sem deal algum         → cria deal + dispara `deal_created`
 *  - Contato com deal OPEN          → retorna existente, sem disparar
 *  - Contato com último deal LOST   → NÃO faz nada (skipped)
 *  - Contato com último deal WON    → NÃO faz nada (skipped)
 *  - O mesmo telefone em OUTRO contato (E.164, com ou sem o 9, ou
 *    legado que normaliza para a mesma linha) já tem deal aberto
 *    → reusa esse card. Só tem deal fechado → não cria outro.
 *    A busca é pelo deal, sem teto de linhas: um `findMany` curto
 *    deixava o contato que já atendia de fora e abria card novo.
 *
 * Opt-in `reopenLostContacts: true` mantém o comportamento v2 para
 * fluxos onde o caller PRECISA garantir um destino pros dados — ex.:
 * WhatsApp Flow Response (formulário preenchido precisa anexar campos
 * a algum deal) e scripts de backfill manual.
 */

import { scheduleBoardInvalidation } from "@/lib/cache/keys";
import { defaultDealTitleForContact } from "@/lib/display-name";
import { phoneMatchVariants } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { fireTrigger } from "@/services/automation-triggers";
import { createDeal, wasReusedOpenDeal } from "@/services/deals";
import { getNextOwner } from "@/services/lead-distribution";
import { allocateStageSlug, isStageNumberUniqueViolation, nextStageNumber } from "@/services/pipelines";
import { getLogger } from "@/lib/logger";

const log = getLogger("auto-deals");

type EnsureOpenDealSource = "auto_whatsapp" | "auto_whatsapp_qr" | string;

type EnsureOpenDealOptions = {
  contactId: string;
  contactName: string;
  source?: EnsureOpenDealSource;
  /** Prefixo usado em logs para identificar a origem do chamador. */
  logTag?: string;
  /**
   * Canal de origem do inbound. Quando informado e o canal tiver um
   * `defaultPipelineId` válido, o deal é criado NAQUELE funil — é assim que
   * cada canal (WhatsApp, e-mail, etc.) roteia para o funil configurado.
   * Ausente ou sem funil configurado → fallback para o funil padrão da org.
   */
  channelId?: string | null;
  /**
   * Opt-in pro comportamento legado (v2): cria deal sempre que não
   * houver um OPEN, mesmo que o contato tenha deals fechados (WON/LOST).
   *
   * Default `false`: respeita o histórico de deals do contato e só cria
   * automaticamente quando o contato NUNCA teve deal algum. Quem decide
   * o que fazer com um contato cujo último deal está fechado é a
   * automação configurada pelo operador (trigger `message_received` +
   * filtro `dealStatus` + step `create_deal`).
   *
   * Use `true` apenas em casos onde o caller precisa de um destino
   * garantido pros dados (ex.: WhatsApp Flow Response, scripts de
   * backfill manual).
   */
  reopenLostContacts?: boolean;
};

type EnsureOpenDealResult =
  | { status: "existing"; dealId: string }
  | { status: "created"; dealId: string }
  | {
      status: "skipped";
      reason: "no_pipeline" | "contact_has_closed_deal";
    };

type PhoneDealHit = {
  contactId: string;
  dealId: string | null;
  open: boolean;
};

/**
 * Contato que já é esta linha de telefone.
 *
 * Se algum contato da linha tem deal, devolve esse (aberto mais
 * recentemente atualizado; senão qualquer deal). A consulta filtra o
 * deal pelo telefone — não corta em N contatos. Sem deal, devolve o
 * contato mais antigo (para o inbound reusar a pessoa em vez de criar
 * outra). `excludeContactId` liga o modo "irmão": aí sem deal devolve
 * null, porque o caller já está no contato.
 */
export async function findExistingContactOnPhone(
  phone: string | null | undefined,
  excludeContactId?: string,
): Promise<PhoneDealHit | null> {
  const variants = phoneMatchVariants(phone);
  if (variants.length === 0) return null;

  const asHit = (
    row: { id: string; contactId: string | null } | null,
    open: boolean,
  ): PhoneDealHit | null => {
    if (!row?.contactId) return null;
    return { contactId: row.contactId, dealId: row.id, open };
  };

  const exactContact = {
    phone: { in: variants },
    ...(excludeContactId ? { id: { not: excludeContactId } } : {}),
  };

  const openExact = await prisma.deal.findFirst({
    where: { status: "OPEN", contact: exactContact },
    orderBy: { updatedAt: "desc" },
    select: { id: true, contactId: true },
  });
  const openExactHit = asHit(openExact, true);
  if (openExactHit) return openExactHit;

  const anyExact = await prisma.deal.findFirst({
    where: { contact: exactContact },
    orderBy: { updatedAt: "desc" },
    select: { id: true, contactId: true },
  });
  const anyExactHit = asHit(anyExact, false);
  if (anyExactHit) return anyExactHit;

  const digits = (phone ?? "").replace(/\D/g, "");
  const last8 = digits.slice(-8);
  if (last8.length === 8) {
    const legacy = await prisma.contact.findMany({
      where: {
        phone: { endsWith: last8, notIn: variants },
        ...(excludeContactId ? { id: { not: excludeContactId } } : {}),
      },
      select: { id: true, phone: true },
    });
    const variantSet = new Set(variants);
    const ids = legacy
      .filter((row) => phoneMatchVariants(row.phone).some((v) => variantSet.has(v)))
      .map((row) => row.id);
    if (ids.length > 0) {
      const openLegacy = await prisma.deal.findFirst({
        where: { status: "OPEN", contactId: { in: ids } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, contactId: true },
      });
      const openLegacyHit = asHit(openLegacy, true);
      if (openLegacyHit) return openLegacyHit;
      const anyLegacy = await prisma.deal.findFirst({
        where: { contactId: { in: ids } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, contactId: true },
      });
      const anyLegacyHit = asHit(anyLegacy, false);
      if (anyLegacyHit) return anyLegacyHit;
    }
  }

  if (excludeContactId) return null;

  const oldest = await prisma.contact.findFirst({
    where: { phone: { in: variants } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!oldest) return null;
  return { contactId: oldest.id, dealId: null, open: false };
}

/**
 * O telefone já tem deal em outro contato (com/sem o 9, o mesmo número
 * duas vezes, ou gravado fora do E.164). Aberto → reusa. Só fechado →
 * não cria outro.
 */
async function findDealOnSamePhone(
  contactId: string,
  reopenLostContacts: boolean,
): Promise<EnsureOpenDealResult | null> {
  const self = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { phone: true },
  });
  const held = await findExistingContactOnPhone(self?.phone, contactId);
  if (!held?.dealId) return null;
  if (held.open) return { status: "existing", dealId: held.dealId };
  if (!reopenLostContacts) {
    return { status: "skipped", reason: "contact_has_closed_deal" };
  }
  return null;
}

/**
 * Decide se um inbound passivo merece um deal automático e, em caso
 * positivo, o cria no estágio de entrada do funil de destino disparando
 * `deal_created`.
 *
 * Resultados possíveis:
 *  - `existing`  → contato já tinha um deal OPEN; retorna o id sem efeitos.
 *  - `created`   → criou deal novo + disparou `deal_created`.
 *  - `skipped`   → não criou nada. `reason` indica o motivo:
 *      - `"no_pipeline"`              setup inicial sem funil configurado
 *      - `"contact_has_closed_deal"`  contato tem WON/LOST no histórico
 *                                     (default v3 — ver header do arquivo)
 *
 * Caller deve tratar `skipped` como no-op silencioso. Quando precisa
 * forçar criação mesmo com deals fechados, passa `reopenLostContacts: true`.
 */
export async function ensureOpenDealForContact(
  options: EnsureOpenDealOptions,
): Promise<EnsureOpenDealResult> {
  const {
    contactId,
    contactName,
    source = "auto_whatsapp",
    logTag = "auto-deals",
    channelId,
    reopenLostContacts = false,
  } = options;

  // Modo padrão (v3): só auto-cria deal pra contato SEM histórico.
  // Se o contato já teve qualquer deal (mesmo fechado), respeita o
  // estado declarado e delega a decisão pras automações configuradas
  // — evita re-disparar `deal_created` em lead descartado / cliente
  // que já comprou.
  if (!reopenLostContacts) {
    const latest = await prisma.deal.findFirst({
      where: { contactId },
      select: { id: true, status: true },
      orderBy: { createdAt: "desc" },
    });
    if (latest) {
      if (latest.status === "OPEN") {
        return { status: "existing", dealId: latest.id };
      }
      return { status: "skipped", reason: "contact_has_closed_deal" };
    }
  } else {
    // Modo legado: só reusa quando há OPEN; cria novo se tiver só WON/LOST.
    const existingOpen = await prisma.deal.findFirst({
      where: { contactId, status: "OPEN" },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (existingOpen) {
      return { status: "existing", dealId: existingOpen.id };
    }
  }

  // Rede de segurança: o inbound pode ter resolvido o contato vazio
  // (BSUID) enquanto o telefone já tem deal no contato ao lado.
  const siblingDeal = await findDealOnSamePhone(contactId, reopenLostContacts);
  if (siblingDeal) {
    log.warn(
      { contactId, result: siblingDeal.status },
      "telefone já tem deal em outro contato — não criando card novo",
    );
    return siblingDeal;
  }

  // Roteamento por canal: se o inbound veio de um canal com `defaultPipelineId`
  // configurado, o lead vai pra ESSE funil. Permite que cada WhatsApp/e-mail
  // rode no seu próprio funil em vez de tudo cair no padrão da org.
  let pipeline: { id: string } | null = null;
  if (channelId) {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { defaultPipelineId: true },
    });
    if (channel?.defaultPipelineId) {
      pipeline = await prisma.pipeline.findFirst({
        where: { id: channel.defaultPipelineId, archivedAt: null },
        select: { id: true },
      });
    }
  }

  // 27/mai/26 — Fallback: prioriza pipeline marcado como `isDefault`
  // (configurado via UI de pipelines). Cai pro mais antigo só como fallback
  // quando nenhum default existe. Antes pegava sempre o mais antigo, o que
  // confundia operadores com mais de um pipeline (lead aparecia no errado).
  if (!pipeline) {
    pipeline = await prisma.pipeline.findFirst({
      where: { archivedAt: null },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    });
  }
  if (!pipeline) {
    log.warn({ logTag, contactId }, "nenhum pipeline encontrado — deal não criado");
    return { status: "skipped", reason: "no_pipeline" };
  }

  let incomingStage = await prisma.stage.findFirst({
    where: { pipelineId: pipeline.id, isIncoming: true },
  });

  if (!incomingStage) {
    // Cria estágio "Lead de Entrada" no topo da esteira se o pipeline
    // ainda não tiver nenhum marcado como `isIncoming`. Mantém a mesma
    // semântica visual do onboarding (amarelo, SLA 7d).
    const minPos = await prisma.stage.aggregate({
      where: { pipelineId: pipeline.id },
      _min: { position: true },
    });
    const newPosition = (minPos._min.position ?? 0) - 1;

    const stageName = "Lead de Entrada";
    let lastStageErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        incomingStage = await prisma.stage.create({
          data: {
            organizationId: getOrgIdOrThrow(),
            name: stageName,
            slug: await allocateStageSlug(pipeline.id, stageName),
            number: await nextStageNumber(pipeline.id),
            pipelineId: pipeline.id,
            position: newPosition,
            color: "#f59e0b",
            winProbability: 0,
            rottingDays: 7,
            isIncoming: true,
          },
        });
        lastStageErr = undefined;
        break;
      } catch (err) {
        lastStageErr = err;
        if (!isStageNumberUniqueViolation(err)) throw err;
      }
    }
    if (!incomingStage) {
      throw lastStageErr instanceof Error
        ? lastStageErr
        : new Error("Falha ao alocar number de estágio.");
    }
  }

  const maxPos = await prisma.deal.aggregate({
    where: { stageId: incomingStage.id },
    _max: { position: true },
  });

  const ownerId = await getNextOwner(pipeline.id);

  const deal = await createDeal({
    contactId,
    stageId: incomingStage.id,
    title: defaultDealTitleForContact(contactName) ?? undefined,
    status: "OPEN",
    position: (maxPos._max.position ?? -1) + 1,
    ownerId,
  });
  if (wasReusedOpenDeal(deal)) {
    return { status: "existing", dealId: deal.id };
  }

  // O `new_message` só purga os pipelines onde o contato já tem deal, e
  // este deal nasce em paralelo à mensagem — o card novo entra por aqui.
  scheduleBoardInvalidation(getOrgIdOrThrow(), pipeline.id);

  fireTrigger("deal_created", {
    dealId: deal.id,
    contactId,
    data: {
      pipelineId: pipeline.id,
      stageId: incomingStage.id,
      toStageId: incomingStage.id,
      source,
    },
  }).catch((err) =>
    log.warn({ logTag, err }, "fireTrigger deal_created error"),
  );

  log.info({ logTag, stage: incomingStage.name, contactId, dealId: deal.id }, "Deal criado");
  return { status: "created", dealId: deal.id };
}
