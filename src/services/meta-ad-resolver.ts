/**
 * Resolve post Click-to-WhatsApp → ad metadata via Meta Marketing API.
 *
 * Cenário típico: anúncio promovendo um post existente do Facebook. Quando
 * o usuário clica, a Meta envia no webhook `referral.source_type = "post"`
 * + `source_id = <POST_ID>`, mas NÃO envia o `ad_id`. Este serviço resolve
 * o post para metadados do anúncio chamando o Graph API.
 *
 * - Reusa o token do canal Meta (META_WHATSAPP_ACCESS_TOKEN ou o
 *   token do canal). Se o token não tiver permissão `ads_read`, retorna
 *   `no_access` (não-fatal).
 * - Grava resultado nos campos `ad_resolved_*` do contato; replica para
 *   outros contatos da mesma org com o mesmo `ad_source_id` para evitar
 *   chamar a API novamente (cache de fato é o próprio banco).
 */
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("meta-ad-resolver");

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION?.trim() || "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

type ResolveStatus = "ok" | "not_found" | "no_access" | "rate_limited" | "error";

type ResolvedAd = {
  adId: string | null;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  utmId: string | null;
  utmReferrer: string | null;
  referrer: string | null;
  gclid: string | null;
  fbclid: string | null;
  googleClientId: string | null;
  ttadId: string | null;
  ttadName: string | null;
};

const EMPTY_TRACKING = {
  utmSource: null as string | null,
  utmMedium: null as string | null,
  utmCampaign: null as string | null,
  utmContent: null as string | null,
  utmTerm: null as string | null,
  utmId: null as string | null,
  utmReferrer: null as string | null,
  referrer: null as string | null,
  gclid: null as string | null,
  fbclid: null as string | null,
  googleClientId: null as string | null,
  ttadId: null as string | null,
  ttadName: null as string | null,
};

/**
 * Parseia `url_tags` do Ad ou querystring de uma URL (`source_url` do referral).
 * Extrai UTMs padrão + click IDs (estilo Kommo Informação rastreada).
 */
export function parseTrackingParams(raw: string | null | undefined): typeof EMPTY_TRACKING {
  if (!raw || typeof raw !== "string") return { ...EMPTY_TRACKING };
  try {
    let search = raw.trim();
    if (search.startsWith("http://") || search.startsWith("https://")) {
      const u = new URL(search);
      search = u.search.startsWith("?") ? u.search.slice(1) : u.search;
      // referrer = URL sem query quando veio URL completa
      const referrerBase = `${u.origin}${u.pathname}`;
      const params = new URLSearchParams(search);
      return {
        utmSource: params.get("utm_source"),
        utmMedium: params.get("utm_medium"),
        utmCampaign: params.get("utm_campaign"),
        utmContent: params.get("utm_content"),
        utmTerm: params.get("utm_term"),
        utmId: params.get("utm_id"),
        utmReferrer: params.get("utm_referrer"),
        referrer: params.get("referrer") || referrerBase || null,
        gclid: params.get("gclid"),
        fbclid: params.get("fbclid"),
        googleClientId: params.get("gclientid") || params.get("_ga") || params.get("client_id"),
        ttadId: params.get("ttad_id") || params.get("ttclid"),
        ttadName: params.get("ttad_name"),
      };
    }
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    return {
      utmSource: params.get("utm_source"),
      utmMedium: params.get("utm_medium"),
      utmCampaign: params.get("utm_campaign"),
      utmContent: params.get("utm_content"),
      utmTerm: params.get("utm_term"),
      utmId: params.get("utm_id"),
      utmReferrer: params.get("utm_referrer"),
      referrer: params.get("referrer"),
      gclid: params.get("gclid"),
      fbclid: params.get("fbclid"),
      googleClientId: params.get("gclientid") || params.get("_ga") || params.get("client_id"),
      ttadId: params.get("ttad_id") || params.get("ttclid"),
      ttadName: params.get("ttad_name"),
    };
  } catch {
    return { ...EMPTY_TRACKING };
  }
}

type ResolutionResult = {
  status: ResolveStatus;
  error: string | null;
  data: ResolvedAd | null;
};

/**
 * Endpoint principal: GET /{post_id}/promotion_info — retorna metadados
 * do anúncio que promove o post (ad_id, ad_object_story_id, etc.).
 * Documentação: https://developers.facebook.com/docs/graph-api/reference/post/
 *
 * Tem uma limitação: só funciona se o token tiver `pages_read_engagement`
 * e/ou `ads_management` no escopo do System User, e se o post for de
 * uma Page conectada à mesma conta de negócios.
 */
async function fetchAdFromPost(
  postId: string,
  accessToken: string,
): Promise<ResolutionResult> {
  // Tentativa 1: /{post_id} com fields=promotion_info (Meta docs estável)
  // Se falhar, tentativa 2: /{post_id} com fields=ads (mais raro mas usado em alguns Business Manager).
  const url = new URL(`${GRAPH_BASE}/${encodeURIComponent(postId)}`);
  url.searchParams.set(
    "fields",
    "id,promotion_info{ad_id,ad_object_story_id},ads{id,name,url_tags,adset{id,name,campaign{id,name}}}",
  );

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      data: null,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { status: "no_access", error: `HTTP ${res.status}`, data: null };
  }
  if (res.status === 429) {
    return { status: "rate_limited", error: "HTTP 429", data: null };
  }
  if (res.status === 404) {
    return { status: "not_found", error: "HTTP 404 do post", data: null };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 500);
    } catch {
      // ignore
    }
    return { status: "error", error: `HTTP ${res.status} ${body}`, data: null };
  }

  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Invalid JSON",
      data: null,
    };
  }

  // Caminho 1: promotion_info preenchido
  const promo = json.promotion_info as Record<string, unknown> | undefined;
  let adId = typeof promo?.ad_id === "string" ? promo.ad_id : null;

  // Caminho 2: edge `ads` (lista) — pega o primeiro ativo
  let adFromList: Record<string, unknown> | null = null;
  if (!adId) {
    const adsObj = json.ads as Record<string, unknown> | undefined;
    const adsList = Array.isArray(adsObj?.data) ? (adsObj?.data as Record<string, unknown>[]) : [];
    if (adsList.length > 0) {
      adFromList = adsList[0];
      const id = adFromList?.id;
      if (typeof id === "string") adId = id;
    }
  }

  if (!adId) {
    return { status: "not_found", error: "post sem ad associado", data: null };
  }

  // Se vier pelo caminho 2, já temos name/adset/campaign no objeto retornado.
  // Se vier só pelo caminho 1 (promotion_info), faz GET /{ad_id} para enriquecer.
  let adName: string | null = null;
  let adsetId: string | null = null;
  let adsetName: string | null = null;
  let campaignId: string | null = null;
  let campaignName: string | null = null;
  let urlTagsStr: string | null = null;

  if (adFromList) {
    if (typeof adFromList.name === "string") adName = adFromList.name;
    if (typeof adFromList.url_tags === "string") urlTagsStr = adFromList.url_tags;
    const adset = adFromList.adset as Record<string, unknown> | undefined;
    if (adset) {
      if (typeof adset.id === "string") adsetId = adset.id;
      if (typeof adset.name === "string") adsetName = adset.name;
      const camp = adset.campaign as Record<string, unknown> | undefined;
      if (camp) {
        if (typeof camp.id === "string") campaignId = camp.id;
        if (typeof camp.name === "string") campaignName = camp.name;
      }
    }
  } else {
    // Enriquecer via /{ad_id}
    try {
      const adUrl = new URL(`${GRAPH_BASE}/${encodeURIComponent(adId)}`);
      adUrl.searchParams.set("fields", "id,name,url_tags,adset{id,name,campaign{id,name}}");
      const r = await fetch(adUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (r.ok) {
        const a = (await r.json()) as Record<string, unknown>;
        if (typeof a.name === "string") adName = a.name;
        if (typeof a.url_tags === "string") urlTagsStr = a.url_tags;
        const adset = a.adset as Record<string, unknown> | undefined;
        if (adset) {
          if (typeof adset.id === "string") adsetId = adset.id;
          if (typeof adset.name === "string") adsetName = adset.name;
          const camp = adset.campaign as Record<string, unknown> | undefined;
          if (camp) {
            if (typeof camp.id === "string") campaignId = camp.id;
            if (typeof camp.name === "string") campaignName = camp.name;
          }
        }
      }
    } catch {
      // metadados extras são opcionais — o ad_id já é suficiente
    }
  }

  const utms = parseTrackingParams(urlTagsStr);

  return {
    status: "ok",
    error: null,
    data: { adId, adName, adsetId, adsetName, campaignId, campaignName, ...utms },
  };
}

/** GET /{ad-id} — quando o referral já traz source_type=ad. */
async function fetchAdById(
  adId: string,
  accessToken: string,
): Promise<ResolutionResult> {
  try {
    const adUrl = new URL(`${GRAPH_BASE}/${encodeURIComponent(adId)}`);
    adUrl.searchParams.set("fields", "id,name,url_tags,adset{id,name,campaign{id,name}}");
    const r = await fetch(adUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 401 || r.status === 403) {
      return { status: "no_access", error: `HTTP ${r.status}`, data: null };
    }
    if (r.status === 429) {
      return { status: "rate_limited", error: "HTTP 429", data: null };
    }
    if (r.status === 404) {
      return { status: "not_found", error: "HTTP 404 do ad", data: null };
    }
    if (!r.ok) {
      let body = "";
      try {
        body = (await r.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      return { status: "error", error: `HTTP ${r.status} ${body}`, data: null };
    }
    const a = (await r.json()) as Record<string, unknown>;
    let adName: string | null = typeof a.name === "string" ? a.name : null;
    let adsetId: string | null = null;
    let adsetName: string | null = null;
    let campaignId: string | null = null;
    let campaignName: string | null = null;
    const urlTagsStr = typeof a.url_tags === "string" ? a.url_tags : null;
    const adset = a.adset as Record<string, unknown> | undefined;
    if (adset) {
      if (typeof adset.id === "string") adsetId = adset.id;
      if (typeof adset.name === "string") adsetName = adset.name;
      const camp = adset.campaign as Record<string, unknown> | undefined;
      if (camp) {
        if (typeof camp.id === "string") campaignId = camp.id;
        if (typeof camp.name === "string") campaignName = camp.name;
      }
    }
    const utms = parseTrackingParams(urlTagsStr);
    return {
      status: "ok",
      error: null,
      data: {
        adId,
        adName,
        adsetId,
        adsetName,
        campaignId,
        campaignName,
        ...utms,
      },
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      data: null,
    };
  }
}

/** Monta o patch Prisma só com campos de rastreio não-nulos (não apaga o que já tem). */
function trackingPatchFromResolved(
  data: ResolvedAd | null,
  opts?: { fillEmptyOnly?: Partial<Record<string, string | null>> },
): Record<string, string | null | Date> {
  if (!data) return {};
  const cur = opts?.fillEmptyOnly ?? {};
  const setIf = (key: string, value: string | null | undefined, currentKey?: string) => {
    if (!value) return {};
    const curKey = currentKey ?? key;
    if (cur[curKey] != null && String(cur[curKey]).trim() !== "") return {};
    return { [key]: value };
  };
  return {
    ...setIf("adResolvedId", data.adId),
    ...setIf("adResolvedName", data.adName),
    ...setIf("adResolvedAdsetId", data.adsetId),
    ...setIf("adResolvedAdsetName", data.adsetName),
    ...setIf("adResolvedCampaignId", data.campaignId),
    ...setIf("adResolvedCampaignName", data.campaignName),
    ...setIf("adUtmSource", data.utmSource),
    ...setIf("adUtmMedium", data.utmMedium),
    ...setIf("adUtmCampaign", data.utmCampaign),
    ...setIf("adUtmContent", data.utmContent),
    ...setIf("adUtmTerm", data.utmTerm),
    ...setIf("utmId", data.utmId),
    ...setIf("utmReferrer", data.utmReferrer),
    ...setIf("referrer", data.referrer),
    ...setIf("gclid", data.gclid),
    ...setIf("fbclid", data.fbclid),
    ...setIf("googleClientId", data.googleClientId),
    ...setIf("ttadId", data.ttadId),
    ...setIf("ttadName", data.ttadName),
  };
}

/**
 * Tenta resolver pelo cache (banco): se outro contato da mesma org já
 * tem o mesmo `ad_source_id` resolvido com sucesso recentemente (< 24h),
 * reusa os dados sem chamar a Meta de novo.
 */
async function lookupCache(
  organizationId: string,
  sourceId: string,
): Promise<ResolvedAd | null> {
  const TTL_HOURS = 24;
  const since = new Date(Date.now() - TTL_HOURS * 60 * 60 * 1000);
  const cached = await prisma.contact.findFirst({
    where: {
      organizationId,
      adSourceId: sourceId,
      adResolveStatus: "ok",
      adResolvedAt: { gte: since },
      adResolvedId: { not: null },
    },
    select: {
      adResolvedId: true,
      adResolvedName: true,
      adResolvedAdsetId: true,
      adResolvedAdsetName: true,
      adResolvedCampaignId: true,
      adResolvedCampaignName: true,
      adUtmSource: true,
      adUtmMedium: true,
      adUtmCampaign: true,
      adUtmContent: true,
      adUtmTerm: true,
      utmId: true,
      utmReferrer: true,
      referrer: true,
      gclid: true,
      fbclid: true,
      googleClientId: true,
      ttadId: true,
      ttadName: true,
    },
    orderBy: { adResolvedAt: "desc" },
  });
  if (!cached?.adResolvedId) return null;
  return {
    adId: cached.adResolvedId,
    adName: cached.adResolvedName,
    adsetId: cached.adResolvedAdsetId,
    adsetName: cached.adResolvedAdsetName,
    campaignId: cached.adResolvedCampaignId,
    campaignName: cached.adResolvedCampaignName,
    utmSource: cached.adUtmSource,
    utmMedium: cached.adUtmMedium,
    utmCampaign: cached.adUtmCampaign,
    utmContent: cached.adUtmContent,
    utmTerm: cached.adUtmTerm,
    utmId: cached.utmId,
    utmReferrer: cached.utmReferrer,
    referrer: cached.referrer,
    gclid: cached.gclid,
    fbclid: cached.fbclid,
    googleClientId: cached.googleClientId,
    ttadId: cached.ttadId,
    ttadName: cached.ttadName,
  };
}

/**
 * Função pública — chame com `void` no handler do webhook para não
 * bloquear a resposta 200 à Meta. Faz cache lookup primeiro; se cache
 * miss, chama Graph API; persiste o resultado no contato.
 *
 * `sourceType`:
 *  - `"ad"` → GET /{ad-id} (url_tags + campanha)
 *  - `"post"` (ou outro) → resolve post→ad via promotion_info
 */
export async function resolveAdAndPersistAsync(args: {
  contactId: string;
  organizationId: string;
  sourceId: string;
  sourceType?: string | null;
  accessToken: string | null;
  /** URL do referral (source_url) — preenche referrer/UTMs se vierem na query. */
  sourceUrl?: string | null;
}): Promise<void> {
  const { contactId, organizationId, sourceId, accessToken } = args;
  const sourceType = (args.sourceType ?? "").toLowerCase();

  // Sempre tenta enriquecer a partir do source_url do referral (síncrono, barato).
  if (args.sourceUrl) {
    const fromUrl = parseTrackingParams(args.sourceUrl);
    const existing = await prisma.contact
      .findUnique({
        where: { id: contactId },
        select: {
          adUtmSource: true,
          adUtmMedium: true,
          adUtmCampaign: true,
          adUtmContent: true,
          adUtmTerm: true,
          utmId: true,
          utmReferrer: true,
          referrer: true,
          gclid: true,
          fbclid: true,
          googleClientId: true,
          ttadId: true,
          ttadName: true,
        },
      })
      .catch(() => null);
    const urlPatch = trackingPatchFromResolved(
      {
        adId: null,
        adName: null,
        adsetId: null,
        adsetName: null,
        campaignId: null,
        campaignName: null,
        ...fromUrl,
      },
      { fillEmptyOnly: (existing ?? {}) as Record<string, string | null> },
    );
    // source_url completa como referrer se ainda vazio
    if (!existing?.referrer && args.sourceUrl) {
      urlPatch.referrer = args.sourceUrl.slice(0, 2000);
    }
    if (Object.keys(urlPatch).length > 0) {
      await prisma.contact
        .update({ where: { id: contactId }, data: urlPatch })
        .catch((e) => log.debug("falha ao gravar tracking do source_url (não-fatal):", e));
    }
  }

  // Só source_url — sem Graph.
  if (!sourceId || sourceId.startsWith("url:")) {
    return;
  }

  if (!accessToken) {
    await prisma.contact
      .update({
        where: { id: contactId },
        data: {
          adResolveStatus: "no_access",
          adResolveError: "accessToken indisponível",
          adResolvedAt: new Date(),
        },
      })
      .catch((e) => log.debug("falha ao gravar no_access (não-fatal):", e));
    return;
  }

  // Cache lookup
  const cached = await lookupCache(organizationId, sourceId).catch(() => null);
  if (cached) {
    const existing = await prisma.contact
      .findUnique({
        where: { id: contactId },
        select: {
          adResolvedId: true,
          adResolvedName: true,
          adResolvedAdsetId: true,
          adResolvedAdsetName: true,
          adResolvedCampaignId: true,
          adResolvedCampaignName: true,
          adUtmSource: true,
          adUtmMedium: true,
          adUtmCampaign: true,
          adUtmContent: true,
          adUtmTerm: true,
          utmId: true,
          utmReferrer: true,
          referrer: true,
          gclid: true,
          fbclid: true,
          googleClientId: true,
          ttadId: true,
          ttadName: true,
        },
      })
      .catch(() => null);
    await prisma.contact
      .update({
        where: { id: contactId },
        data: {
          ...trackingPatchFromResolved(cached, {
            fillEmptyOnly: (existing ?? {}) as Record<string, string | null>,
          }),
          adResolvedAt: new Date(),
          adResolveStatus: "ok",
          adResolveError: null,
        },
      })
      .catch((e) => log.debug("falha ao gravar resultado cache (não-fatal):", e));
    log.info(
      `Ad resolvido via cache — contato=${contactId} source=${sourceId} ad=${cached.adId}`,
    );
    return;
  }

  // Cache miss → Meta API (ad direto ou post→ad)
  const result =
    sourceType === "ad"
      ? await fetchAdById(sourceId, accessToken)
      : await fetchAdFromPost(sourceId, accessToken);

  const existing = await prisma.contact
    .findUnique({
      where: { id: contactId },
      select: {
        adResolvedId: true,
        adResolvedName: true,
        adResolvedAdsetId: true,
        adResolvedAdsetName: true,
        adResolvedCampaignId: true,
        adResolvedCampaignName: true,
        adUtmSource: true,
        adUtmMedium: true,
        adUtmCampaign: true,
        adUtmContent: true,
        adUtmTerm: true,
        utmId: true,
        utmReferrer: true,
        referrer: true,
        gclid: true,
        fbclid: true,
        googleClientId: true,
        ttadId: true,
        ttadName: true,
      },
    })
    .catch(() => null);

  // Se source_type=ad e a API falhou, ainda assim grava o ad_id conhecido.
  const fallbackAd: ResolvedAd | null =
    sourceType === "ad" && (!result.data || result.status !== "ok")
      ? {
          adId: sourceId,
          adName: null,
          adsetId: null,
          adsetName: null,
          campaignId: null,
          campaignName: null,
          ...EMPTY_TRACKING,
        }
      : null;

  const data = result.data ?? fallbackAd;

  await prisma.contact
    .update({
      where: { id: contactId },
      data: {
        ...trackingPatchFromResolved(data, {
          fillEmptyOnly: (existing ?? {}) as Record<string, string | null>,
        }),
        // Em source_type=ad sempre garante adResolvedId = sourceId
        ...(sourceType === "ad" && sourceId
          ? { adResolvedId: existing?.adResolvedId || sourceId }
          : {}),
        adResolvedAt: new Date(),
        adResolveStatus: result.status === "ok" || sourceType === "ad" ? "ok" : result.status,
        adResolveError: result.status === "ok" ? null : result.error,
      },
    })
    .catch((e) => log.error("Falha ao persistir resolução do ad:", e));

  if (result.status === "ok") {
    log.info(
      `Ad resolvido via Meta — contato=${contactId} type=${sourceType || "post"} source=${sourceId} ad=${data?.adId} utm_source=${data?.utmSource ?? "—"} campanha="${data?.campaignName ?? "—"}"`,
    );
  } else {
    log.warn(
      `Falha parcial ao resolver ad — contato=${contactId} type=${sourceType || "post"} source=${sourceId} status=${result.status} erro=${result.error ?? "—"}`,
    );
  }
}
