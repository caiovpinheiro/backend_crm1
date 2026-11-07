/**
 * Cliente mínimo do MeshCentral — o motor do suporte remoto.
 *
 * Fala o mesmo protocolo do `meshctrl`: WebSocket em `/control.ashx`, auth
 * por `x-meshauth` (base64(usuário),base64(senha)) e comandos JSON casados
 * pelo `responseid`. Usa a conta de serviço do CRM, nunca a de um humano.
 *
 * Env:
 *   MESHCENTRAL_URL           onde a API alcança o servidor (ex.: https://localhost:8443)
 *   MESHCENTRAL_PUBLIC_URL    base dos links que o cliente abre (default: MESHCENTRAL_URL)
 *   MESHCENTRAL_USER / MESHCENTRAL_PASSWORD   conta de serviço (ex.: crm-svc)
 *   MESHCENTRAL_TLS_INSECURE  "true" aceita cert self-signed — só fora de produção
 */
import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import { getLogger } from "@/lib/logger";

const log = getLogger("meshcentral");

const COMMAND_TIMEOUT_MS = 15_000;

// Bits de consentimento do MeshCentral (mesma tabela do `meshctrl`).
const CONSENT_DESKTOP_PROMPT = 0x0008;
const CONSENT_TERMINAL_PROMPT = 0x0010;
const CONSENT_FILES_PROMPT = 0x0020;
const CONSENT_DESKTOP_TOOLBAR = 0x0040;
/** Grupo da sessão: todo acesso pede permissão ao cliente + barra visível p/ ele desconectar. */
const GROUP_CONSENT =
  CONSENT_DESKTOP_PROMPT | CONSENT_TERMINAL_PROMPT | CONSENT_FILES_PROMPT | CONSENT_DESKTOP_TOOLBAR;
/** Link de controle: só a tela (p=2), pedindo permissão + barra. */
const SHARE_DESKTOP = 2;
const SHARE_CONSENT = CONSENT_DESKTOP_PROMPT | CONSENT_DESKTOP_TOOLBAR;
/** Tipo "MeshCentral Assistant (Windows)" em `/meshagents` — roda sem instalar. */
const ASSISTANT_WINDOWS_AGENT_ID = 10006;
/**
 * Flags `AutoConnect` que o MeshCentral grava no `.msh` do Assistant (`&ac=`):
 * bit 1 = conecta sozinho ao abrir; bit 2 = janela normal em vez de ícone na
 * bandeja. Sem elas o Assistant abre escondido na bandeja e fica esperando o
 * cliente mandar conectar — para quem clicou no `.exe`, "nada acontece".
 */
const ASSISTANT_AUTOCONNECT_FLAGS = 3;

export type MeshCentralErrorCode = "NOT_CONFIGURED" | "UNAVAILABLE" | "REJECTED";

export class MeshCentralError extends Error {
  constructor(
    message: string,
    readonly code: MeshCentralErrorCode,
  ) {
    super(message);
    this.name = "MeshCentralError";
  }
}

type MeshConfig = {
  baseUrl: string;
  publicUrl: string;
  user: string;
  password: string;
  insecureTls: boolean;
};

function readConfig(): MeshConfig {
  const baseUrl = process.env.MESHCENTRAL_URL?.trim().replace(/\/+$/, "");
  const user = process.env.MESHCENTRAL_USER?.trim();
  const password = process.env.MESHCENTRAL_PASSWORD ?? "";
  if (!baseUrl || !user || !password) {
    throw new MeshCentralError("Suporte remoto não configurado neste ambiente.", "NOT_CONFIGURED");
  }
  const publicUrl = (process.env.MESHCENTRAL_PUBLIC_URL?.trim() || baseUrl).replace(/\/+$/, "");
  const insecureTls =
    process.env.MESHCENTRAL_TLS_INSECURE === "true" && process.env.NODE_ENV !== "production";
  return { baseUrl, publicUrl, user, password, insecureTls };
}

type MeshMessage = Record<string, unknown> & { action?: unknown; responseid?: unknown; result?: unknown };
type Send = (cmd: Record<string, unknown>) => Promise<MeshMessage>;
type Pending = { resolve: (m: MeshMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** Abre uma conexão de controle, executa `fn` e fecha. Uma conexão por operação. */
async function withControl<T>(fn: (send: Send) => Promise<T>): Promise<T> {
  const cfg = readConfig();
  const wsUrl = `${cfg.baseUrl.replace(/^http/i, "ws")}/control.ashx`;
  const meshAuth = `${Buffer.from(cfg.user).toString("base64")},${Buffer.from(cfg.password).toString("base64")}`;
  const ws = new WebSocket(wsUrl, {
    headers: { "x-meshauth": meshAuth },
    rejectUnauthorized: !cfg.insecureTls,
    handshakeTimeout: COMMAND_TIMEOUT_MS,
  });

  const pending = new Map<string, Pending>();
  let failure: MeshCentralError | null = null;
  const failAll = (err: MeshCentralError) => {
    failure ??= err;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
      pending.delete(id);
    }
  };

  ws.on("message", (raw) => {
    let msg: MeshMessage;
    try {
      msg = JSON.parse(raw.toString()) as MeshMessage;
    } catch {
      return;
    }
    if (msg.action === "close") {
      // Ex.: { action: "close", cause: "noauth" } — credencial errada/conta bloqueada.
      const cause = String(msg.cause ?? msg.msg ?? "close");
      failAll(new MeshCentralError(`MeshCentral recusou a conexão (${cause}).`, "REJECTED"));
      ws.terminate();
      return;
    }
    const id = typeof msg.responseid === "string" ? msg.responseid : null;
    const p = id ? pending.get(id) : undefined;
    if (id && p) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(msg);
    }
  });
  ws.on("error", (err) =>
    failAll(new MeshCentralError(`MeshCentral indisponível: ${err.message}`, "UNAVAILABLE")),
  );
  ws.on("close", () =>
    failAll(new MeshCentralError("Conexão com o MeshCentral encerrada.", "UNAVAILABLE")),
  );

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) =>
      reject(new MeshCentralError(`MeshCentral indisponível: ${err.message}`, "UNAVAILABLE")),
    );
  });

  const send: Send = (cmd) =>
    new Promise<MeshMessage>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const responseid = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(responseid);
        reject(new MeshCentralError("MeshCentral não respondeu a tempo.", "UNAVAILABLE"));
      }, COMMAND_TIMEOUT_MS);
      pending.set(responseid, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...cmd, responseid }));
    });

  try {
    return await fn(send);
  } finally {
    ws.removeAllListeners("close");
    ws.close();
  }
}

/** `result` ausente ou "ok"/"OK" = sucesso; qualquer outro texto é recusa do servidor. */
function ensureOk(msg: MeshMessage, what: string): void {
  if (typeof msg.result === "string" && msg.result.toLowerCase() !== "ok") {
    throw new MeshCentralError(`${what}: ${msg.result}`, "REJECTED");
  }
}

/** Cria o grupo exclusivo de uma sessão (agentes de software, consentimento obrigatório). */
export async function createSessionGroup(name: string, desc: string): Promise<string> {
  return withControl(async (send) => {
    const res = await send({ action: "createmesh", meshname: name, meshtype: 2, desc, consent: GROUP_CONSENT });
    ensureOk(res, "Falha ao criar o grupo no MeshCentral");
    if (typeof res.meshid !== "string") {
      throw new MeshCentralError("MeshCentral não devolveu o id do grupo.", "REJECTED");
    }
    return res.meshid;
  });
}

/** Apaga o grupo — remove junto o dispositivo do cliente. Nada da sessão fica no servidor. */
export async function deleteSessionGroup(meshId: string): Promise<void> {
  await withControl(async (send) => {
    const res = await send({ action: "deletemesh", meshid: meshId });
    ensureOk(res, "Falha ao apagar o grupo no MeshCentral");
  });
}

export type MeshNode = { nodeId: string; name: string; online: boolean };

/** Dispositivos do grupo. `online` = agente/Assistant conectado agora (`conn & 1`). */
export async function listGroupNodes(meshId: string): Promise<MeshNode[]> {
  return withControl(async (send) => {
    const res = await send({ action: "nodes", meshid: meshId });
    ensureOk(res, "Falha ao listar dispositivos no MeshCentral");
    const byMesh = (res.nodes ?? {}) as Record<string, Array<{ _id?: unknown; name?: unknown; conn?: unknown }>>;
    // Pedimos um único grupo: tudo que voltar pertence a ele.
    return Object.values(byMesh)
      .flat()
      .filter((n): n is { _id: string; name?: unknown; conn?: unknown } => typeof n._id === "string")
      .map((n) => ({
        nodeId: n._id,
        name: typeof n.name === "string" && n.name.trim() ? n.name : "Dispositivo do cliente",
        online: ((typeof n.conn === "number" ? n.conn : 0) & 1) !== 0,
      }));
  });
}

/**
 * Link de controle da tela, com prazo. Quem abre não precisa de conta no
 * MeshCentral; o cliente recebe o pedido de permissão e vê a barra de sessão.
 */
export async function createControlLink(nodeId: string, guestName: string, minutes: number): Promise<string> {
  return withControl(async (send) => {
    const start = Math.floor(Date.now() / 1000);
    const res = await send({
      action: "createDeviceShareLink",
      nodeid: nodeId,
      guestname: guestName,
      p: SHARE_DESKTOP,
      consent: SHARE_CONSENT,
      start,
      end: start + Math.max(1, Math.floor(minutes)) * 60,
      viewOnly: false,
    });
    ensureOk(res, "Falha ao gerar o link de controle");
    if (typeof res.url !== "string") {
      throw new MeshCentralError("MeshCentral não devolveu o link de controle.", "REJECTED");
    }
    log.info(`Link de controle gerado (node=${nodeId}, ${minutes} min).`);
    return res.url;
  });
}

/** Link direto do Assistant (Windows) já configurado p/ o grupo: 1 arquivo, sem instalar, conecta ao abrir. */
export function assistantDownloadUrl(meshId: string): string {
  const { publicUrl } = readConfig();
  // `mesh//<id>` → `<id>` (ids do MeshCentral usam @ e $ no lugar de + e /).
  const shortId = meshId.split("/").pop() ?? meshId;
  return `${publicUrl}/meshagents?id=${ASSISTANT_WINDOWS_AGENT_ID}&meshid=${encodeURIComponent(shortId)}&ac=${ASSISTANT_AUTOCONNECT_FLAGS}`;
}
