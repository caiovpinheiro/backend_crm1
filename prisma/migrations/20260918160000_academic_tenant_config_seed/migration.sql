-- Config de tenant do pack acadêmico sai do código/env e passa a viver em
-- `organization_settings` (prefixo `vertical.academic.`), por organização.
--
-- Migration de DADOS: não há mudança de schema (a tabela key/value já
-- existe). Preenche a org `teste-dev` com exatamente os valores que estavam
-- hardcoded antes do P1-A, para o comportamento dela não mudar. Qualquer
-- outra org fica sem config e o pack omite os trechos.
--
-- `ON CONFLICT DO NOTHING`: se o admin já editou a chave na tela, o valor
-- dele vence.

INSERT INTO "organization_settings" ("id", "organizationId", "key", "value", "updatedAt")
SELECT gen_random_uuid()::text, o."id", s."key", s."value", NOW()
FROM "organizations" o
CROSS JOIN (
  VALUES
    ('vertical.academic.institutionName', 'Cruzeiro do Sul'),
    ('vertical.academic.portalUrl', 'https://novoportal.cruzeirodosul.edu.br/'),
    ('vertical.academic.inauguralCertificateUrl', 'https://app.cruzeiroead.com.br/'),
    ('vertical.academic.firstAccessVideoUrl', 'https://youtu.be/vFJP7a1EMsU'),
    ('vertical.academic.appAndroidUrl', 'https://play.google.com/store/apps/details?id=br.com.cruzeirodosulvirtual'),
    ('vertical.academic.appIosUrl', 'https://apps.apple.com/us/app/duda-aplicativo-do-estudante/id6451416655'),
    ('vertical.academic.allowedUrlSuffixes', 'cruzeirodosul.edu.br,cruzeirodosulvirtual.com.br,cruzeiroead.com.br'),
    ('vertical.academic.poloList', '*Polo Barra Funda – Rua do Bosque, 1621, Loja 12 - Térreo
10 minutos do Metrô - Estação Palmeiras Barra Funda- Linha 3 - Vermelha

*Polo Vila Prudente 2- Rua Ibitirama, 404
5 minutos do terminal de ônibus - Estação Vila Prudente – Linha 2-Verde

*Polo Morumbi - Rua Amélia Corrêa Fontes Guimarães, 34
10 minutos do Metrô São Paulo - Morumbi - Linha Amarela - Seguir na Av Francisco Morato e virar na Rua Três Irmãos do Hospital Lefort

*Polo Taboão da Serra Centro - Av. Jovina de Carvalho Dau, 216 –  Parque Santos Dumont
Centro de Taboão da Serra - Em frente a Delegacia

*Polo Taboão da Serra Jardim Mituizi - Osmar Antônio Silva 128
Altura do número 2800 da Av. Kizaemon Takeuti, em frente ao colégio Dom Pedro

*Polo Sapopemba -  Av. Vila Ema, 6121 - Sapopemba
Travessa da Av. Sapopemba – Altura do número 7737

*Polo Freguesia do Ó – Rua Manuel Madruga, 82 - Freguesia do Ó
Travessa da Av. Itaberaba – Altura no número 591

*Polo Ibirapuera  Av. Iraí 79, 21B Moema
Próximo a estação Eucaliptos

*Polo Campinas R. Armando Frederico Renganeschi, 276 - Ouro Verde (Jardim Cristina) Campinas - SP, 13054-000

*Polo Capivari: Rua Padre Haroldo, 746 - Centro, Capivari - SP, 13360-000

*Polo Itapira: R. 15 de Novembro, 366 - Centro, Itapira - SP, 13970-270'),
    ('vertical.academic.deptRoster', '[
  {"email":"wesley.guerreiro@cruzeiroead.com.br","depts":["acolhimento","retencao"]},
  {"email":"danubia.sousa@cruzeiroead.com.br","depts":["acolhimento","retencao"]},
  {"email":"marilia.nascimento@cruzeiroead.com.br","depts":["acolhimento"]},
  {"email":"beatriz.andrade@cruzeiroead.com.br","depts":["atendimento"]},
  {"email":"breno.silva@cruzeiroead.com.br","depts":["atendimento"]},
  {"email":"erica.ferreira@cruzeiroead.com.br","depts":["atendimento"]},
  {"email":"emanuel.felipe@cruzeiroead.com.br","depts":["atendimento"]},
  {"email":"felipe.guimaraes@cruzeiroead.com.br","depts":["atendimento"]},
  {"email":"joyce.pereira@cruzeiroead.com.br","depts":["atendimento"]},
  {"email":"julia.rodrigues@cruzeiroead.com.br","depts":["atendimento"]},
  {"email":"mariana.vecoso@cruzeiroead.com.br","depts":["atendimento"]}
]')
) AS s("key", "value")
WHERE o."slug" = 'teste-dev'
ON CONFLICT ("organizationId", "key") DO NOTHING;
