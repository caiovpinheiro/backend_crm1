import { describe, expect, it } from "vitest";

import {
  isOggOpus,
  muxOggOpus,
  oggOpusChannels,
  repacketizeOggOpusToCode3,
} from "@/lib/ogg-opus-ptt";
import { demuxWebmOpus } from "@/lib/webm-opus";

// ── Helpers de fixture ───────────────────────────────────────────────

function opusHead(channels = 1, preSkip = 312): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "ascii");
  b[8] = 1; // version
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  b.writeInt16LE(0, 16); // output gain
  b[18] = 0; // channel mapping family
  return b;
}

/** Pacote Opus code 0 (1 frame). config 31 = CELT fullband 20 ms (RFC 6716 tab. 2). */
function opusPacketCode0(config = 31, payloadLen = 40, fill = 0x55): Buffer {
  const toc = ((config & 0x1f) << 3) | 0; // stereo=0, code=0
  return Buffer.concat([Buffer.from([toc]), Buffer.alloc(payloadLen, fill)]);
}

// ── Verificação estrutural de Ogg ────────────────────────────────────

const OGG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();

type OggPage = { headerType: number; granule: number; serial: number; seq: number; packet: Buffer };

/** Lê páginas Ogg validando o CRC de cada uma — pega qualquer erro de layout. */
function parseOggPages(buf: Buffer): OggPage[] {
  const pages: OggPage[] = [];
  let off = 0;
  while (off + 27 <= buf.length) {
    expect(buf.toString("ascii", off, off + 4)).toBe("OggS");
    const nseg = buf[off + 26]!;
    const segStart = off + 27;
    let dataLen = 0;
    for (let s = 0; s < nseg; s++) dataLen += buf[segStart + s]!;
    const pageEnd = segStart + nseg + dataLen;
    const page = Buffer.from(buf.subarray(off, pageEnd));

    const stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    let crc = 0;
    for (const byte of page) crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xff) ^ byte]!) >>> 0;
    expect(crc >>> 0).toBe(stored);

    pages.push({
      headerType: buf[off + 5]!,
      granule: Number(buf.readBigUInt64LE(off + 6)),
      serial: buf.readUInt32LE(off + 14),
      seq: buf.readUInt32LE(off + 18),
      packet: Buffer.from(buf.subarray(segStart + nseg, pageEnd)),
    });
    off = pageEnd;
  }
  return pages;
}

// ── Fixture WebM ─────────────────────────────────────────────────────

function vint(value: number): Buffer {
  if (value < 0x7f) return Buffer.from([0x80 | value]);
  if (value < 0x3fff) return Buffer.from([0x40 | (value >> 8), value & 0xff]);
  return Buffer.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
}

function el(id: number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), vint(payload.length), payload]);
}

/** WebM mínimo com uma trilha A_OPUS, no formato que o MediaRecorder produz. */
function buildWebmOpus(packets: Buffer[], opts: { unknownSizes?: boolean; channels?: number } = {}): Buffer {
  const channels = opts.channels ?? 1;
  const ebmlHeader = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from("webm\0", "ascii")));

  const trackEntry = el(
    [0xae],
    Buffer.concat([
      el([0xd7], Buffer.from([1])), // TrackNumber
      el([0x83], Buffer.from([2])), // TrackType = audio
      el([0x86], Buffer.from("A_OPUS", "ascii")), // CodecID
      el([0x63, 0xa2], opusHead(channels)), // CodecPrivate
      el([0xe1], el([0x9f], Buffer.from([channels]))), // Audio > Channels
    ]),
  );
  const tracks = el([0x16, 0x54, 0xae, 0x6b], trackEntry);

  const blocks = packets.map((p, i) =>
    el(
      [0xa3],
      Buffer.concat([
        vint(1), // track number
        Buffer.from([(i * 20) >> 8, (i * 20) & 0xff]), // timecode
        Buffer.from([0x80]), // flags: keyframe, sem lacing
        p,
      ]),
    ),
  );
  const clusterBody = Buffer.concat([el([0xe7], Buffer.from([0])), ...blocks]);

  if (opts.unknownSizes) {
    // Segment e Cluster com tamanho desconhecido (0x01FFFFFFFFFFFFFF / 0xFF),
    // que é exatamente o que o MediaRecorder escreve gravando em streaming.
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

// ── Testes ───────────────────────────────────────────────────────────

describe("demuxWebmOpus", () => {
  const packets = Array.from({ length: 9 }, (_, i) => opusPacketCode0(31, 30 + i));

  it("extrai OpusHead e todos os pacotes de um WebM com tamanhos declarados", () => {
    const track = demuxWebmOpus(buildWebmOpus(packets));
    expect(track).not.toBeNull();
    expect(track!.channels).toBe(1);
    expect(track!.opusHead.subarray(0, 8).toString("ascii")).toBe("OpusHead");
    expect(track!.packets.map((p) => p.length)).toEqual(packets.map((p) => p.length));
  });

  it("funciona com Segment/Cluster de tamanho desconhecido (MediaRecorder)", () => {
    const track = demuxWebmOpus(buildWebmOpus(packets, { unknownSizes: true }));
    expect(track).not.toBeNull();
    expect(track!.packets).toHaveLength(packets.length);
  });

  it("reporta a contagem de canais para o caller decidir transcodar", () => {
    const track = demuxWebmOpus(buildWebmOpus(packets, { channels: 2 }));
    expect(track!.channels).toBe(2);
  });

  it("aceita um único pacote Opus (gravação muito curta)", () => {
    const packets = [opusPacketCode0(31, 40)];
    const track = demuxWebmOpus(buildWebmOpus(packets));
    expect(track).not.toBeNull();
    expect(track!.packets).toHaveLength(1);
  });

  it("rejeita buffer que não é WebM", () => {
    expect(demuxWebmOpus(Buffer.alloc(4096, 0x41))).toBeNull();
  });
});

describe("muxOggOpus", () => {
  const packets = Array.from({ length: 9 }, () => opusPacketCode0());

  it("gera Ogg/Opus válido com CRC, BOS/EOS e granule crescente", () => {
    const ogg = muxOggOpus(opusHead(), packets);
    expect(isOggOpus(ogg)).toBe(true);
    expect(oggOpusChannels(ogg)).toBe(1);

    const pages = parseOggPages(ogg);
    expect(pages[0]!.headerType & 0x02).toBe(0x02); // BOS
    expect(pages[0]!.packet.subarray(0, 8).toString("ascii")).toBe("OpusHead");
    expect(pages[1]!.packet.subarray(0, 8).toString("ascii")).toBe("OpusTags");
    expect(pages.at(-1)!.headerType & 0x04).toBe(0x04); // EOS

    const audio = pages.slice(2);
    // 20 ms a 48 kHz = 960 samples por pacote, partindo do pre-skip.
    expect(audio.map((p) => p.granule)).toEqual(audio.map((_, i) => 312 + 960 * (i + 1)));
    expect(audio.map((p) => p.seq)).toEqual(audio.map((_, i) => i + 2));
  });

  it("recusa OpusHead inválido", () => {
    expect(() => muxOggOpus(Buffer.alloc(19), packets)).toThrow();
  });
});

describe("repacketizeOggOpusToCode3", () => {
  it("agrupa 3 frames code 0 em pacotes code 3 preservando o áudio", () => {
    const packets = Array.from({ length: 9 }, (_, i) => opusPacketCode0(31, 30 + i, 0x10 + i));
    const packed = repacketizeOggOpusToCode3(muxOggOpus(opusHead(), packets));
    expect(isOggOpus(packed)).toBe(true);

    const audio = parseOggPages(packed).slice(2);
    expect(audio).toHaveLength(3);
    for (const page of audio) {
      expect(page.packet[0]! & 0x03).toBe(3); // code 3
      expect(page.packet[1]! & 0x3f).toBe(3); // 3 frames
      expect(page.packet[1]! & 0x80).toBe(0x80); // VBR, tamanhos explícitos
    }
    // 9 frames × 20 ms = 180 ms = 8640 samples, mais o pre-skip.
    expect(audio.at(-1)!.granule).toBe(312 + 8640);
    expect(audio.at(-1)!.headerType & 0x04).toBe(0x04);

    const original = Buffer.concat(packets.map((p) => p.subarray(1)));
    const roundTrip = Buffer.concat(
      audio.map((p) => {
        // TOC + frame-count + 2 tamanhos (frames < 252 → 1 byte cada).
        return p.packet.subarray(4);
      }),
    );
    expect(roundTrip.equals(original)).toBe(true);
  });

  it("é idempotente em stream que já está em code 3", () => {
    const packets = Array.from({ length: 9 }, () => opusPacketCode0());
    const once = repacketizeOggOpusToCode3(muxOggOpus(opusHead(), packets));
    expect(repacketizeOggOpusToCode3(once).equals(once)).toBe(true);
  });

  it("devolve o input intacto quando não é Ogg", () => {
    const junk = Buffer.alloc(300, 7);
    expect(repacketizeOggOpusToCode3(junk).equals(junk)).toBe(true);
  });
});

describe("pipeline WebM -> PTT", () => {
  it("converte uma gravação de browser em nota de voz sem ffmpeg", () => {
    const packets = Array.from({ length: 50 }, (_, i) => opusPacketCode0(31, 35 + (i % 7)));
    const track = demuxWebmOpus(buildWebmOpus(packets, { unknownSizes: true }))!;
    const ptt = repacketizeOggOpusToCode3(muxOggOpus(track.opusHead, track.packets));

    expect(isOggOpus(ptt)).toBe(true);
    expect(oggOpusChannels(ptt)).toBe(1);
    const audio = parseOggPages(ptt).slice(2);
    expect(audio).toHaveLength(Math.ceil(50 / 3));
    expect(audio.every((p) => (p.packet[0]! & 0x03) === 3)).toBe(true);
  });
});
