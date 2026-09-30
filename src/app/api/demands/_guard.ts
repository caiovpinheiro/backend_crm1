// Guard unificado em `@/lib/api/guards` (compartilhado com `team-chat/**`).
// Mantido como re-export para os imports relativos das rotas continuarem valendo.
export { denyUnless, isServiceError, jsonError } from "@/lib/api/guards";
