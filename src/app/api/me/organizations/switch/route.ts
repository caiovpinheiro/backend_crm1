/**
 * POST /api/me/organizations/switch — prepara a troca da sessão para a
 * conta do MESMO e-mail em outra organização (ver `src/lib/auth/org-switch.ts`).
 *
 * Corpo: `{ organizationId, password?, mfaCode?, backupCode? }`.
 *
 *  - Vínculo vigente com a conta de destino → não pede senha.
 *  - Sem vínculo (primeira vez, ou um dos lados revogou sessões / trocou a
 *    senha) → exige a senha da conta de DESTINO e, se ela tiver MFA, o TOTP
 *    ou um código de backup. Lockout por e-mail igual ao do login. Validou →
 *    grava o vínculo.
 *
 * Sucesso: `{ ok: true, organization: { id, slug, name }, orgSwitch: { token, expiresInSec } }`.
 * NADA muda na sessão aqui: o cliente troca o ticket pelo cookie novo com
 * `update({ orgSwitch: token })` (callback `jwt`). Se ele não fizer isso, a
 * sessão atual segue intacta.
 *
 * Erros (`{ message, code }`, nunca 401 — 401 é reservado a sessão
 * inválida e faz o frontend deslogar):
 *  - 400 `invalid_request` / `same_organization`
 *  - 403 `switch_unavailable` (super-admin, conta de origem inelegível)
 *  - 404 `organization_unavailable` (sem conta elegível com este e-mail lá)
 *  - 403 `password_required` · `invalid_credentials` · `mfa_required` · `mfa_invalid`
 *  - 423 `account_locked` · 429 `rate_limited` · 500
 */
import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { verifyPasswordAndMfa } from "@/lib/auth/credential-check";
import {
  checkLockout,
  clearFailuresOnSuccess,
  recordLoginAttempt,
} from "@/lib/auth/lockout";
import {
  findEligibleTarget,
  hasCurrentLink,
  issueOrgSwitchTicket,
  loadSourceAccount,
  upsertLink,
} from "@/lib/auth/org-switch";
import { getLogger } from "@/lib/logger";
import { getClientIp, withRateLimit } from "@/lib/rate-limit";

const log = getLogger("api/me/organizations/switch");

export const dynamic = "force-dynamic";

type SwitchBody = {
  organizationId: string;
  password: string;
  mfaCode: string;
  backupCode: string;
};

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

async function readBody(request: Request): Promise<SwitchBody | null> {
  try {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null) return null;
    const rec = raw as Record<string, unknown>;
    const organizationId = str(rec.organizationId, 64).trim();
    if (!organizationId) return null;
    return {
      organizationId,
      // bcrypt só lê 72 bytes; o teto evita hash de corpo gigante.
      password: str(rec.password, 256),
      mfaCode: str(rec.mfaCode, 16).trim(),
      backupCode: str(rec.backupCode, 32).trim(),
    };
  } catch {
    return null;
  }
}

function fail(status: number, code: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ message, code }, { status, headers });
}

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const { user } = r.session;

  const rl = await withRateLimit({
    route: "me.organizations.switch",
    profile: "auth.org-switch",
    scope: "user",
    id: user.id,
  });
  if (!rl.ok) {
    return fail(429, "rate_limited", "Muitas tentativas. Aguarde um pouco e tente novamente.", rl.headers);
  }

  const body = await readBody(request);
  if (!body) return fail(400, "invalid_request", "Organização inválida.");
  if (body.organizationId === user.organizationId) {
    return fail(400, "same_organization", "Você já está nesta organização.");
  }

  try {
    const source = await loadSourceAccount(user.id);
    if (!source) {
      return fail(403, "switch_unavailable", "Esta conta não pode trocar de organização.");
    }
    const target = await findEligibleTarget(source, { organizationId: body.organizationId });
    if (!target) {
      return fail(404, "organization_unavailable", "Organização indisponível para esta conta.");
    }

    const linked = await hasCurrentLink(source, target);
    if (!linked) {
      if (!body.password) {
        return fail(
          403,
          "password_required",
          "Confirme a senha da sua conta nesta organização para vinculá-la.",
        );
      }

      const ip = getClientIp(request);
      const userAgent = request.headers.get("user-agent");
      const lock = await checkLockout(target.email);
      if (lock.locked) {
        await recordLoginAttempt({ email: target.email, userId: target.id, ip, userAgent, outcome: "locked" });
        return fail(
          423,
          "account_locked",
          "Conta temporariamente bloqueada por várias tentativas. Aguarde alguns minutos.",
          lock.retryAfterSec > 0 ? { "Retry-After": String(lock.retryAfterSec) } : undefined,
        );
      }

      const check = await verifyPasswordAndMfa(target, {
        password: body.password,
        mfaCode: body.mfaCode,
        backupCode: body.backupCode,
      });
      if (check !== "ok") {
        await recordLoginAttempt({
          email: target.email,
          userId: target.id,
          ip,
          userAgent,
          outcome: check === "bad_password" ? "bad_password" : check === "mfa_required" ? "mfa_required" : "bad_mfa",
        });
        if (check === "mfa_required") {
          return fail(403, "mfa_required", "Informe o código de autenticação (MFA) desta conta.");
        }
        if (check === "bad_mfa") {
          return fail(403, "mfa_invalid", "Código de autenticação (MFA) inválido.");
        }
        return fail(403, "invalid_credentials", "Senha incorreta.");
      }

      await recordLoginAttempt({ email: target.email, userId: target.id, ip, userAgent, outcome: "success" });
      await clearFailuresOnSuccess(target.email);
      await upsertLink(source, target);
    }

    const orgSwitch = await issueOrgSwitchTicket({
      fromUserId: source.id,
      sid: user.sid ?? null,
      toUserId: target.id,
    });

    return NextResponse.json({
      ok: true,
      linkedNow: !linked,
      organization: {
        id: target.organization.id,
        slug: target.organization.slug,
        name: target.organization.name,
      },
      orgSwitch,
    });
  } catch (err) {
    log.error({ err }, "[POST /api/me/organizations/switch] falhou");
    return fail(500, "internal_error", "Não foi possível trocar de organização. Tente novamente.");
  }
}
