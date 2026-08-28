/**
 * Empacota OGG/Opus no layout das notas de voz nativas do WhatsApp.
 *
 * Meta Cloud API (voice messages):
 *   .ogg + codec OPUS, mono, MIME `audio/ogg; codecs=opus`, `voice: true`.
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages
 *
 * iOS: o WhatsApp recusa pacotes Opus TOC code 0 (1 frame — saída padrão do
 * libopus/ffmpeg) com "este áudio não está mais disponível". Notas nativas
 * usam code 3 (vários frames SILK de 20 ms, tipicamente 3×20 = 60 ms).
 * Android aceita os dois. Reagrupar code 0 → code 3 (RFC 6716) faz tocar nos dois.
 */

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggPageCrc(page: Buffer): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xff) ^ page[i]!]!) >>> 0;
  }
  return crc >>> 0;
}

/** Duração do frame Opus em samples a 48 kHz (RFC 6716 §3.1). */
function opusFrameSamples48k(config: number): number {
  const c = config & 0x1f;
  const ms =
    c < 12
      ? [10, 20, 40, 60][c % 4]!
      : c < 16
        ? c % 2 === 0
          ? 10
          : 20
        : [2.5, 5, 10, 20][c % 4]!;
  return Math.round(ms * 48);
}

function parseOggPackets(buf: Buffer): { packets: Buffer[]; serial: number; preSkip: number } {
  const packets: Buffer[] = [];
  let cur: Buffer[] = [];
  let off = 0;
  let serial = 0;
  let preSkip = 0;
  while (off + 27 <= buf.length) {
    if (buf.toString("ascii", off, off + 4) !== "OggS") break;
    serial = buf.readUInt32LE(off + 14);
    const nseg = buf[off + 26]!;
    const segTableStart = off + 27;
    let dataOff = segTableStart + nseg;
    for (let s = 0; s < nseg; s++) {
      const len = buf[segTableStart + s]!;
      cur.push(buf.subarray(dataOff, dataOff + len));
      dataOff += len;
      if (len < 255) {
        packets.push(Buffer.concat(cur));
        cur = [];
      }
    }
    off = dataOff;
  }
  if (cur.length) packets.push(Buffer.concat(cur));
  if ((packets[0]?.length ?? 0) >= 12 && packets[0]!.subarray(0, 8).toString("ascii") === "OpusHead") {
    preSkip = packets[0]!.readUInt16LE(10);
  }
  return { packets, serial, preSkip };
}

function encodeOpusFrameLength(len: number): number[] {
  if (len < 252) return [len];
  const b0 = 252 + (len % 4);
  return [b0, Math.floor((len - b0) / 4)];
}

function buildOggPage(
  headerType: number,
  granule: number,
  serial: number,
  seq: number,
  packet: Buffer,
): Buffer {
  const segs: number[] = [];
  let rem = packet.length;
  while (rem >= 255) {
    segs.push(255);
    rem -= 255;
  }
  segs.push(rem);
  const header = Buffer.alloc(27 + segs.length);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = headerType;
  header.writeBigUInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(seq >>> 0, 18);
  header[26] = segs.length;
  for (let i = 0; i < segs.length; i++) header[27 + i] = segs[i]!;
  const page = Buffer.concat([header, packet]);
  page.writeUInt32LE(oggPageCrc(page), 22);
  return page;
}

export function isOggOpus(buf: Buffer): boolean {
  if (!Buffer.isBuffer(buf) || buf.length < 48) return false;
  if (buf.toString("ascii", 0, 4) !== "OggS") return false;
  const head = buf.subarray(0, Math.min(buf.length, 512)).toString("ascii");
  return head.includes("OpusHead");
}

/**
 * Canais declarados no `OpusHead`. Meta aceita só mono em nota de voz.
 * Retorna `null` se o buffer não for Ogg/Opus legível.
 */
export function oggOpusChannels(buf: Buffer): number | null {
  if (!isOggOpus(buf)) return null;
  const head = buf.indexOf("OpusHead", 0, "ascii");
  if (head < 0 || head + 19 > buf.length) return null;
  return buf[head + 9] ?? null;
}

function buildOpusTags(): Buffer {
  const vendor = Buffer.from("crm-ptt", "ascii");
  const out = Buffer.alloc(8 + 4 + vendor.length + 4);
  out.write("OpusTags", 0, "ascii");
  out.writeUInt32LE(vendor.length, 8);
  vendor.copy(out, 12);
  out.writeUInt32LE(0, 12 + vendor.length);
  return out;
}

/**
 * Empacota pacotes Opus crus em um stream Ogg/Opus (RFC 7845).
 *
 * `opusHead` vem do `CodecPrivate` do WebM — copiado literalmente para
 * preservar pre-skip, sample rate e mapeamento de canais do encoder original.
 * Um pacote por página; a paginação final (agrupamento code-3) é
 * responsabilidade de `repacketizeOggOpusToCode3`.
 */
export function muxOggOpus(opusHead: Buffer, packets: Buffer[], serial = 0x50_54_54_01): Buffer {
  if (opusHead.length < 19 || opusHead.subarray(0, 8).toString("ascii") !== "OpusHead") {
    throw new Error("OpusHead inválido");
  }
  if (!packets.length) throw new Error("stream Opus sem pacotes");

  const preSkip = opusHead.readUInt16LE(10);
  const pages: Buffer[] = [
    buildOggPage(0x02, 0, serial, 0, opusHead),
    buildOggPage(0x00, 0, serial, 1, buildOpusTags()),
  ];

  let granule = preSkip;
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]!;
    granule += opusPacketSamples48k(packet);
    const last = i === packets.length - 1;
    pages.push(buildOggPage(last ? 0x04 : 0x00, granule, serial, i + 2, packet));
  }
  return Buffer.concat(pages);
}

/** Samples a 48 kHz de um pacote Opus completo, respeitando o code do TOC. */
function opusPacketSamples48k(packet: Buffer): number {
  if (!packet.length) return 0;
  const toc = packet[0]!;
  const perFrame = opusFrameSamples48k(toc >> 3);
  switch (toc & 0x03) {
    case 0:
      return perFrame;
    case 1:
    case 2:
      return perFrame * 2;
    default:
      return perFrame * (packet.length > 1 ? packet[1]! & 0x3f : 1);
  }
}

/**
 * Reagrupa frames code 0 em pacotes code 3 (padrão 3×20 ms).
 * Idempotente: devolve o input se já for code 3, não-OGG ou não-Opus.
 */
export function repacketizeOggOpusToCode3(input: Buffer, framesPerPacket = 3): Buffer {
  if (!Number.isInteger(framesPerPacket) || framesPerPacket < 1 || framesPerPacket > 48) {
    return input;
  }
  if (!Buffer.isBuffer(input) || input.length < 4 || input.toString("ascii", 0, 4) !== "OggS") {
    return input;
  }

  const { packets, serial, preSkip } = parseOggPackets(input);
  if (packets.length < 3 || packets[0]!.subarray(0, 8).toString("ascii") !== "OpusHead") {
    return input;
  }

  const audioPackets = packets.slice(2);
  if (!audioPackets.length || audioPackets.some((p) => p.length < 1 || (p[0]! & 0x03) !== 0)) {
    return input;
  }

  const frames = audioPackets.map((p) => ({
    configStereo: p[0]! >> 2,
    samples: opusFrameSamples48k(p[0]! >> 3),
    data: p.subarray(1),
  }));

  const out: Buffer[] = [
    buildOggPage(0x02, 0, serial, 0, packets[0]!),
    buildOggPage(0x00, 0, serial, 1, packets[1]!),
  ];
  let seq = 2;
  let samplesDone = 0;
  let i = 0;
  while (i < frames.length) {
    const cs = frames[i]!.configStereo;
    const group: Buffer[] = [];
    while (i < frames.length && group.length < framesPerPacket && frames[i]!.configStereo === cs) {
      group.push(frames[i]!.data);
      samplesDone += frames[i]!.samples;
      i++;
    }
    const toc = ((cs << 2) | 3) & 0xff;
    const frameCountByte = (0x80 | group.length) & 0xff;
    const lengths: number[] = [];
    for (let k = 0; k < group.length - 1; k++) {
      lengths.push(...encodeOpusFrameLength(group[k]!.length));
    }
    const packet = Buffer.concat([Buffer.from([toc, frameCountByte, ...lengths]), ...group]);
    out.push(buildOggPage(i >= frames.length ? 0x04 : 0x00, preSkip + samplesDone, serial, seq, packet));
    seq++;
  }

  return Buffer.concat(out);
}
