/**
 * Logo do widget para visitante sem login (docs/decisoes/webchat-widget.md §9.14).
 *
 * `/api/storage` exige sessão em todos os buckets e continua assim. A imagem de
 * marca sai por `/api/public/webchat/logo?key=`, que resolve o arquivo pela config
 * do canal: o cliente nunca escolhe o arquivo, e só o logo em uso fica público.
 */
import { createHash } from "node:crypto";

import { WebchatConfigError } from "@/lib/webchat/config";
import { parseStoragePath } from "@/lib/storage/local";

const RASTER_FILE = /\.(?:jpe?g|png|webp|gif)$/i;

/** Parte de caminho de `/api/storage/...`, relativo ou em URL absoluta. */
function storagePathOf(value: string): string | null {
  if (value.startsWith("/api/storage/")) return value;
  try {
    const { pathname } = new URL(value);
    return pathname.startsWith("/api/storage/") ? pathname : null;
  } catch {
    return null;
  }
}

/**
 * Nome do arquivo quando `avatar` é imagem de marca desta organização.
 * `stored` diz se o valor aponta para o storage, de qualquer organização ou bucket.
 */
export function webchatLogoFileOf(
  avatar: string | null | undefined,
  organizationId: string,
): { stored: boolean; fileName: string | null } {
  const path = avatar?.trim() ? storagePathOf(avatar.trim()) : null;
  if (!path) return { stored: false, fileName: null };
  const ref = parseStoragePath(path);
  if (
    !ref ||
    ref.orgId !== organizationId ||
    ref.bucket !== "branding" ||
    !RASTER_FILE.test(ref.fileName)
  ) {
    return { stored: true, fileName: null };
  }
  return { stored: true, fileName: ref.fileName };
}

/**
 * O que o visitante recebe em `theme.avatarUrl`: imagem de marca vai pela rota
 * pública; outro caminho do storage vira `null`, porque daria 401 e revelaria o
 * caminho; o resto (URL https) segue como está. O `v` troca com o arquivo e fura o
 * cache sem expor o nome nem a organização.
 */
export function publicWebchatAvatarUrl(
  avatar: string | null,
  channel: { publicKey: string; organizationId: string },
): string | null {
  const { stored, fileName } = webchatLogoFileOf(avatar, channel.organizationId);
  if (!stored) return avatar;
  if (!fileName) return null;
  const version = createHash("sha256").update(fileName).digest("hex").slice(0, 12);
  return `/api/public/webchat/logo?key=${encodeURIComponent(channel.publicKey)}&v=${version}`;
}

/** Recusa gravar no canal o caminho de uma imagem que não é desta organização. */
export function assertWebchatLogoOfOrg(
  avatar: string | null | undefined,
  organizationId: string,
): void {
  const { stored, fileName } = webchatLogoFileOf(avatar, organizationId);
  if (stored && !fileName) {
    throw new WebchatConfigError("theme.avatarUrl aponta para uma imagem de outra organização.");
  }
}
