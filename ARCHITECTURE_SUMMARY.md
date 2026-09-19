# Arquitetura do Sistema de Team Chat e Work Items

## Visão Geral

O sistema de Team Chat é um módulo do CRM que permite comunicação em tempo real entre membros da equipe, com funcionalidades de mensagens diretas, grupos, canais e itens de trabalho (work items) como checklists, atas, reuniões, etc.

## Componentes Principais

### Backend (Node.js/Next.js API Routes)

1. **Models do Prisma**:
   - `TeamChatRoom`: Representa salas de chat (DM, GROUP, CHANNEL)
   - `TeamChatMember`: Membros das salas
   - `TeamChatMessage`: Mensagens nas salas
   - `TeamChatNote`: Notas pessoais nas salas
   - `TeamChatWorkItem`: Itens de trabalho (checklists, atas, reuniões)
   - `TeamChatWorkItemEntry`: Entradas/items individuais dos work items
   - `TeamChatWorkItemEntryRevision`: Histórico de revisões
   - `TeamChatMessageAnchor`: Âncoras de mensagens para registros CRM
   - `TeamChatMessageForward`: Encaminhamentos de mensagens

2. **Services**:
   - `team-chat.ts`: Lógica principal do chat (mensagens, salas, membros)
   - `team-chat-work-items.ts`: Lógica dos work items (criação, edição, exclusão)
   - `team-chat-records.ts`: Integração com registros do CRM (negócios, contatos, atendimentos)

3. **API Routes**:
   - `/api/team-chat/rooms/*`: Operações com salas
   - `/api/team-chat/work-items/*`: Operações com work items
   - `/api/team-chat/colleagues`: Listagem de colegas
   - `/api/team-chat/destinations`: Destinos para compartilhamento
   - `/api/team-chat/records/*`: Operações com registros do CRM

### Frontend (React/Next.js)

1. **Componentes principais**:
   - `WorkItemCard.tsx`: Visualização de work items
   - `WorkItemDialogs.tsx`: Diálogos de criação/edição de work items
   - `MyPendencies.tsx`: Painel de pendências do usuário
   - `TopicAssigneePicker.tsx`: Seletor de responsável por tópico

2. **Hooks**:
   - `hooks.ts`: Custom hooks para gerenciamento de estado e operações do chat

3. **API Client**:
   - `api.ts`: Funções para chamadas às APIs do backend

## Fluxo de Dados

1. **Criação de Work Item**:
   - Usuário cria work item através do diálogo
   - Frontend chama `createTeamChatWorkItem` 
   - API route `/api/team-chat/work-items` processa a requisição
   - Service `team-chat-work-items.ts` cria o registro no banco
   - Se tiver calendário, sincroniza com o módulo de atividades
   - Retorna o work item criado
   - Frontend atualiza a interface

2. **Atualização em Tempo Real**:
   - Utiliza Server-Sent Events (SSE) através do `sseBus`
   - Eventos como `team_chat_work_item_updated` são publicados
   - Frontend escuta esses eventos e atualiza a interface

3. **Integração com CRM**:
   - Work items podem ser vinculados a registros do CRM
   - O serviço `team-chat-records.ts` resolve e valida acesso aos registros
   - Âncoras são criadas para vincular mensagens a registros

## Funcionalidades dos Work Items

1. **Tipos**:
   - Checklist
   - Ata
   - Pauta
   - Feedback
   - Reunião

2. **Características**:
   - Títulos e descrições
   - Entradas/items individuais com status (aberto/concluído)
   - Atribuição de responsável
   - Prazos
   - Visibilidade (canal, privado, participantes)
   - Integração com calendário para reuniões e tarefas
   - Vinculação a registros do CRM (negócios, contatos, atendimentos)

3. **Operações**:
   - Criação
   - Edição
   - Exclusão
   - Adição/remoção de entradas
   - Atualização de status das entradas
   - Geração de checklist a partir de reunião
   - Extração de itens a partir de texto

## Considerações de Segurança

1. **Permissões**:
   - Verificação de acesso a salas
   - Validação de permissões para operações CRUD
   - Controle de visibilidade baseado em participantes

2. **Validações**:
   - Validação de entrada com Zod
   - Verificação de associação a salas
   - Validação de URLs de anexos