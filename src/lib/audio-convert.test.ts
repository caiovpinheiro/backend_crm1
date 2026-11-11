import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ffmpegCapabilities,
  generatedVoiceStrategies,
  metaCloudAudioUploadBlocked,
  prepareWhatsAppAudio,
  VOICE_LOUDNORM_FILTER,
} from "@/lib/audio-convert";
import { isOggOpus, muxOggOpus, oggOpusChannels } from "@/lib/ogg-opus-ptt";
import { demuxWebmOpus } from "@/lib/webm-opus";

function opusHead(channels = 1, preSkip = 312): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "ascii");
  b[8] = 1;
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  b.writeInt16LE(0, 16);
  b[18] = 0;
  return b;
}

function opusPacketCode0(config = 31, payloadLen = 40, fill = 0x55): Buffer {
  const toc = ((config & 0x1f) << 3) | 0;
  return Buffer.concat([Buffer.from([toc]), Buffer.alloc(payloadLen, fill)]);
}

function vint(value: number): Buffer {
  if (value < 0x7f) return Buffer.from([0x80 | value]);
  if (value < 0x3fff) return Buffer.from([0x40 | (value >> 8), value & 0xff]);
  return Buffer.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
}

function el(id: number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), vint(payload.length), payload]);
}

function buildWebmOpus(packets: Buffer[], opts: { unknownSizes?: boolean; channels?: number } = {}): Buffer {
  const channels = opts.channels ?? 1;
  const ebmlHeader = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from("webm\0", "ascii")));
  const trackEntry = el(
    [0xae],
    Buffer.concat([
      el([0xd7], Buffer.from([1])),
      el([0x83], Buffer.from([2])),
      el([0x86], Buffer.from("A_OPUS", "ascii")),
      el([0x63, 0xa2], opusHead(channels)),
      el([0xe1], el([0x9f], Buffer.from([channels]))),
    ]),
  );
  const tracks = el([0x16, 0x54, 0xae, 0x6b], trackEntry);
  const blocks = packets.map((p, i) =>
    el(
      [0xa3],
      Buffer.concat([
        vint(1),
        Buffer.from([(i * 20) >> 8, (i * 20) & 0xff]),
        Buffer.from([0x80]),
        p,
      ]),
    ),
  );
  const clusterBody = Buffer.concat([el([0xe7], Buffer.from([0])), ...blocks]);
  if (opts.unknownSizes) {
    const unknown8 = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    return Buffer.concat([
      ebmlHeader,
      Buffer.from([0x18, 0x53, 0x80, 0x67]),
      unknown8,
      tracks,
      Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0xff]),
      clusterBody,
    ]);
  }
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], clusterBody);
  return Buffer.concat([ebmlHeader, el([0x18, 0x53, 0x80, 0x67], Buffer.concat([tracks, cluster]))]);
}

describe("prepareWhatsAppAudio", () => {
  it("rejeita buffer vazio", async () => {
    const result = await prepareWhatsAppAudio(Buffer.alloc(0), "webm", "audio.webm");
    expect(result.ok).toBe(false);
  });

  it("converte WebM/Opus mono do browser em nota de voz sem depender de ffmpeg", async () => {
    const packets = Array.from({ length: 24 }, (_, i) => opusPacketCode0(31, 32 + (i % 5)));
    const webm = buildWebmOpus(packets, { unknownSizes: true });
    const result = await prepareWhatsAppAudio(webm, "webm", "audio.webm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.delivery).toBe("voice");
    expect(result.payload.voice).toBe(true);
    expect(result.payload.mime).toBe("audio/ogg; codecs=opus");
    expect(isOggOpus(result.payload.buffer)).toBe(true);
  });

  it("nunca aborta um WebM estéreo: PTT (ffmpeg) ou áudio comum (remux)", async () => {
    const packets = Array.from({ length: 18 }, () => opusPacketCode0());
    const webm = buildWebmOpus(packets, { channels: 2 });
    const result = await prepareWhatsAppAudio(webm, "webm", "audio.webm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(["voice", "audio"]).toContain(result.payload.delivery);
    if (!ffmpegCapabilities().available) {
      expect(result.payload.delivery).toBe("audio");
      expect(result.payload.voice).toBe(false);
    }
    expect(result.payload.buffer.length).toBeGreaterThan(0);
  });

  it("não devolve o toast morto de FFmpeg para bytes que não são áudio válido", async () => {
    const junk = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(800, 0x11)]);
    const result = await prepareWhatsAppAudio(junk, "webm", "audio.webm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.delivery).toBe("document");
    expect(result.payload.voice).toBe(false);
    expect(result.payload.mime).toBe("application/octet-stream");
    expect(metaCloudAudioUploadBlocked(result.payload)).toBeTruthy();
  });

  it("envia m4a original como áudio comum se o PTT falhar", async () => {
    const m4a = Buffer.alloc(64, 0);
    m4a.write("ftyp", 4, "ascii");
    m4a.write("M4A ", 8, "ascii");
    const result = await prepareWhatsAppAudio(m4a, "m4a", "clip.m4a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.payload.delivery !== "voice") {
      expect(result.payload.delivery).toBe("audio");
      expect(result.payload.mime).toBe("audio/mp4");
      expect(result.payload.voice).toBe(false);
    }
  });
});

/** Pacotes de áudio de um Ogg (pula OpusHead e OpusTags). */
function oggAudioPackets(ogg: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let cur: Buffer[] = [];
  let off = 0;
  while (off + 27 <= ogg.length && ogg.toString("ascii", off, off + 4) === "OggS") {
    const nseg = ogg[off + 26]!;
    let data = off + 27 + nseg;
    for (let s = 0; s < nseg; s++) {
      const len = ogg[off + 27 + s]!;
      cur.push(ogg.subarray(data, data + len));
      data += len;
      if (len < 255) {
        packets.push(Buffer.concat(cur));
        cur = [];
      }
    }
    off = data;
  }
  return packets.slice(2);
}

/** MP3 mono de fala sintética curta, como o que o provedor de voz devolve. */
function fakeTtsMp3(): Buffer | null {
  const caps = ffmpegCapabilities();
  if (!caps.available || !caps.libmp3lame) return null;
  const out = path.join(os.tmpdir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  try {
    execFileSync(caps.bin, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=3",
      "-af", "volume=0.05,tremolo=f=4:d=0.9",
      "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", out,
    ]);
    return readFileSync(out);
  } catch {
    return null;
  } finally {
    rmSync(out, { force: true });
  }
}

describe("voz gerada com volume padronizado", () => {
  it("tenta primeiro o layout da nota de voz nativa (16 kHz, 20 ms, voip) e sempre recodifica", () => {
    const strategies = generatedVoiceStrategies();
    expect(strategies.every((s) => !s.args.includes("copy"))).toBe(true);
    expect(strategies.every((s) => s.args.join(" ").includes(VOICE_LOUDNORM_FILTER))).toBe(true);
    if (ffmpegCapabilities().libopus) {
      const first = strategies[0]!.args;
      expect(first).toContain("libopus");
      expect(first[first.indexOf("-ar") + 1]).toBe("16000");
      expect(first[first.indexOf("-frame_duration") + 1]).toBe("20");
      expect(first[first.indexOf("-application") + 1]).toBe("voip");
    }
  });

  it("MP3 do provedor vira nota de voz Ogg/Opus mono de 16 kHz, não arquivo", async () => {
    const mp3 = fakeTtsMp3();
    if (!mp3 || !ffmpegCapabilities().libopus) return;
    const result = await prepareWhatsAppAudio(mp3, "mp3", "voz.mp3", { loudnorm: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.delivery).toBe("voice");
    expect(result.payload.voice).toBe(true);
    expect(result.payload.mime).toBe("audio/ogg; codecs=opus");
    expect(result.payload.fileName.endsWith(".ogg")).toBe(true);
    expect(isOggOpus(result.payload.buffer)).toBe(true);
    expect(oggOpusChannels(result.payload.buffer)).toBe(1);
    // OpusHead: taxa de entrada 16 kHz, como a nota de voz nativa.
    const head = result.payload.buffer.indexOf("OpusHead");
    expect(result.payload.buffer.readUInt32LE(head + 12)).toBe(16000);
    const packets = oggAudioPackets(result.payload.buffer);
    expect(packets.length).toBeGreaterThan(0);
    // Nada de modo híbrido (config 12–15) nem banda super-larga/cheia do CELT
    // (24–31): é o que sai em 48 kHz e o iPhone recebe como arquivo ".opus".
    expect(packets.every((p) => {
      const config = p[0]! >> 3;
      return !(config >= 12 && config <= 15) && config < 24;
    })).toBe(true);
  });
});

describe("pipeline WebM → Ogg (sanidade)", () => {
  it("demux + mux de fixture bate com o demuxer", () => {
    const packets = Array.from({ length: 9 }, (_, i) => opusPacketCode0(31, 30 + i));
    const track = demuxWebmOpus(buildWebmOpus(packets))!;
    const ogg = muxOggOpus(track.opusHead, track.packets);
    expect(isOggOpus(ogg)).toBe(true);
    expect(track.channels).toBe(1);
  });

  it("reporta ffmpeg do ambiente sem quebrar", () => {
    const caps = ffmpegCapabilities();
    expect(typeof caps.available).toBe("boolean");
    expect(typeof caps.bin).toBe("string");
  });
});
