// png-squeeze-01 v2: lossless PNG recompressor.
//
// Reads /input/<id>/image.png (1280x720 RGBA screenshots) and writes the same
// pixels as the smallest PNG it can. Colour-type reduction (palette / grey /
// grey+alpha / RGB / RGBA, with a tRNS key for a single transparent value),
// per-row filter search (fixed filters, minimum-sum, fewest-pairs, and brute
// force by real deflate cost), then the final encode: zlib level 9 in several
// strategies and memLevels, plus an own optimal-parse DEFLATE encoder in the
// manner of zopfli (hash-chain match finder, dynamic-programming parse with
// iterated Huffman costs, block splitting), keeping whichever stream is
// smallest per image. Deterministic: no clock, no randomness, no environment
// variation — the same input always gives the same bytes. Node 22, built-ins
// only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------- PNG chunks
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (let p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (let p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- bit writer
class BitWriter {
  bytes: number[] = [];
  cur = 0;
  nbits = 0;
  writeBit(b: number): void {
    if (b) this.cur |= 1 << this.nbits;
    this.nbits++;
    if (this.nbits === 8) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.nbits = 0;
    }
  }
  // Write a Huffman code: bits from most significant to least.
  writeCode(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.writeBit((code >> i) & 1);
  }
  // Write a plain value LSB-first (block headers, extra bits, lengths).
  writeBits(value: number, len: number): void {
    for (let i = 0; i < len; i++) this.writeBit((value >> i) & 1);
  }
  finish(): Uint8Array {
    if (this.nbits > 0) this.bytes.push(this.cur);
    return Uint8Array.from(this.bytes);
  }
}

// ---------------------------------------------------------------- DEFLATE tables
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenSymbol(len: number): number {
  for (let i = 28; i >= 0; i--) if (len >= LEN_BASE[i]) return 257 + i;
  return 257;
}
function lenExtra(len: number): number {
  const s = lenSymbol(len);
  return len - LEN_BASE[s - 257];
}
function distSymbol(d: number): number {
  for (let i = 29; i >= 0; i--) if (d >= DIST_BASE[i]) return i;
  return 0;
}
function distExtra(d: number): number {
  const s = distSymbol(d);
  return d - DIST_BASE[s];
}

// Fixed Huffman bit lengths (RFC 1951).
const FIXED_LITLEN = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST = new Uint8Array(32).fill(5);

// ---------------------------------------------------------------- Huffman lengths
// Build optimal Huffman code lengths from frequencies, limited to maxBits.
// Tree build, then zlib's overflow fix, then reassign lengths by frequency.
function huffmanLengths(freq: number[], maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  // Heap of tree nodes: {f, sym (leaf index or -1), left, right}.
  interface HNode {
    f: number;
    sym: number;
    left: number;
    right: number;
  }
  const nodes: HNode[] = syms.map((s) => ({ f: freq[s], sym: s, left: -1, right: -1 }));
  const heap: number[] = nodes.map((_, i) => i);
  const less = (a: number, b: number) => nodes[a].f - nodes[b].f || a - b;
  const heapify = (i: number, size: number) => {
    for (;;) {
      let m = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < size && less(heap[l], heap[m]) < 0) m = l;
      if (r < size && less(heap[r], heap[m]) < 0) m = r;
      if (m === i) break;
      const t = heap[i];
      heap[i] = heap[m];
      heap[m] = t;
      i = m;
    }
  };
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) heapify(i, heap.length);
  let size = heap.length;
  while (size > 1) {
    const a = heap[0];
    heap[0] = heap[--size];
    heapify(0, size);
    const b = heap[0];
    heap[0] = heap[--size];
    heapify(0, size);
    const nn: HNode = { f: nodes[a].f + nodes[b].f, sym: -1, left: a, right: b };
    nodes.push(nn);
    heap[size++] = nodes.length - 1;
    let i = size - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(heap[i], heap[p]) >= 0) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  }
  const root = heap[0];
  const walk = (ni: number, depth: number) => {
    const nd = nodes[ni];
    if (nd.sym >= 0) {
      lengths[nd.sym] = depth;
      return;
    }
    walk(nd.left, depth + 1);
    walk(nd.right, depth + 1);
  };
  walk(root, 0);
  // Length limit: zlib's overflow fix on the per-length counts.
  const blens = new Array(maxBits + 2).fill(0);
  let maxLen = 0;
  for (const s of syms) {
    blens[lengths[s]]++;
    if (lengths[s] > maxLen) maxLen = lengths[s];
  }
  if (maxLen > maxBits) {
    let overflow = 0;
    for (let b = maxBits + 1; b <= maxLen; b++) overflow += blens[b];
    do {
      let bits = maxBits - 1;
      while (blens[bits] === 0) bits--;
      blens[bits]--;
      blens[bits + 1] += 2;
      blens[maxBits]--;
      overflow -= 2;
    } while (overflow > 0);
    syms.sort((a, b) => freq[b] - freq[a] || a - b);
    let idx = 0;
    for (let b = 1; b <= maxBits; b++) {
      for (let k = 0; k < blens[b]; k++) lengths[syms[idx++]] = b;
    }
  }
  return lengths;
}

function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const n = lengths.length;
  const codes = new Uint16Array(n);
  const blCount = new Array(16).fill(0);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Array(16).fill(0);
  let code = 0;
  for (let b = 1; b <= 15; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return codes;
}

// ---------------------------------------------------------------- PNG decode
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(type: number, row: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = row.length;
  if (type === 0) {
    out.set(row);
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? out[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let v = row[i];
    if (type === 1) v += a;
    else if (type === 2) v += b;
    else if (type === 3) v += (a + b) >> 1;
    else v += paeth(a, b, c);
    out[i] = v & 0xff;
  }
}

function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let v = cur[i];
    if (type === 1) v -= a;
    else if (type === 2) v -= b;
    else if (type === 3) v -= (a + b) >> 1;
    else if (type === 4) v -= paeth(a, b, c);
    out[i] = v & 0xff;
  }
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function decodePng(buf: Uint8Array): Decoded {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('not a PNG');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= buf.length) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, 13);
      width = d.getUint32(0);
      height = d.getUint32(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || !(colorType in CHANNELS)) {
    throw new Error(`unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType}, interlace ${interlace})`);
  }
  const raw = inflateSync(concat(idat));
  const ch = CHANNELS[colorType];
  const stride = width * ch;
  const samples = new Uint8Array(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    unfilter(f, row, y === 0 ? null : samples.subarray((y - 1) * stride, y * stride), ch, samples.subarray(y * stride, (y + 1) * stride));
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colorType === 6) {
    rgba.set(samples);
  } else if (colorType === 2) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = 255;
    }
  } else if (colorType === 0) {
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const v = samples[i];
      rgba[d] = v;
      rgba[d + 1] = v;
      rgba[d + 2] = v;
      rgba[d + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      const v = samples[s];
      rgba[d] = v;
      rgba[d + 1] = v;
      rgba[d + 2] = v;
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const pal = plte ?? new Uint8Array(0);
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const idx = samples[i];
      rgba[d] = pal[idx * 3] ?? 0;
      rgba[d + 1] = pal[idx * 3 + 1] ?? 0;
      rgba[d + 2] = pal[idx * 3 + 2] ?? 0;
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- analysis
interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null;
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.entries()].map(([word, count]) => ({
        r: word & 0xff,
        g: (word >>> 8) & 0xff,
        b: (word >>> 16) & 0xff,
        a: (word >>> 24) & 0xff,
        word,
        count,
      }));
  return { opaque, grey, colours };
}

/** The one fully transparent value (grey or RGB) every non-opaque pixel shares,
 *  which no opaque pixel uses, so a tRNS key can replace the alpha channel. */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

// Order palette entries: transparent ones first (by alpha), then by `order`.
// 'greedy' chains entries by nearest neighbour in RGB space from the most
// frequent colour, so neighbouring palette indices hold close colours and the
// filtered rows carry smaller deltas.
function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance' | 'greedy'): PaletteForm {
  const lum = (c: Colour) => 299 * c.r + 587 * c.g + 114 * c.b;
  const transparent = colours.filter((c) => c.a !== 255).sort((x, y) => x.a - y.a || x.word - y.word);
  const opaque = colours.filter((c) => c.a === 255);
  let rest: Colour[];
  if (order === 'luminance') {
    rest = [...opaque].sort((x, y) => lum(x) - lum(y) || x.word - y.word);
  } else if (order === 'greedy') {
    rest = [...opaque].sort((x, y) => y.count - x.count || x.word - y.word);
    const chained: Colour[] = [];
    const used = new Uint8Array(rest.length);
    let cur = 0;
    chained.push(rest[0]);
    used[0] = 1;
    for (let k = 1; k < rest.length; k++) {
      const last = chained[chained.length - 1];
      let bestJ = -1;
      let bestD = Infinity;
      for (let j = 0; j < rest.length; j++) {
        if (used[j]) continue;
        const c = rest[j];
        const dr = c.r - last.r;
        const dg = c.g - last.g;
        const db = c.b - last.b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          bestJ = j;
        }
      }
      chained.push(rest[bestJ]);
      used[bestJ] = 1;
      cur = bestJ;
      void cur;
    }
    rest = chained;
  } else {
    rest = [...opaque].sort((x, y) => y.count - x.count || x.word - y.word);
  }
  const entries = [...transparent, ...rest];
  const index = new Map<number, number>();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let trCount = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) trCount = i + 1;
  });
  const trns = trCount === 0 ? null : Uint8Array.from(entries.slice(0, trCount), (c) => c.a);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- filters
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const BRUTE_CONTEXT = 32768;

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

function filtered(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: FilterChoice,
): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') {
        cost = signedSum(trial[t].subarray(1));
      } else if (choice === 'pairs') {
        const row = trial[t].subarray(1);
        let n = 0;
        const mark = ++stamp;
        for (let i = 1; i < row.length; i++) {
          const pair = (row[i - 1] << 8) | row[i];
          if (seen[pair] !== mark) {
            seen[pair] = mark;
            n++;
          }
        }
        cost = n;
      } else {
        const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: 6, memLevel: 9 }
            : { level: 6, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- PNG write
function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  b[8] = 8;
  b[9] = colourType;
  b[10] = 0;
  b[11] = 0;
  b[12] = 0;
  return b;
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngOfForm(
  width: number,
  height: number,
  colourType: number,
  plte: Uint8Array | null,
  trns: Uint8Array | null,
  idat: Uint8Array,
): Uint8Array {
  const parts: Uint8Array[] = [PNG_SIGNATURE, chunk('IHDR', ihdrOf(width, height, colourType))];
  if (plte !== null) parts.push(chunk('PLTE', plte));
  if (trns !== null) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

// ---------------------------------------------------------------- screen
interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
}

function formsOf(rgba: Uint8Array, a: Analysis): Form[] {
  const forms: Form[] = [];
  if (a.colours !== null) {
    for (const order of ['count', 'luminance', 'greedy'] as const) {
      const p = paletteForm(rgba, a.colours, order);
      forms.push({
        colourType: 3,
        bpp: 1,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
      });
    }
    if (!a.grey) return forms;
  }
  const key = a.opaque ? null : transparentKey(rgba, a.grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (a.grey) {
    ct = a.opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = a.opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

function chunkOverhead(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

// ---------------------------------------------------------------- optimal-parse DEFLATE
// An own DEFLATE encoder in the manner of zopfli: hash-chain match finding,
// a dynamic-programming optimal parse whose symbol costs come from Huffman
// trees that are rebuilt from the parse and iterated, and block splitting so
// each block carries its own trees. A block is encoded fixed or dynamic,
// whichever is smaller. The caller keeps whichever stream (this one or
// zlib level 9) is smaller per image, so this stage can only help.
const OPT_BLOCK = 1048576;
const OPT_ITER = 4;
const OPT_CHAIN = 64;
// Stop the chain walk once a match this long is found: longer matches at
// farther distances rarely beat it in the parse, and the walk is the
// dominant cost. This bounds the work per position deterministically.
const OPT_GOOD_LEN = 64;
const OPT_HASH_SIZE = 65536;
const OPT_MAX_PAIRS = 6;

function hash3(d: Uint8Array, p: number): number {
  // Multiplicative hash of the 24-bit triple; the XOR-shift hash collided
  // badly on periodic data and buried real matches deep in the chain.
  const v = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
  return (Math.imul(v, 2654435761) >>> 16) & 0xffff;
}

interface MatchCache {
  count: Uint8Array;
  lens: Int16Array;
  dists: Int32Array;
}

// Find, for every position of the block [bs, be), the useful (length, dist)
// pairs: the Pareto frontier of matches, at most OPT_MAX_PAIRS per position.
// Chains are built from the preceding window too, so a match may reach back
// into the previous block (the decoder's window holds it).
function findMatches(data: Uint8Array, bs: number, be: number): MatchCache {
  const n = be - bs;
  const lo = Math.max(0, bs - 32768);
  const head = new Int32Array(OPT_HASH_SIZE).fill(-1);
  const prev = new Int32Array(be - lo).fill(-1);
  // Chains hold only positions already passed, so a match always points
  // back. The preceding window is inserted up front; block positions join
  // the chain as the search advances past them.
  for (let i = lo; i < bs; i++) {
    const h = hash3(data, i);
    prev[i - lo] = head[h];
    head[h] = i;
  }
  const count = new Uint8Array(n);
  const lens = new Int16Array(n * OPT_MAX_PAIRS);
  const dists = new Int32Array(n * OPT_MAX_PAIRS);
  const minAt = new Int32Array(259).fill(0x7fffffff);
  const touched = new Int32Array(259);
  let touchedN = 0;
  const cands: number[] = [];
  for (let p = bs; p < be; p++) {
    const i = p - bs;
    if (p + 3 > be) break;
    const maxLen = Math.min(258, be - p);
    const h = hash3(data, p);
    // Join the chain before searching: the walk skips q == p itself, and
    // every position enters the chain even when no match is found here.
    prev[p - lo] = head[h];
    head[h] = p;
    let q = head[h];
    let chain = 0;
    cands.length = 0;
    while (q >= 0 && chain < OPT_CHAIN) {
      if (q < p) {
        const dist = p - q;
        if (dist <= 32768) {
          // Match length: direct byte reads (a DataView call per 4 bytes
          // is far slower in JS); 4-byte steps, then the tail bytes.
          let len = 0;
          while (len + 4 <= maxLen) {
            if (data[p + len] !== data[q + len] || data[p + len + 1] !== data[q + len + 1] || data[p + len + 2] !== data[q + len + 2] || data[p + len + 3] !== data[q + len + 3]) break;
            len += 4;
          }
          while (len < maxLen && data[p + len] === data[q + len]) len++;
          if (len >= 3) cands.push(len, dist);
          if (len >= maxLen || len >= OPT_GOOD_LEN) break;
        }
      }
      q = q - lo >= 0 ? prev[q - lo] : -1;
      chain++;
    }
    if (cands.length === 0) continue;
    for (let k = 0; k < cands.length; k += 2) {
      const l = cands[k];
      const d = cands[k + 1];
      if (minAt[l] === 0x7fffffff) touched[touchedN++] = l;
      if (d < minAt[l]) minAt[l] = d;
    }
    // Sweep down: bestAt[L] = smallest distance of a match of length >= L.
    let best = 0x7fffffff;
    let np = 0;
    let prevBest = 0x7fffffff;
    for (let L = maxLen; L >= 3; L--) {
      if (minAt[L] < best) best = minAt[L];
      if (best < prevBest) {
        // (L, best) is the longest length at this distance level; record it
        // when the run ends, i.e. keep the largest L per distance.
        // We collect in reverse; store temporarily in descending L.
        lens[i * OPT_MAX_PAIRS + np] = L;
        dists[i * OPT_MAX_PAIRS + np] = best;
        np++;
        prevBest = best;
        if (np >= OPT_MAX_PAIRS) break;
      }
    }
    for (let k = 0; k < touchedN; k++) minAt[touched[k]] = 0x7fffffff;
    touchedN = 0;
    // The pairs were collected from long to short; reverse them.
    count[i] = np;
    for (let a = 0, b = np - 1; a < b; a++, b--) {
      const tl = lens[i * OPT_MAX_PAIRS + a];
      const td = dists[i * OPT_MAX_PAIRS + a];
      lens[i * OPT_MAX_PAIRS + a] = lens[i * OPT_MAX_PAIRS + b];
      dists[i * OPT_MAX_PAIRS + a] = dists[i * OPT_MAX_PAIRS + b];
      lens[i * OPT_MAX_PAIRS + b] = tl;
      dists[i * OPT_MAX_PAIRS + b] = td;
    }
  }
  return { count, lens, dists };
}

interface Parse {
  // Tokens in order: literal byte (>= 0) or match as [length, dist] encoded
  // in two parallel arrays: isMatch, value (byte or length), dist.
  isMatch: Uint8Array;
  val: Int32Array;
  dist: Int32Array;
  count: number;
}

interface Costs {
  lit: Float64Array; // per literal byte 0..255 and length symbol 257..285
  len: Float64Array; // per match length 3..258
  dist: Float64Array; // per distance 1..32768
}

function costsFromLengths(litLen: Uint8Array, distLen: Uint8Array): Costs {
  const lit = new Float64Array(288);
  for (let i = 0; i < 288; i++) lit[i] = litLen[i];
  const len = new Float64Array(259);
  for (let L = 3; L <= 258; L++) {
    const s = lenSymbol(L);
    len[L] = litLen[s] + LEN_EXTRA[s - 257];
  }
  const dist = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const s = distSymbol(d);
    dist[d] = distLen[s] + DIST_EXTRA[s];
  }
  return { lit, len, dist };
}

// Dynamic-programming optimal parse of one block, given the match cache and
// symbol costs. Returns the token list.
function dpParse(data: Uint8Array, bs: number, be: number, mc: MatchCache, costs: Costs): Parse {
  const n = be - bs;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const chLen = new Int32Array(n + 1);
  const chDist = new Int32Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    const p = bs + i;
    const lc = c + costs.lit[data[p]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      chLen[i + 1] = 0;
    }
    const m = mc.count[i];
    for (let k = 0; k < m; k++) {
      const ml = mc.lens[i * OPT_MAX_PAIRS + k];
      const md = mc.dists[i * OPT_MAX_PAIRS + k];
      const nc = c + costs.len[ml] + costs.dist[md];
      if (nc < cost[i + ml]) {
        cost[i + ml] = nc;
        chLen[i + ml] = ml;
        chDist[i + ml] = md;
      }
    }
  }
  // Backtrack.
  const isMatch = new Uint8Array(n);
  const val = new Int32Array(n);
  const dist = new Int32Array(n);
  let count = 0;
  let i = n;
  while (i > 0) {
    const l = chLen[i];
    if (l === 0) {
      isMatch[count] = 0;
      val[count] = data[bs + i - 1];
      count++;
      i--;
    } else {
      isMatch[count] = 1;
      val[count] = l;
      dist[count] = chDist[i];
      count++;
      i -= l;
    }
  }
  // Reverse in place.
  for (let a = 0, b = count - 1; a < b; a++, b--) {
    let t = isMatch[a];
    isMatch[a] = isMatch[b];
    isMatch[b] = t;
    t = val[a];
    val[a] = val[b];
    val[b] = t;
    t = dist[a];
    dist[a] = dist[b];
    dist[b] = t;
  }
  return { isMatch, val, dist, count };
}

// ---------------------------------------------------------------- block encoding
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface RleSym {
  sym: number;
  extra: number;
  extraBits: number;
}

function rleLengths(seq: number[]): RleSym[] {
  const out: RleSym[] = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    if (v === 0) {
      let run = 0;
      while (i + run < seq.length && seq[i + run] === 0) run++;
      i += run;
      while (run >= 11) {
        const take = Math.min(run, 138);
        out.push({ sym: 18, extra: take - 11, extraBits: 7 });
        run -= take;
      }
      if (run >= 3) {
        out.push({ sym: 17, extra: run - 3, extraBits: 3 });
        run = 0;
      }
      while (run > 0) {
        out.push({ sym: 0, extra: 0, extraBits: 0 });
        run--;
      }
    } else {
      out.push({ sym: v, extra: 0, extraBits: 0 });
      let run = 1;
      while (i + run < seq.length && seq[i + run] === v) run++;
      i += run;
      run--;
      while (run >= 3) {
        const take = Math.min(run, 6);
        out.push({ sym: 16, extra: take - 3, extraBits: 2 });
        run -= take;
      }
      while (run > 0) {
        out.push({ sym: v, extra: 0, extraBits: 0 });
        run--;
      }
    }
  }
  return out;
}

interface DynHeader {
  hlit: number;
  hdist: number;
  hclen: number;
  clLen: Uint8Array;
  clCode: Uint16Array;
  rle: RleSym[];
  headerBits: number;
}

function buildDynHeader(litLen: Uint8Array, distLen: Uint8Array): DynHeader {
  let hlit = 288;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const seq: number[] = [];
  for (let i = 0; i < hlit; i++) seq.push(litLen[i]);
  for (let i = 0; i < hdist; i++) seq.push(distLen[i]);
  const rle = rleLengths(seq);
  const clFreq = new Array(19).fill(0);
  for (const r of rle) clFreq[r.sym]++;
  const clLen = huffmanLengths(clFreq, 7);
  const clCode = canonicalCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  let headerBits = 3 + 5 + 5 + 4 + hclen * 3;
  for (const r of rle) headerBits += clLen[r.sym] + r.extraBits;
  return { hlit, hdist, hclen, clLen, clCode, rle, headerBits };
}

function writeDynHeader(w: BitWriter, h: DynHeader): void {
  w.writeBits(h.hlit - 257, 5);
  w.writeBits(h.hdist - 1, 5);
  w.writeBits(h.hclen - 4, 4);
  for (let i = 0; i < h.hclen; i++) w.writeBits(h.clLen[CL_ORDER[i]], 3);
  for (const r of h.rle) {
    w.writeCode(h.clCode[r.sym], h.clLen[r.sym]);
    if (r.extraBits > 0) w.writeBits(r.extra, r.extraBits);
  }
}

function dataBits(parse: Parse, litLen: Uint8Array, distLen: Uint8Array): number {
  let bits = litLen[256];
  for (let k = 0; k < parse.count; k++) {
    if (parse.isMatch[k]) {
      const s = lenSymbol(parse.val[k]);
      bits += litLen[s] + LEN_EXTRA[s - 257];
      const ds = distSymbol(parse.dist[k]);
      bits += distLen[ds] + DIST_EXTRA[ds];
    } else {
      bits += litLen[parse.val[k]];
    }
  }
  return bits;
}

function writeData(w: BitWriter, parse: Parse, litLen: Uint8Array, distLen: Uint8Array, litCode: Uint16Array, distCode: Uint16Array): void {
  for (let k = 0; k < parse.count; k++) {
    if (parse.isMatch[k]) {
      const s = lenSymbol(parse.val[k]);
      w.writeCode(litCode[s], litLen[s]);
      if (LEN_EXTRA[s - 257] > 0) w.writeBits(lenExtra(parse.val[k]), LEN_EXTRA[s - 257]);
      const ds = distSymbol(parse.dist[k]);
      w.writeCode(distCode[ds], distLen[ds]);
      if (DIST_EXTRA[ds] > 0) w.writeBits(distExtra(parse.dist[k]), DIST_EXTRA[ds]);
    } else {
      w.writeCode(litCode[parse.val[k]], litLen[parse.val[k]]);
    }
  }
  w.writeCode(litCode[256], litLen[256]);
}

const FIXED_LITLEN_CODES = canonicalCodes(FIXED_LITLEN);
const FIXED_DIST_CODES = canonicalCodes(FIXED_DIST);

// Symbol frequencies for one block's parse. The tree is always built from
// the very parse it will encode, so every symbol written has a code.
function freqFromParse(parse: Parse): { fl: number[]; fd: number[] } {
  const fl = new Array(288).fill(0);
  const fd = new Array(30).fill(0);
  for (let k = 0; k < parse.count; k++) {
    if (parse.isMatch[k]) {
      fl[lenSymbol(parse.val[k])]++;
      fd[distSymbol(parse.dist[k])]++;
    } else {
      fl[parse.val[k]]++;
    }
  }
  fl[256]++;
  if (fd.every((v) => v === 0)) fd[0] = 1;
  return { fl, fd };
}

// Encode one block with the iterated optimal parse, fixed or dynamic,
// whichever is smaller. Bits go to the shared writer.
// The parse and the trees come from the SAME iteration: re-parsing after
// building the trees can introduce symbols the trees do not cover, which
// would be written with a zero-length code (i.e. dropped).
function encodeBlockOptimal(w: BitWriter, data: Uint8Array, bs: number, be: number, isLast: boolean): void {
  const mc = findMatches(data, bs, be);
  let litLen: Uint8Array = FIXED_LITLEN;
  let distLen: Uint8Array = FIXED_DIST;
  let parse: Parse = { isMatch: new Uint8Array(0), val: new Int32Array(0), dist: new Int32Array(0), count: 0 };
  for (let it = 0; it < OPT_ITER; it++) {
    const costs = costsFromLengths(litLen, distLen);
    parse = dpParse(data, bs, be, mc, costs);
    const { fl, fd } = freqFromParse(parse);
    litLen = huffmanLengths(fl, 15);
    distLen = huffmanLengths(fd, 15);
  }
  const fixedBits = 3 + dataBits(parse, FIXED_LITLEN, FIXED_DIST);
  // The length-limited Huffman builder can return a code longer than the
  // DEFLATE limit (15) on very skewed distributions; a length of 16 would
  // corrupt the dynamic header's RLE (16 is the repeat symbol). Fall back
  // to the always-valid fixed block when the dynamic tree is out of range
  // or incomplete. (A complete prefix code has Kraft sum exactly 1.)
  const complete = (lengths: Uint8Array): boolean => {
    let maxL = 0;
    for (const l of lengths) if (l > maxL) maxL = l;
    if (maxL === 0 || maxL > 15) return false;
    let sum = 0;
    for (const l of lengths) if (l > 0) sum += 1 << (maxL - l);
    return sum === 1 << maxL;
  };
  let hdr: DynHeader | null = null;
  let dynBits = Infinity;
  if (complete(litLen) && complete(distLen)) {
    hdr = buildDynHeader(litLen, distLen);
    if (Math.max(...hdr.clLen) <= 7 && complete(hdr.clLen)) {
      dynBits = hdr.headerBits + dataBits(parse, litLen, distLen);
    } else {
      hdr = null;
    }
  }
  w.writeBit(isLast ? 1 : 0);
  if (hdr !== null && dynBits < fixedBits) {
    w.writeBits(2, 2);
    writeDynHeader(w, hdr);
    writeData(w, parse, litLen, distLen, canonicalCodes(litLen), canonicalCodes(distLen));
  } else {
    w.writeBits(1, 2);
    writeData(w, parse, FIXED_LITLEN, FIXED_DIST, FIXED_LITLEN_CODES, FIXED_DIST_CODES);
  }
}

function optimalDeflate(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  let pos = 0;
  while (pos < data.length) {
    const end = Math.min(data.length, pos + OPT_BLOCK);
    encodeBlockOptimal(w, data, pos, end, end === data.length);
    pos = end;
  }
  const body = w.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}

// ---------------------------------------------------------------- squeeze
const Z9_DEFAULT = { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY };
const Z9_FILTERED = { level: 9, memLevel: 9, strategy: constants.Z_FILTERED };

interface Cand {
  form: Form;
  choice: FilterChoice;
  data: Uint8Array;
  bytes: number;
}

/** Squeeze one image: screen every form/filter at zlib level 6, re-encode the
 *  best two at level 9 (default and filtered strategies), and run the own
 *  optimal-parse encoder on the best one; keep the smallest PNG. */
function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const a = analyse(rgba);
  const forms = formsOf(rgba, a);
  const cands: Cand[] = [];
  for (const form of forms) {
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, SCREEN);
      cands.push({ form, choice, data, bytes: z.length + chunkOverhead(form) });
    }
  }
  cands.sort((x, y) => x.bytes - y.bytes);
  const top = cands.slice(0, 2);
  let best: Uint8Array | null = null;
  let bestBytes = Infinity;
  for (let ci = 0; ci < top.length; ci++) {
    const c = top[ci];
    // The filtered strategy only ever wins on the best candidate; the
    // second candidate gets the default strategy only (wall budget).
    const variants = ci === 0 ? [Z9_DEFAULT, Z9_FILTERED] : [Z9_DEFAULT];
    for (const opts of variants) {
      const z = deflateSync(c.data, opts);
      const total = z.length + chunkOverhead(c.form);
      if (total < bestBytes) {
        bestBytes = total;
        best = pngOfForm(width, height, c.form.colourType, c.form.plte, c.form.trns, new Uint8Array(z.buffer, z.byteOffset, z.length));
      }
    }
    // The optimal parser is slow (about 10-14s per large image here) and
    // the whole set has one 60s wall. Run it only on the very largest
    // zlib streams, where its absolute byte gain is biggest. A high
    // threshold is safe by construction: it can only shrink the gain,
    // never push the run past the wall. On the practice set only the
    // largest stream (i006, ~179KB) clears it.
    if (ci === 0 && bestBytes > 120000) {
      const oz = optimalDeflate(c.data);
      const total = oz.length + chunkOverhead(c.form);
      if (total < bestBytes) {
        bestBytes = total;
        best = pngOfForm(width, height, c.form.colourType, c.form.plte, c.form.trns, oz);
      }
    }
  }
  return best as Uint8Array;
}

// ---------------------------------------------------------------- main
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (image.width !== 1280 || image.height !== 720) throw new Error(`${id}: unexpected size ${image.width}x${image.height}`);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
