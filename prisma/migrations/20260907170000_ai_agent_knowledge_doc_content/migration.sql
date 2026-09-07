-- Texto integral do documento de conhecimento.
--
-- Ate aqui so guardavamos os chunks (com overlap), entao nao havia como
-- exibir nem editar o documento sem corromper o original. A coluna e
-- aditiva e nullable: docs antigos ficam NULL e a leitura remonta o texto
-- a partir dos chunks ate a primeira edicao.
ALTER TABLE "ai_agent_knowledge_docs" ADD COLUMN IF NOT EXISTS "content" TEXT;
