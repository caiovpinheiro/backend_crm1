# Preço do produto atualizado nos cards + edição só para Admin/Gestor

## Por quê
O card (`DealProduct`) copia `unitPrice`/`discount` quando o produto é adicionado. Depois da
atualização de valores de 18/11, cards abertos ficaram com preço antigo (ex.: #103178 com
R$ 199,90 em vez de R$ 210,50, 30%). Além disso, qualquer papel com `deal:edit` (Operador,
Suporte) consegue mudar preço/desconto/quantidade no card, e a página de produtos mostra os
botões de edição para quem não pode salvar.

## Objetivos
1. Ao salvar um produto com preço/desconto de cota alterado, atualizar os itens dos cards
   **abertos** que ainda estão com o valor antigo daquela cota; recalcular `deal.value` e
   registrar evento na timeline.
2. Cards **ganhos e perdidos nunca mudam** (consulta histórica). Item com valor diferente do
   antigo também não muda (foi ajustado de propósito).
3. Correção única dos cards abertos já defasados, com relatório (dry-run) antes de aplicar.
4. Permissão nova `product:edit_deal_price` ("Editar preço/desconto do produto no negócio"),
   dada a quem tem `product:edit` (Administrador via `*`, Gestor). Sem ela, no card:
   adicionar, enviar, remover e trocar entre cotas cadastradas continuam liberados; digitar
   preço, desconto ou quantidade livres é recusado (403) e o lápis de edição livre some.
5. Página de produtos: esconder Novo/Editar/Excluir/Ativar-Desativar para quem não tem as
   permissões `product:create/edit/delete` (o servidor já recusa).

## Não-objetivos
- Ofertas por unidade (`ProductOffer`) não propagam nesta entrega.
- Cotas de desconto (`DiscountQuota`, `priceFinalSnapshot`) não mudam.

## Abordagens
- **Escolhida — propagar ao salvar o produto**: automático, preserva histórico e ajustes manuais.
- Botão manual "atualizar cards": depende de alguém lembrar; foi a causa do problema.
- Card lê preço ao vivo: alteraria vendas fechadas e apagaria ajustes. Descartada.

## Regras de casamento (decisão do builder)
- Curso com `pricingOptions`: cota antiga ↔ nova pelo mesmo `channel` (quando único), senão
  pela mesma posição. Se preço ou desconto mudou, atualiza itens com
  `unitPrice == antigo.price && discount == antigo.discountPercent` em deals `OPEN`.
- Produto sem cotas: `product.price` antigo → novo, itens com `unitPrice == antigo`
  (desconto mantido).
- "Cota cadastrada" (para quem não tem a permissão nova): par (preço, desconto) igual a uma
  `pricingOption` atual, ou o preço base/oferta padrão do POST.
- Correção única: item de deal `OPEN` cujo par não bate com nenhuma cota atual e cujo
  desconto bate com exatamente uma cota → passa para o preço dessa cota. Roda em dry-run por
  padrão; `--apply` grava.
