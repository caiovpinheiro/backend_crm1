/**
 * Campos de atribuição / UTM do contato (Informação rastreada).
 * Usado em import, export e filtros — nomes de coluna estáveis.
 */

export const CONTACT_TRACKING_KEYS = [
  "adUtmSource",
  "adUtmMedium",
  "adUtmCampaign",
  "adUtmContent",
  "adUtmTerm",
  "utmId",
  "utmReferrer",
  "referrer",
  "gclid",
  "fbclid",
  "googleClientId",
  "ttadId",
  "ttadName",
] as const;

export type ContactTrackingKey = (typeof CONTACT_TRACKING_KEYS)[number];

/** Cabeçalhos CSV (import) → chave Prisma. */
export const TRACKING_IMPORT_ALIASES: Record<string, ContactTrackingKey> = {
  utm_source: "adUtmSource",
  ad_utm_source: "adUtmSource",
  utm_medium: "adUtmMedium",
  ad_utm_medium: "adUtmMedium",
  utm_campaign: "adUtmCampaign",
  ad_utm_campaign: "adUtmCampaign",
  utm_content: "adUtmContent",
  ad_utm_content: "adUtmContent",
  utm_term: "adUtmTerm",
  ad_utm_term: "adUtmTerm",
  utm_id: "utmId",
  utm_referrer: "utmReferrer",
  referrer: "referrer",
  gclid: "gclid",
  fbclid: "fbclid",
  gclientid: "googleClientId",
  google_client_id: "googleClientId",
  ttad_id: "ttadId",
  ttad_name: "ttadName",
};

/** Colunas de export (PT-BR / Kommo-friendly). */
export const TRACKING_EXPORT_COLUMNS: Array<{
  header: string;
  key: ContactTrackingKey;
}> = [
  { header: "utm_source", key: "adUtmSource" },
  { header: "utm_medium", key: "adUtmMedium" },
  { header: "utm_campaign", key: "adUtmCampaign" },
  { header: "utm_content", key: "adUtmContent" },
  { header: "utm_term", key: "adUtmTerm" },
  { header: "utm_id", key: "utmId" },
  { header: "utm_referrer", key: "utmReferrer" },
  { header: "referrer", key: "referrer" },
  { header: "gclid", key: "gclid" },
  { header: "fbclid", key: "fbclid" },
  { header: "gclientid", key: "googleClientId" },
  { header: "ttad_id", key: "ttadId" },
  { header: "ttad_name", key: "ttadName" },
];

export function pickTrackingFromImportRow(
  row: Record<string, string>,
): Partial<Record<ContactTrackingKey, string>> {
  const out: Partial<Record<ContactTrackingKey, string>> = {};
  for (const [header, key] of Object.entries(TRACKING_IMPORT_ALIASES)) {
    const raw = row[header]?.trim();
    if (raw && out[key] === undefined) out[key] = raw;
  }
  return out;
}
