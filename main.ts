// png-squeeze-01: lossless PNG recompressor.
//
// Reads /input/<id>/image.png (1280x720 RGBA screenshots) and writes the same
// pixels as the smallest PNG it can: colour-type reduction (palette / grey /
// grey+alpha / RGB / RGBA, with a tRNS key for a single transparent value),
// per-row filter search (fixed filters, minimum-sum, fewest-pairs, and brute
// force by real deflate cost), then zlib level 9. Deterministic: no clock, no
// randomness, no environment variation — the same input always gives the same
// bytes. Node 22, built-ins only.
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
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
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
    // palette: PLTE holds RGB, tRNS holds alpha per entry.
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

function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance'): PaletteForm {
  const lum = (c: Colour) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
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

function filtered(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: number | 'minsum' | 'pairs' | 'brute',
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
  filters: Array<number | 'minsum' | 'pairs' | 'brute'>;
}

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL = { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL_FILTERED = { level: 9, memLevel: 9, strategy: constants.Z_FILTERED };

function formsOf(rgba: Uint8Array, a: Analysis): Form[] {
  const forms: Form[] = [];
  if (a.colours !== null) {
    for (const order of ['count', 'luminance'] as const) {
      const p = paletteForm(rgba, a.colours, order);
      forms.push({
        colourType: 3,
        bpp: 1,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        filters: [0, 'minsum', 'brute'],
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

/** Squeeze one image: screen every form/filter at zlib level 6, re-encode the
 *  best two at level 9 (default and filtered strategies), keep the smallest. */
function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const a = analyse(rgba);
  const forms = formsOf(rgba, a);
  interface Cand {
    form: Form;
    choice: number | 'minsum' | 'pairs' | 'brute';
    data: Uint8Array;
    bytes: number;
  }
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
  let bestDesc = '';
  for (const c of top) {
    for (const opts of [FINAL, FINAL_FILTERED]) {
      const z = deflateSync(c.data, opts);
      const total = z.length + chunkOverhead(c.form);
      if (total < bestBytes) {
        bestBytes = total;
        bestDesc = `ct=${c.form.colourType} filters=${String(c.choice)} strat=${opts.strategy === constants.Z_FILTERED ? 'filtered' : 'default'} bytes=${total}`;
        best = pngOfForm(width, height, c.form.colourType, c.form.plte, c.form.trns, new Uint8Array(z.buffer, z.byteOffset, z.length));
      }
    }
  }
  if (process.env.PNG_DEBUG) console.error(bestDesc);
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
