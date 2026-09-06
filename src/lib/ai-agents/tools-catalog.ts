/**
 * Catálogo de ferramentas (tools) que o agente pode invocar.
 *
 * A execução real vive em src/services/ai/tools/ — aqui só
 * descrevemos o que existe e em que categoria aparece, para o
 * wizard de criação. O id é o que vai pro AIAgentConfig.enabledTools
 * e também o nome com que o provider LLM chama a tool.
 */

export type ToolCategory = "crm" | "whatsapp" | "handoff";

export type ToolDescriptor = {
  id: string;
  label: string;
  description: string;
  category: ToolCategory;
  /// Arquétipos para os quais essa tool faz sentido como default
  /// (apenas informativo — o admin pode habilitar qualquer combinação).
  defaultForArchetypes: string[];
};

export const TOOLS_CATALOG: ToolDescriptor[] = [
  {
    id: "create_deal",
    label: "Criar deal",
    description:
      "Cria um novo deal no funil padrão, associado ao contato atual. Útil para SDR ao qualificar um lead novo.",
    category: "crm",
    defaultForArchetypes: ["SDR"],
  },
  {
    id: "move_stage",
    label: "Mover estágio",
    description:
      "Move o deal atual para outro estágio do funil. Útil para vendedor quando o lead avança (ex.: Proposta enviada → Negociação).",
    category: "crm",
    defaultForArchetypes: ["VENDEDOR"],
  },
  {
    id: "add_tag",
    label: "Adicionar tag",
    description:
      "Aplica uma ou mais tags ao contato/deal. Útil para segmentar leads por interesse ou canal.",
    category: "crm",
    defaultForArchetypes: ["SDR", "ATENDIMENTO", "VENDEDOR", "SUPORTE"],
  },
  {
    id: "create_activity",
    label: "Criar atividade",
    description:
      "Registra uma atividade/lembrete vinculada ao deal/contato (ex.: 'Ligar amanhã às 15h').",
    category: "crm",
    defaultForArchetypes: ["SDR", "ATENDIMENTO", "VENDEDOR", "SUPORTE"],
  },
  {
    id: "search_products",
    label: "Consultar catálogo de produtos",
    description:
      "Busca produtos/serviços/cursos por nome, SKU ou descrição. Retorna preço em BRL, características e campos personalizados. Fonte de verdade — sem isso o agente inventa valores.",
    category: "crm",
    defaultForArchetypes: ["SDR", "VENDEDOR"],
  },
  {
    id: "consultar_matricula",
    label: "Consultar matrícula do aluno",
    description:
      "Consulta os dados acadêmicos do aluno em conversa (curso, polo, série, situação da matrícula, ciclo) a partir do relatório de matriculados. Casa por telefone/e-mail do contato.",
    category: "crm",
    defaultForArchetypes: ["ATENDIMENTO", "SUPORTE"],
  },
  {
    id: "send_whatsapp_template",
    label: "Enviar template WhatsApp",
    description:
      "Envia um template aprovado pela Meta (ex.: envio de proposta formatada, confirmação de agendamento).",
    category: "whatsapp",
    defaultForArchetypes: ["VENDEDOR"],
  },
  {
    id: "transfer_to_department",
    label: "Rotear para departamento",
    description:
      "Classifica o caso e roteia a conversa para um departamento. Define o departamento usado pela Distribuição Inteligente.",
    category: "handoff",
    defaultForArchetypes: ["ATENDIMENTO", "SUPORTE"],
  },
  {
    id: "execute_distribution",
    label: "Executar distribuição",
    description:
      "Aciona a Distribuição Inteligente para atribuir a conversa ao consultor certo.",
    category: "handoff",
    defaultForArchetypes: ["ATENDIMENTO", "SUPORTE"],
  },
  {
    id: "transfer_to_human",
    label: "Transferir para humano",
    description:
      "Tira a conversa do agente de IA e atribui a um operador humano via fila de Distribuição. Usado sempre que o tema sair do escopo do agente.",
    category: "handoff",
    defaultForArchetypes: ["SDR", "ATENDIMENTO", "VENDEDOR", "SUPORTE"],
  },
  {
    id: "close_conversation",
    label: "Encerrar conversa (só IA)",
    description:
      "Encerra o ticket quando o contato pede encerramento e o atendimento foi somente da IA. Dispara a automação Encerramento.",
    category: "handoff",
    defaultForArchetypes: ["ATENDIMENTO", "SUPORTE"],
  },
];

export const TOOL_MAP: Record<string, ToolDescriptor> = TOOLS_CATALOG.reduce(
  (acc, t) => {
    acc[t.id] = t;
    return acc;
  },
  {} as Record<string, ToolDescriptor>,
);

export function toolsByCategory(): Record<ToolCategory, ToolDescriptor[]> {
  return TOOLS_CATALOG.reduce(
    (acc, t) => {
      acc[t.category] = acc[t.category] ?? [];
      acc[t.category].push(t);
      return acc;
    },
    {} as Record<ToolCategory, ToolDescriptor[]>,
  );
}
