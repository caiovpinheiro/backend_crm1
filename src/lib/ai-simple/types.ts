/**
 * Tipos canônicos do motor simples de agentes de IA (v2).
 *
 * Sem termos de domínio acadêmico. Tudo vem da configuração do agente.
 */

export type SimpleStage =
  | "new"
  | "awaiting_identification"
  | "awaiting_confirmation"
  | "active";

export type SimpleActionType =
  | "create_deal"
  | "add_tag"
  | "create_activity"
  | "search_products"
  | "move_stage"
  | "send_whatsapp_template";

export type SimpleAction =
  | { type: "create_deal"; args: { title: string; value?: number; notes?: string } }
  | { type: "add_tag"; args: { tagName: string } }
  | { type: "create_activity"; args: { type: string; title: string; description?: string; scheduledAt?: string } }
  | { type: "search_products"; args: { query: string; type?: "PRODUCT" | "SERVICE"; limit?: number } }
  | { type: "move_stage"; args: { stageName: string; pipelineName?: string; reason?: string } }
  | { type: "send_whatsapp_template"; args: { templateName: string; languageCode?: string; bodyVariables?: string[] } };

export type SimpleHandoffTarget =
  | { kind: "department"; name: string }
  | { kind: "user"; userId: string }
  | { kind: "queue"; queue: string };

export type SimpleMode = {
  id: string;
  when: string;
  instructions: string;
};

export type SimpleConfig = {
  tone: string;
  rules: string;
  contextFields: {
    contact: string[];
    deal: string[];
  };
  confirmationMessage: string;
  onDealNotFound: "ask_identification" | "handoff";
  identificationMessage: string;
  knowledge: string;
  modes: SimpleMode[];
  allowedActions: SimpleActionType[];
  allowedFields: string[];
  handoffMessage: string;
  handoffQueue: string;
  historyLimit: number;
};

export type SimpleLLMOutput = {
  reply: string;
  confirmed: boolean | null;
  mode: string | null;
  actions: Array<{
    tool: SimpleActionType;
    args: Record<string, unknown>;
  }>;
  handoff: boolean;
  reason: string;
};

export type SimpleContext = {
  organizationId: string;
  conversationId: string;
  contactId: string;
  agentId: string;
  agentName: string;
  userMessage: string;
  turnId?: string | null;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  state: {
    stage: SimpleStage;
    mode: string | null;
    humanActive: boolean;
    identificationAttempts: number;
  };
  contact: Record<string, unknown> | null;
  deal: Record<string, unknown> | null;
};

export type SimpleResult = {
  reply: string | null;
  handoff: boolean;
  actionsExecuted: SimpleAction[];
  actionsDiscarded: SimpleAction[];
  nextStage: SimpleStage;
  nextMode: string | null;
  logId: string;
};
