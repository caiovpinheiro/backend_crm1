/**
 * `POST /api/deals/:id/tags`: quando dispara o gatilho `tag_added`.
 *
 * Tag nova sempre dispara. Tag que o negócio já tinha só dispara quando quem
 * pede é uma integração (token de API, n8n): para ela, aplicar a tag é o
 * comando "rode a automação desta tag". Antes a tag esquecida no negócio
 * (aplicada semanas antes e nunca removida) fazia o pedido virar um "ok" sem
 * efeito e o fluxo parava sem erro — DNAWORK #62742, "ver outras opções" desde
 * 29/09, n8n reaplicou em 14/11 e a automação não rodou.
 *
 * Pessoa na tela não redispara: clicar de novo numa tag que já está no card
 * não deve reenviar mensagens.
 */
export function shouldFireDealTagAdded(input: { alreadyHadTag: boolean; viaIntegration: boolean }): boolean {
  return !input.alreadyHadTag || input.viaIntegration;
}
