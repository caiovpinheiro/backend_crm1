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
 * `ac=2` (só a janela; o cliente conecta em "Solicite ajuda") foi testado no
 * DEV: o dispositivo entra no grupo, mas o MeshCentral não o marca online e o
 * Controlar fica bloqueado. Custo do `ac=3`: o Assistant deixado aberto
 * depois de Encerrar reconecta, e o MeshCentral restaura o grupo apagado.
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
/** Para comandos cuja resposta de sucesso vem sem `responseid` (ex.: `deviceShares`): casa pela ação. */
type Expect = { action: string; match: (m: MeshMessage) => boolean };
type Send = (cmd: Record<string, unknown>, expect?: Expect) => Promise<MeshMessage>;
type Pending = {
  resolve: (m: MeshMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  expect?: Expect;
};

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
    let key = id && pending.has(id) ? id : null;
    if (!key && !id) {
      for (const [k, w] of pending) {
        if (w.expect && msg.action === w.expect.action && w.expect.match(msg)) {
          key = k;
          break;
        }
      }
    }
    const p = key ? pending.get(key) : undefined;
    if (key && p) {
      clearTimeout(p.timer);
      pending.delete(key);
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

  const send: Send = (cmd, expect) =>
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
      pending.set(responseid, { resolve, reject, timer, expect });
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

/**
 * Encerra a sessão no MeshCentral: corta o acesso na hora e apaga o grupo.
 *
 * `deletemesh` sozinho não corta nada: o MeshCentral só marca o grupo como
 * apagado, o Assistant segue conectado e o console já aberto continua vendo a
 * tela (o link de controle guarda o grupo em `xmeshid`, fora da limpeza do
 * grupo). Por isso, nesta ordem:
 * 1. revoga os links de controle (`removeDeviceShare`) — o relay fecha o console aberto;
 * 2. remove os dispositivos (`removedevices`) — o servidor fecha a conexão do
 *    Assistant, que derruba os túneis de tela;
 * 3. apaga o grupo (`deletemesh`).
 * Um passo que falha não impede os seguintes; a primeira falha sobe no fim.
 */
export async function teardownSessionGroup(meshId: string): Promise<void> {
  await withControl(async (send) => {
    let firstError: unknown = null;
    const step = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        firstError ??= err;
      }
    };

    let nodeIds: string[] = [];
    await step(async () => {
      nodeIds = (await queryGroupNodes(send, meshId)).map((n) => n.nodeId);
    });
    for (const nodeId of nodeIds) {
      await step(async () => {
        // A lista de links volta sem `responseid` quando dá certo.
        const res = await send(
          { action: "deviceShares", nodeid: nodeId },
          { action: "deviceShares", match: (m) => m.nodeid === nodeId },
        );
        ensureOk(res, "Falha ao listar os links de controle no MeshCentral");
        const shares = Array.isArray(res.deviceShares) ? (res.deviceShares as Array<{ publicid?: unknown }>) : [];
        for (const share of shares) {
          if (typeof share.publicid !== "string") continue;
          const removed = await send({ action: "removeDeviceShare", nodeid: nodeId, publicid: share.publicid });
          ensureOk(removed, "Falha ao revogar o link de controle no MeshCentral");
        }
      });
    }
    // Um dispositivo por vez: a resposta só sai depois que a conexão dele caiu,
    // então o `deletemesh` não corre na frente de uma remoção ainda pendente.
    for (const nodeId of nodeIds) {
      await step(async () => {
        const res = await send({ action: "removedevices", nodeids: [nodeId] });
        ensureOk(res, "Falha ao desconectar o dispositivo no MeshCentral");
      });
    }
    await step(async () => {
      const res = await send({ action: "deletemesh", meshid: meshId });
      ensureOk(res, "Falha ao apagar o grupo no MeshCentral");
    });
    if (firstError) throw firstError;
  });
}

export type MeshNode = { nodeId: string; name: string; online: boolean };

/** Dispositivos do grupo. `online` = agente/Assistant conectado agora (`conn & 1`). */
export async function listGroupNodes(meshId: string): Promise<MeshNode[]> {
  return withControl((send) => queryGroupNodes(send, meshId));
}

async function queryGroupNodes(send: Send, meshId: string): Promise<MeshNode[]> {
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
