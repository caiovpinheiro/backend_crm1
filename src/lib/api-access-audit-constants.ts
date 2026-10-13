/** Headers injetados no middleware (Edge) — só strings, sem deps Node. */

export const CRM_API_PATH_HEADER = "x-crm-api-path";
export const CRM_HTTP_METHOD_HEADER = "x-crm-http-method";
export const CRM_REQUEST_ID_HEADER = "x-crm-request-id";
/**
 * "1" quando o GET traz `search`/`q` preenchido (classe de custo `heavy_read`,
 * ver `api-cost-class.ts`). Só o flag — o termo buscado não viaja em header.
 */
export const CRM_API_SEARCH_HEADER = "x-crm-api-search";
