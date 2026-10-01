// Guard unificado em `@/lib/api/guards` (compartilhado com `demands/**`).
// Mantido como re-export para os imports relativos das rotas continuarem valendo.
export { denyUnless, isServiceError, jsonError, viewerOf } from "@/lib/api/guards";
