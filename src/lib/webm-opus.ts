/**
 * Demuxer mínimo de WebM/Matroska para extrair a trilha Opus sem FFmpeg.
 *
 * Motivação: o `MediaRecorder` do browser grava `audio/webm;codecs=opus`, ou
 * seja, os pacotes JÁ estão em Opus (48 kHz, mono, 20 ms) — exatamente o codec
 * que a Meta exige em nota de voz. Transcodar com `ffmpeg -c:a libopus` é um
 * decode+encode desnecessário que ainda por cima faz o envio depender de um
 * binário externo com `libopus` compilado. Aqui só trocamos o container
 * (WebM → Ogg), o que é lossless e roda em qualquer ambiente Node.
 *
 * Especificações: EBML/Matroska (https://matroska.org/technical/elements.html)
 * e WebM Opus mapping (CodecPrivate = OpusHead do RFC 7845).
 */

const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_AUDIO = 0xe1;
const ID_CHANNELS = 0x9f;
const ID_CLUSTER = 0x1f43b675;
const ID_CUES = 0x1c53bb6b;
const ID_TAGS = 0x1254c367;
const ID_BLOCK_GROUP = 0xa0;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK = 0xa1;

/** Elementos em que descemos; o resto é pulado pelo tamanho declarado. */
const MASTER_IDS = new Set<number>([
  ID_SEGMENT,
  ID_SEEKHEAD,
  ID_INFO,
  ID_TRACKS,
  ID_TRACK_ENTRY,
  ID_AUDIO,
  ID_CLUSTER,
  ID_CUES,
  ID_TAGS,
  ID_BLOCK_GROUP,
]);

const UNKNOWN_SIZE = -1;

type Vint = { value: number; length: number };

/** ID de elemento EBML: mantém os bits de marcação (representação canônica). */
function readElementId(buf: Buffer, off: number): Vint | null {
  if (off >= buf.length) return null;
  const first = buf[off]!;
  if (first === 0) return null;
  let length = 1;
  for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) length++;
  if (length > 4 || off + length > buf.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + buf[off + i]!;
  return { value, length };
}

/** Tamanho EBML (VINT sem os bits de marcação). Todos-uns = tamanho desconhecido. */
function readElementSize(buf: Buffer, off: number): Vint | null {
  if (off >= buf.length) return null;
  const first = buf[off]!;
  if (first === 0) return null;
  let length = 1;
  for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) length++;
  if (length > 8 || off + length > buf.length) return null;

  let value = first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    const b = buf[off + i]!;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  if (allOnes) return { value: UNKNOWN_SIZE, length };
  if (!Number.isSafeInteger(value)) return null;
  return { value, length };
}

function readUint(buf: Buffer, off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i]!;
  return v;
}

type TrackInfo = {
  number: number;
  codecId: string;
  codecPrivate: Buffer | null;
  channels: number | null;
  isAudio: boolean;
};

export type WebmOpusTrack = {
  /** Conteúdo do `CodecPrivate` — é o header `OpusHead` (RFC 7845). */
  opusHead: Buffer;
  channels: number;
  /** Pacotes Opus na ordem de apresentação, um por frame do container. */
  packets: Buffer[];
};

/**
 * Lê os frames de um (Simple)Block. Lacing Xiph/EBML/fixo é raro em Opus
 * (o Chrome escreve sem lacing), mas tratamos os quatro casos para não
 * perder áudio silenciosamente.
 */
function readBlockFrames(block: Buffer): { track: number; frames: Buffer[] } | null {
  const trackVint = readElementSize(block, 0);
  if (!trackVint || trackVint.value === UNKNOWN_SIZE) return null;
  let off = trackVint.length + 2; // + timecode int16
  if (off + 1 > block.length) return null;
  const flags = block[off]!;
  off += 1;

  const lacing = (flags >> 1) & 0x03;
  if (lacing === 0) {
    return { track: trackVint.value, frames: [block.subarray(off)] };
  }

  if (off >= block.length) return null;
  const frameCount = block[off]! + 1;
  off += 1;
  const sizes: number[] = [];

  if (lacing === 2) {
    const total = block.length - off;
    if (total % frameCount !== 0) return null;
    for (let i = 0; i < frameCount; i++) sizes.push(total / frameCount);
  } else if (lacing === 1) {
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      for (;;) {
        if (off >= block.length) return null;
        const b = block[off]!;
        off += 1;
        size += b;
        if (b !== 0xff) break;
      }
      sizes.push(size);
    }
  } else {
    const first = readElementSize(block, off);
    if (!first || first.value === UNKNOWN_SIZE) return null;
    off += first.length;
    sizes.push(first.value);
    for (let i = 1; i < frameCount - 1; i++) {
      const delta = readElementSize(block, off);
      if (!delta || delta.value === UNKNOWN_SIZE) return null;
      off += delta.length;
      // Diferenças EBML são assinadas: subtrai 2^(7*len - 1) - 1.
      const bias = 2 ** (7 * delta.length - 1) - 1;
      sizes.push(sizes[i - 1]! + (delta.value - bias));
    }
  }

  const frames: Buffer[] = [];
  for (const size of sizes) {
    if (size < 0 || off + size > block.length) return null;
    frames.push(block.subarray(off, off + size));
    off += size;
  }
  frames.push(block.subarray(off));
  return { track: trackVint.value, frames };
}

/**
 * Extrai a trilha Opus de um buffer WebM. Retorna `null` se o arquivo não for
 * WebM, não tiver trilha `A_OPUS` ou vier sem `CodecPrivate`/pacotes.
 *
 * Suporta os tamanhos "desconhecidos" que o `MediaRecorder` escreve em
 * Segment/Cluster durante gravação em streaming.
 */
export function demuxWebmOpus(buf: Buffer): WebmOpusTrack | null {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return null;
  // EBML header magic.
  if (buf.readUInt32BE(0) !== 0x1a45dfa3) return null;

  const tracks: TrackInfo[] = [];
  let current: TrackInfo | null = null;
  const blocks: { track: number; frames: Buffer[] }[] = [];

  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 8) return;
    let off = start;
    while (off < end) {
      const id = readElementId(buf, off);
      if (!id) return;
      const size = readElementSize(buf, off + id.length);
      if (!size) return;
      const dataStart = off + id.length + size.length;
      if (dataStart > end) return;

      // Cluster é percorrido SEM recursão. O MediaRecorder grava Cluster com
      // tamanho desconhecido; nesse caso o próximo Cluster viraria filho do
      // anterior, a profundidade cresceria 1 por cluster e o teto `depth > 8`
      // descartaria o áudio a partir do 8º cluster (~0,7 s com timeslice de
      // 100 ms). Tratar os filhos no mesmo nível mantém profundidade constante.
      if (id.value === ID_CLUSTER) {
        off = dataStart;
        continue;
      }

      if (MASTER_IDS.has(id.value)) {
        const childEnd = size.value === UNKNOWN_SIZE ? end : Math.min(dataStart + size.value, end);
        if (id.value === ID_TRACK_ENTRY) {
          current = { number: -1, codecId: "", codecPrivate: null, channels: null, isAudio: false };
          tracks.push(current);
        }
        walk(dataStart, childEnd, depth + 1);
        off = size.value === UNKNOWN_SIZE ? childEnd : dataStart + size.value;
        continue;
      }

      if (size.value === UNKNOWN_SIZE) return;
      const dataEnd = Math.min(dataStart + size.value, end);

      switch (id.value) {
        case ID_TRACK_NUMBER:
          if (current) current.number = readUint(buf, dataStart, size.value);
          break;
        case ID_TRACK_TYPE:
          if (current) current.isAudio = readUint(buf, dataStart, size.value) === 2;
          break;
        case ID_CODEC_ID:
          if (current) current.codecId = buf.toString("ascii", dataStart, dataEnd).replace(/\0+$/, "");
          break;
        case ID_CODEC_PRIVATE:
          if (current) current.codecPrivate = Buffer.from(buf.subarray(dataStart, dataEnd));
          break;
        case ID_CHANNELS:
          if (current) current.channels = readUint(buf, dataStart, size.value);
          break;
        case ID_SIMPLE_BLOCK:
        case ID_BLOCK: {
          const parsed = readBlockFrames(buf.subarray(dataStart, dataEnd));
          if (parsed) blocks.push(parsed);
          break;
        }
        default:
          break;
      }
      off = dataStart + size.value;
    }
  };

  // Começa no elemento `EBML` (offset 0): ele não está em MASTER_IDS, então é
  // pulado pelo tamanho declarado e caímos direto no `Segment`.
  walk(0, buf.length, 0);

  const opusTrack = tracks.find(
    (t) => t.codecId === "A_OPUS" && (t.isAudio || t.channels !== null || t.codecPrivate),
  );
  if (!opusTrack) return null;

  const packets = blocks
    .filter((b) => b.track === opusTrack.number)
    .flatMap((b) => b.frames)
    .filter((f) => f.length > 0);
  if (packets.length < 1) return null;

  let opusHead = opusTrack.codecPrivate;
  if (opusHead && opusHead.subarray(0, 8).toString("ascii") !== "OpusHead") opusHead = null;
  if (!opusHead) opusHead = defaultOpusHead(opusTrack.channels ?? 1);

  const channels = opusHead[9] ?? opusTrack.channels ?? 1;
  return { opusHead, channels, packets };
}

function defaultOpusHead(channels: number): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "ascii");
  b[8] = 1;
  b[9] = channels >= 1 && channels <= 2 ? channels : 1;
  b.writeUInt16LE(312, 10);
  b.writeUInt32LE(48000, 12);
  b.writeInt16LE(0, 16);
  b[18] = 0;
  return b;
}
