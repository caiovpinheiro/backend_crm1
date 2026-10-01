import { execFile, execFileSync } from "child_process";
import { existsSync } from "fs";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import os from "os";
import path from "path";

import {
  isOggOpus,
  muxOggOpus,
  oggOpusChannels,
  repacketizeOggOpusToCode3,
} from "@/lib/ogg-opus-ptt";
import { demuxWebmOpus } from "@/lib/webm-opus";
import { getLogger } from "@/lib/logger";

const log = getLogger("audio-convert");

/** MIME oficial da Meta para OGG/Opus. `audio/ogg` sem codecs é rejeitado (131053). */
export const WHATSAPP_VOICE_MIME = "audio/ogg; codecs=opus";
/** Limite Cloud API para áudio. */
export const WHATSAPP_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
/** Limite Cloud API para vídeo (mesmo teto de 16 MB). */
export const WHATSAPP_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
export const WHATSAPP_VIDEO_TOO_LARGE_MESSAGE =
  "Vídeo acima do limite de 16 MB da WhatsApp Cloud API. Compacte o arquivo ou envie um vídeo menor.";

function resolveFFmpeg(): string {
  // Preferimos o ffmpeg DO SISTEMA (apt-get install ffmpeg) ao binário do
  // `ffmpeg-static`. Motivo: o pacote npm baixa um build minimalista que
  // frequentemente não inclui `libopus`/`libmp3lame`, fazendo as estratégias
  // de transcode falharem silenciosamente. O ffmpeg do Debian é completo,
  // estável e tem todos os codecs necessários (Opus pra PTT, MP3 pra
  // download universal). Mantemos `ffmpeg-static` só como último recurso
  // pra ambientes onde ffmpeg não pôde ser instalado (ex.: Lambda).
  try {
    execFileSync("ffmpeg", ["-version"], { timeout: 5000, stdio: "pipe" });
    log.info("[audio-convert] Usando ffmpeg do sistema (PATH)");
    return "ffmpeg";
  } catch { /* not in PATH, try static */ }

  try {
    const staticBin = require("ffmpeg-static") as string;
    if (staticBin && existsSync(staticBin)) {
      log.info({ staticBin }, "[audio-convert] Usando ffmpeg-static (fallback)");
      return staticBin;
    }
  } catch { /* ffmpeg-static not available */ }

  log.warn("[audio-convert] ffmpeg nao encontrado nem no PATH nem via ffmpeg-static");
  return "ffmpeg";
}

let _ffmpeg: string | undefined;
function getFFmpeg(): string {
  if (!_ffmpeg) _ffmpeg = resolveFFmpeg();
  return _ffmpeg;
}

export type FFmpegCapabilities = {
  available: boolean;
  bin: string;
  /** `libopus` presente na lista de encoders — obrigatório para transcodar PTT. */
  libopus: boolean;
  libmp3lame: boolean;
  /** Encoder `aac` nativo (quase todo build, inclusive ffmpeg-static). */
  aac: boolean;
};

let _caps: FFmpegCapabilities | undefined;

/**
 * Descobre uma vez por processo se o ffmpeg existe e quais encoders ele tem.
 *
 * Sem isso, "conversão falhou" era indistinguível de "ffmpeg sem libopus" —
 * o operador via um toast genérico e a gente ficava adivinhando no log.
 */
export function ffmpegCapabilities(): FFmpegCapabilities {
  if (_caps) return _caps;
  const bin = getFFmpeg();
  try {
    const out = execFileSync(bin, ["-hide_banner", "-encoders"], {
      timeout: 10_000,
      stdio: "pipe",
      maxBuffer: 8 * 1024 * 1024,
    }).toString();
    _caps = {
      available: true,
      bin,
      libopus: /\blibopus\b/.test(out),
      libmp3lame: /\blibmp3lame\b/.test(out),
      aac: /(^|\s)aac\s/m.test(out) || /\baac\b/.test(out),
    };
  } catch {
    _caps = { available: false, bin, libopus: false, libmp3lame: false, aac: false };
  }
  log.info(
    {
      ffmpeg: _caps.available ? _caps.bin : "AUSENTE",
      libopus: _caps.libopus,
      libmp3lame: _caps.libmp3lame,
      aac: _caps.aac,
    },
    "[audio-convert] capacidades do ffmpeg",
  );
  return _caps;
}

const TMP_DIR = path.join(os.tmpdir(), "crm-audio-convert");

const OGG_MAGIC = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS"

/**
 * Voice message Meta: OGG + OPUS, mono. 16 kHz / 20 ms / voip replica o PTT nativo.
 * 48 kHz e remux/experimental opus o iOS recusa — mas tentamos 48k e copy
 * ANTES de desistir: alguns WebM do Chrome só sobrevivem ao remux/`-ar 48000`.
 */
function getConversionStrategies(): { label: string; args: string[] }[] {
  const caps = ffmpegCapabilities();
  const strategies: { label: string; args: string[] }[] = [
    {
      label: "copy remux ogg (opus já no webm)",
      args: ["-c:a", "copy", "-map_metadata", "-1", "-f", "ogg"],
    },
  ];

  if (caps.libopus) {
    strategies.push(
      {
        label: "libopus 48k voip",
        args: [
          "-c:a", "libopus",
          "-ac", "1",
          "-ar", "48000",
          "-b:a", "24k",
          "-application", "voip",
          "-map_metadata", "-1",
          "-f", "ogg",
        ],
      },
      {
        label: "libopus 16k voip 20ms",
        args: [
          "-c:a", "libopus",
          "-ac", "1",
          "-ar", "16000",
          "-b:a", "24k",
          "-application", "voip",
          "-frame_duration", "20",
          "-map_metadata", "-1",
          "-f", "ogg",
        ],
      },
      {
        label: "libopus 16k voip",
        args: [
          "-c:a", "libopus",
          "-ac", "1",
          "-ar", "16000",
          "-b:a", "24k",
          "-application", "voip",
          "-map_metadata", "-1",
          "-f", "ogg",
        ],
      },
    );
  }

  strategies.push({
    label: "opus nativo (experimental)",
    args: [
      "-c:a", "opus",
      "-strict", "-2",
      "-ac", "1",
      "-ar", "48000",
      "-b:a", "24k",
      "-map_metadata", "-1",
      "-f", "ogg",
    ],
  });

  return strategies;
}

function ffmpegInputArgs(inputPath: string, inputExt: string): string[] {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-fflags", "+genpts+igndts+discardcorrupt",
    "-analyzeduration", "15M",
    "-probesize", "15M",
  ];
  if (inputExt === "webm") args.push("-f", "webm");
  args.push("-i", inputPath);
  return args;
}

function runFFmpeg(bin: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        const errText = (stderr || "").toString();
        if (error) {
          const msg = error.killed ? "timeout" : error.message;
          resolve({ ok: false, stderr: (errText.slice(-800) || msg) });
        } else {
          resolve({ ok: true, stderr: errText });
        }
      },
    );
  });
}

/**
 * Converts any audio buffer to OGG/Opus via FFmpeg.
 * Returns the converted buffer, or null if every strategy fails.
 */
export async function convertToOgg(
  inputBuffer: Buffer,
  inputExt = "webm",
): Promise<Buffer | null> {
  await mkdir(TMP_DIR, { recursive: true });

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const inputPath = path.join(TMP_DIR, `in-${ts}-${rand}.${inputExt}`);
  const outputPath = path.join(TMP_DIR, `out-${ts}-${rand}.ogg`);

  try {
    await writeFile(inputPath, inputBuffer);

    const bin = getFFmpeg();
    const strategies = getConversionStrategies();
    const inputArgs = ffmpegInputArgs(inputPath, inputExt);

    for (const strategy of strategies) {
      const fullArgs = [...inputArgs, "-vn", ...strategy.args, "-y", outputPath];
      log.info({ strategy: strategy.label, bin, args: fullArgs.join(" ") }, "[ffmpeg] Tentando estrategia");

      const { ok, stderr } = await runFFmpeg(bin, fullArgs, 20_000);

      if (!ok) {
        log.warn(
          { strategy: strategy.label, stderr: stderr.slice(-300) },
          "[ffmpeg] Estrategia falhou",
        );
        await unlink(outputPath).catch(() => {});
        continue;
      }

      if (!existsSync(outputPath)) {
        log.warn({ strategy: strategy.label }, "[ffmpeg] Estrategia nao gerou arquivo de saida");
        continue;
      }

      const result = await readFile(outputPath);

      if (!isOggOpus(result)) {
        log.warn(
          {
            strategy: strategy.label,
            bytes: result.length,
            magic: result.subarray(0, 4).toString("hex"),
          },
          "[ffmpeg] Estrategia gerou arquivo invalido",
        );
        await unlink(outputPath).catch(() => {});
        continue;
      }

      const channels = oggOpusChannels(result);
      if (channels !== null && channels !== 1) {
        log.warn(
          { strategy: strategy.label, channels },
          "[ffmpeg] Estrategia gerou Opus nao mono — PTT exige mono",
        );
        await unlink(outputPath).catch(() => {});
        continue;
      }

      log.info(
        { strategy: strategy.label, inputBytes: inputBuffer.length, outputBytes: result.length },
        "[ffmpeg] Conversao OK",
      );
      return result;
    }

    log.error("[audio-convert] Todas as estrategias de conversao PTT falharam");
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      "[audio-convert] FFmpeg conversion error",
    );
    return null;
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Convert any audio buffer to MP3 (audio/mpeg) via FFmpeg.
 *
 * Use case: download de áudios do chat sempre como `.mp3` — formato
 * universal que abre em qualquer player desktop/mobile sem precisar
 * de plugin (ao contrário de `.ogg`/`.opus`/`.webm` que vêm da
 * Meta/WhatsApp e às vezes não tocam direto fora do navegador).
 *
 * Estratégia: transcode com `libmp3lame` (encoder MP3 padrão do
 * ffmpeg). Bitrate 128kbps + canais mono — voz humana cabe
 * confortavelmente nesse perfil e mantém arquivos pequenos
 * (~1MB/min). Sample rate 44.1kHz para máxima compatibilidade.
 *
 * Retorna `null` se ffmpeg falhar (sem libmp3lame, input corrompido,
 * timeout, etc) — caller deve cair pro arquivo original como fallback.
 */
export async function convertToMp3(
  inputBuffer: Buffer,
  inputExt = "webm",
): Promise<Buffer | null> {
  await mkdir(TMP_DIR, { recursive: true });

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const inputPath = path.join(TMP_DIR, `in-${ts}-${rand}.${inputExt}`);
  const outputPath = path.join(TMP_DIR, `out-${ts}-${rand}.mp3`);

  try {
    await writeFile(inputPath, inputBuffer);

    const bin = getFFmpeg();
    const args = [
      ...ffmpegInputArgs(inputPath, inputExt),
      "-vn",
      "-acodec", "libmp3lame",
      "-ar", "44100",
      "-ac", "1",
      "-b:a", "128k",
      "-y",
      outputPath,
    ];

    log.info({ bin, args: args.join(" ") }, "[ffmpeg] Convertendo pra MP3");
    const { ok, stderr } = await runFFmpeg(bin, args);

    if (!ok) {
      log.warn({ stderr: stderr.slice(-300) }, "[ffmpeg] Conversao MP3 falhou");
      return null;
    }

    if (!existsSync(outputPath)) {
      log.warn("[ffmpeg] MP3 nao foi gerado");
      return null;
    }

    const result = await readFile(outputPath);
    log.info(
      { inputBytes: inputBuffer.length, outputBytes: result.length },
      "[ffmpeg] Conversao MP3 OK",
    );
    return result;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      "[audio-convert] MP3 conversion error",
    );
    return null;
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Converte para AAC em MP4/M4A — formato `audio/mp4` da Cloud API (áudio
 * comum, não PTT). O encoder `aac` nativo existe em praticamente todo
 * ffmpeg, inclusive o `ffmpeg-static` que costuma vir sem libopus/lame.
 */
export async function convertToM4a(
  inputBuffer: Buffer,
  inputExt = "webm",
): Promise<Buffer | null> {
  await mkdir(TMP_DIR, { recursive: true });

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const inputPath = path.join(TMP_DIR, `in-${ts}-${rand}.${inputExt}`);
  const outputPath = path.join(TMP_DIR, `out-${ts}-${rand}.m4a`);

  try {
    await writeFile(inputPath, inputBuffer);

    const bin = getFFmpeg();
    const args = [
      ...ffmpegInputArgs(inputPath, inputExt),
      "-vn",
      "-c:a", "aac",
      "-b:a", "64k",
      "-ac", "1",
      "-ar", "44100",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    log.info({ bin, args: args.join(" ") }, "[ffmpeg] Convertendo pra M4A");
    const { ok, stderr } = await runFFmpeg(bin, args, 20_000);

    if (!ok) {
      log.warn({ stderr: stderr.slice(-300) }, "[ffmpeg] Conversao M4A falhou");
      return null;
    }
    if (!existsSync(outputPath)) {
      log.warn("[ffmpeg] M4A nao foi gerado");
      return null;
    }

    const result = await readFile(outputPath);
    if (result.length < 16 || result.toString("ascii", 4, 8) !== "ftyp") {
      log.warn("[ffmpeg] M4A gerado sem ftyp — descartado");
      return null;
    }
    log.info(
      { inputBytes: inputBuffer.length, outputBytes: result.length },
      "[ffmpeg] Conversao M4A OK",
    );
    return result;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      "[audio-convert] M4A conversion error",
    );
    return null;
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

function guessInputExtFromBuffer(buf: Buffer, mimeBase: string): string {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(OGG_MAGIC)) return "ogg";
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return "webm";
  }
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    return "wav";
  }
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return "mp3";
  return guessInputExt(mimeBase);
}

export type AudioDelivery = "voice" | "audio" | "document";

export type WhatsAppAudioPayload = {
  buffer: Buffer;
  mime: string;
  fileName: string;
  voice: boolean;
  delivery: AudioDelivery;
  /** Motivo técnico quando `delivery === "document"` (não exibir cru ao agente). */
  failReason?: string;
};

export const WHATSAPP_AUDIO_CONVERT_FAILED =
  "Não foi possível converter este áudio para o formato do WhatsApp. Grave novamente.";

/** POST `/media` da Cloud API recusa estes MIME (erro 100 / octet-stream). */
export function metaCloudAudioUploadBlocked(
  prepared: WhatsAppAudioPayload,
): string | null {
  const mime = prepared.mime.split(";")[0].trim().toLowerCase();
  if (
    prepared.delivery === "document" ||
    mime === "application/octet-stream" ||
    mime === "audio/webm"
  ) {
    return WHATSAPP_AUDIO_CONVERT_FAILED;
  }
  return null;
}

function withAudioExt(name: string, ext: string): string {
  const base = name.replace(/\.[^.]+$/, "").trim() || "audio";
  return `${base}.${ext}`;
}

export type PrepareAudioResult =
  | { ok: true; payload: WhatsAppAudioPayload }
  | { ok: false; reason: string };

function payload(
  buffer: Buffer,
  mime: string,
  fileName: string,
  delivery: AudioDelivery,
): WhatsAppAudioPayload {
  return { buffer, mime, fileName, voice: delivery === "voice", delivery };
}

/** MIME aceitos pela Cloud API como `type: audio` sem `voice: true`. */
const WHATSAPP_PLAIN_AUDIO_MIME = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/ogg",
  "audio/ogg; codecs=opus",
  "audio/opus",
]);

function asPlainAudio(
  buffer: Buffer,
  mime: string,
  fileName: string,
): PrepareAudioResult | null {
  if (!buffer.length || buffer.length > WHATSAPP_AUDIO_MAX_BYTES) return null;
  const base = mime.split(";")[0].trim().toLowerCase();
  if (!WHATSAPP_PLAIN_AUDIO_MIME.has(base) && !WHATSAPP_PLAIN_AUDIO_MIME.has(mime.toLowerCase())) {
    return null;
  }
  const uploadMime =
    base === "audio/ogg" || base === "audio/opus" ? WHATSAPP_VOICE_MIME : mime;
  return { ok: true, payload: payload(buffer, uploadMime, fileName, "audio") };
}

function asDocument(
  buffer: Buffer,
  _mime: string,
  fileName: string,
  reason: string,
): PrepareAudioResult {
  return {
    ok: true,
    payload: {
      buffer,
      mime: "application/octet-stream",
      fileName: fileName || "audio.bin",
      voice: false,
      delivery: "document",
      failReason: reason,
    },
  };
}

/** Aplica o layout de nota de voz nativa e valida o resultado final. */
function finalizeVoiceOgg(ogg: Buffer, originalName: string): PrepareAudioResult {
  const channels = oggOpusChannels(ogg);
  if (channels !== null && channels !== 1) {
    return { ok: false, reason: `Opus com ${channels} canais; a Meta aceita só mono em nota de voz.` };
  }

  let packed: Buffer;
  try {
    packed = repacketizeOggOpusToCode3(ogg);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "[audio-convert] repacketize code-3 falhou, enviando Opus original",
    );
    packed = ogg;
  }
  if (!isOggOpus(packed)) return { ok: false, reason: "Ogg/Opus gerado saiu inválido." };
  if (packed.length > WHATSAPP_AUDIO_MAX_BYTES) {
    return { ok: false, reason: "Áudio acima do limite de 16 MB da Cloud API." };
  }

  return {
    ok: true,
    payload: payload(packed, WHATSAPP_VOICE_MIME, withAudioExt(originalName, "ogg"), "voice"),
  };
}

/**
 * Áudio de saída WhatsApp (Cloud API e Baileys).
 *
 * Primário: nota de voz Ogg/Opus (`voice: true` / PTT).
 * Fallback obrigatório: se a conversão PTT falhar por qualquer motivo,
 * envia áudio tocável (m4a/mp3/ogg) ou, por último, documento — o agente
 * nunca fica bloqueado com toast vermelho de FFmpeg.
 *
 * Ordem:
 *   1. Já é Ogg/Opus mono → reempacota (sem ffmpeg).
 *   2. WebM/Opus mono (MediaRecorder) → remux JS WebM→Ogg (sem ffmpeg).
 *   3. FFmpeg: copy remux, libopus 48k/16k, opus experimental.
 *   4. FFmpeg AAC/M4A (áudio comum).
 *   5. FFmpeg MP3.
 *   6. Ogg remuxado (mesmo estéreo) como áudio sem PTT.
 *   7. Original se já for mpeg/mp4/aac/amr/ogg.
 *   8. Documento com o arquivo original.
 */
export async function prepareWhatsAppAudio(
  inputBuffer: Buffer,
  inputExt: string,
  originalName: string,
): Promise<PrepareAudioResult> {
  if (!inputBuffer.length) return { ok: false, reason: "Arquivo de áudio vazio." };

  const sourceMime = mimeFromExtension(inputExt) || `audio/${inputExt}`;
  const ext = guessInputExtFromBuffer(inputBuffer, sourceMime);
  let pttReason = "não foi possível gerar Ogg/Opus";
  let remuxedOgg: Buffer | null = null;

  if (isOggOpus(inputBuffer)) {
    log.info("[audio-convert] entrada já é Ogg/Opus — reempacotando sem transcode");
    const direct = finalizeVoiceOgg(inputBuffer, originalName);
    if (direct.ok) return direct;
    pttReason = direct.reason;
    remuxedOgg = inputBuffer;
    log.warn({ reason: direct.reason }, "[audio-convert] reempacote direto rejeitado");
  }

  if (ext === "webm") {
    const track = demuxWebmOpus(inputBuffer);
    if (track) {
      try {
        const remuxed = muxOggOpus(track.opusHead, track.packets);
        remuxedOgg = remuxed;
        log.info(
          {
            inputBytes: inputBuffer.length,
            outputBytes: remuxed.length,
            packets: track.packets.length,
            channels: track.channels,
          },
          "[audio-convert] remux WebM/Opus -> Ogg/Opus sem ffmpeg",
        );
        if (track.channels === 1) {
          const result = finalizeVoiceOgg(remuxed, originalName);
          if (result.ok) return result;
          pttReason = result.reason;
          log.warn({ reason: result.reason }, "[audio-convert] remux rejeitado como PTT");
        } else {
          pttReason = `WebM/Opus com ${track.channels} canais — precisa transcode pra mono`;
          log.info({ pttReason }, "[audio-convert] remux nao serve como PTT");
        }
      } catch (err) {
        pttReason = err instanceof Error ? err.message : "remux WebM falhou";
        log.warn({ pttReason }, "[audio-convert] remux WebM/Opus falhou, caindo pro ffmpeg");
      }
    } else {
      pttReason = "demultiplexador JS não leu Opus neste WebM";
      log.warn({ pttReason }, "[audio-convert] PTT indisponivel — caindo pro ffmpeg");
    }
  }

  const caps = ffmpegCapabilities();
  if (caps.available) {
    const ogg = await convertToOgg(inputBuffer, ext);
    if (ogg && isOggOpus(ogg)) {
      const finalized = finalizeVoiceOgg(ogg, originalName);
      if (finalized.ok) return finalized;
      pttReason = finalized.reason;
      remuxedOgg = remuxedOgg ?? ogg;
      log.warn({ reason: finalized.reason }, "[audio-convert] ffmpeg PTT rejeitado");
    } else {
      pttReason = caps.libopus
        ? `FFmpeg não conseguiu converter este ${ext} para Ogg/Opus.`
        : "FFmpeg instalado sem libopus — não é possível gerar Ogg/Opus para nota de voz.";
      log.warn({ pttReason }, "[audio-convert] PTT indisponivel — tentando áudio comum");
    }
  } else {
    pttReason = `Formato ${ext} exige transcode e o FFmpeg não está instalado no servidor.`;
    log.warn({ pttReason }, "[audio-convert] PTT indisponivel — tentando áudio comum / documento");
  }

  if (caps.available && caps.aac) {
    const m4a = await convertToM4a(inputBuffer, ext);
    if (m4a) {
      log.info("[audio-convert] fallback M4A/AAC (não é nota de voz)");
      return {
        ok: true,
        payload: payload(m4a, "audio/mp4", withAudioExt(originalName, "m4a"), "audio"),
      };
    }
  }

  if (caps.available && caps.libmp3lame) {
    const mp3 = await convertToMp3(inputBuffer, ext);
    if (mp3) {
      log.info("[audio-convert] fallback MP3 (não é nota de voz)");
      return {
        ok: true,
        payload: payload(mp3, "audio/mpeg", withAudioExt(originalName, "mp3"), "audio"),
      };
    }
  }

  if (remuxedOgg && remuxedOgg.length <= WHATSAPP_AUDIO_MAX_BYTES) {
    log.info("[audio-convert] fallback Ogg/Opus sem PTT");
    const plain = asPlainAudio(remuxedOgg, WHATSAPP_VOICE_MIME, withAudioExt(originalName, "ogg"));
    if (plain) return plain;
  }

  const originalMime =
    mimeFromExtension(ext) || mimeFromExtension(inputExt) || sourceMime;
  const originalNameWithExt = originalName.includes(".")
    ? originalName
    : withAudioExt(originalName, ext === "bin" ? "webm" : ext);
  const plainOriginal = asPlainAudio(inputBuffer, originalMime, originalNameWithExt);
  if (plainOriginal) {
    log.info({ originalMime }, "[audio-convert] fallback original (não é nota de voz)");
    return plainOriginal;
  }

  log.warn({ pttReason }, "[audio-convert] PTT e áudio comum falharam — enviando como documento");
  return asDocument(
    inputBuffer,
    originalMime.startsWith("audio/") ? originalMime : "application/octet-stream",
    originalNameWithExt,
    pttReason,
  );
}

/**
 * WhatsApp PTT (voice messages) REQUIRE audio/ogg with Opus codec.
 * Only audio/ogg should skip conversion for voice messages.
 */
export function needsVoiceConversion(mimeBase: string): boolean {
  const base = mimeBase.split(";")[0].trim();
  return base !== "audio/ogg";
}

export function guessInputExt(mimeBase: string): string {
  const base = mimeBase.split(";")[0].trim();
  switch (base) {
    case "audio/mp4":
      return "m4a";
    case "audio/webm":
      return "webm";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
      return "wav";
    case "audio/aac":
      return "aac";
    case "audio/ogg":
    case "audio/opus":
      return "ogg";
    default:
      return "bin";
  }
}

/**
 * Resolve MIME from file extension — used as fallback when blob MIME is missing.
 */
export function mimeFromExtension(ext: string): string | null {
  switch (ext.toLowerCase()) {
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "mp4":
    case "m4a":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    case "aac":
      return "audio/aac";
    case "webm":
      return "audio/webm";
    case "wav":
      return "audio/wav";
    case "amr":
      return "audio/amr";
    default:
      return null;
  }
}

/** Meta rejeita `audio/ogg` e `audio/opus`. Upload de voz exige codecs=opus. */
export function whatsappUploadAudioMime(mimeType: string, fileName: string): string {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (base === "audio/ogg" || base === "audio/opus" || ext === "ogg" || ext === "opus") {
    return WHATSAPP_VOICE_MIME;
  }
  return mimeType;
}
