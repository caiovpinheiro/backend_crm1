import { describe, expect, it } from "vitest";

import {
  ffmpegCapabilities,
  prepareWhatsAppAudio,
} from "@/lib/audio-convert";
import { isOggOpus, muxOggOpus } from "@/lib/ogg-opus-ptt";
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
