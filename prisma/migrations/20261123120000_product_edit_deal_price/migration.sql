-- Editar preço/desconto/quantidade do produto dentro do negócio passa a exigir
-- `product:edit_deal_price`. Quem já edita o cadastro de produtos (Gestor e
-- papéis com `product:edit`) recebe a permissão nova; ADMIN já tem `*`.
UPDATE "roles"
SET "permissions" = array_append("permissions", 'product:edit_deal_price')
WHERE NOT ('product:edit_deal_price' = ANY("permissions"))
  AND NOT ('*' = ANY("permissions"))
  AND 'product:edit' = ANY("permissions");
