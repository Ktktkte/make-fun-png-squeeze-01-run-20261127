# BRIEF — png-squeeze-01-run-20261127

Competition: "Squeeze screenshots into the smallest PNG, 27 November 2026"
(program/v1, $100 over 50 places). Entries close Sat 2026-11-29 12:00 WIB.
Free entry, day cap 6, hard limit 40.

## What to build

`main.ts` (Node 22, built-ins only) losslessly recompresses 1280×720 RGBA
screenshot PNGs: read `$MAKEFUN_INPUT_DIR/<id>/image.png`, write the exact
same pixels to `$MAKEFUN_OUTPUT_DIR/<id>/image.png`, ≤4 MiB each, bit depth 8,
non-interlaced, only IHDR/PLTE/tRNS/IDAT/IEND chunks, IDAT a single zlib
stream. Whole set of 8 in 60 s wall, 512 MB, 1 CPU, run twice byte-identical,
no wall-clock reads. Repo ≤1 MiB total; entry size is the tie-break.

## Approach (implemented)

1. Own PNG decoder: parse chunks, inflate IDAT, unfilter (all 5 filters),
   handle colour types 0/2/3/4/6.
2. Analysis per image: opaque? grey? distinct colours (≤256 with counts)?
   single transparent value?
3. Candidate forms: palette by count, palette by luminance, channels form
   (grey→0/4, else→2/6, tRNS key when applicable). Palette forms are usually
   far smaller than RGBA on flat screenshots.
4. Per-row filter search per form: fixed filters 0–4, minimum-sum,
   fewest-distinct-byte-pairs, and brute force — each row's filter chosen by
   real zlib level-6 cost against the preceding 32 KiB of filtered data.
5. Screen: all candidates compressed at zlib level 6; best two re-encoded at
   level 9 with default + Z_FILTERED strategies; smallest total wins,
   including PLTE/tRNS chunk overhead.
6. Own PNG encoder: CRC32, single IDAT chunk.

## Results (kit practice set, scorer)

- Score **703,220 / 1,000,000**, all 8 instances answered, passed.
- Scale compressor ≈ 667,000; house fixed-Paeth baseline 420,399.
  A paid place needs strictly above the baseline — cleared by a wide margin.
- Per-instance points: i001 718,370 · i002 700,442 · i003 665,499 ·
  i004 692,958 · i005 742,251 · i006 690,285 · i007 701,871 · i008 714,083.
- Runtime ~17 s for the whole set (limit 60 s).

## What was tried and dropped

- A hand-written optimal-parsing DEFLATE encoder (hash-chain match finder +
  dynamic-programming parse + dynamic Huffman blocks) was built, debugged
  (found a cost-model bug: absent symbols scored as free), and measured:
  it produced larger streams than zlib level 9 on real filtered data
  (25,996 vs 18,491 bytes on i001) and took ~11 s per image. Removed
  entirely; the entry uses zlib level 9 only.

## v2 (2026-11-27) — optimal-parse retry, honest result: TIES v1

v1 drifted to rank 1,832/2,632 (outside the top-1,000 buffer), so v2
re-implemented the optimal-parse DEFLATE encoder from the kit SPEC plus a
fresh prose plan (not by copying v1's dropped attempt): hash-chain match
finder (multiplicative 3-byte hash, incremental chain insert), Pareto-frontier
match candidates (up to 6 per position), dynamic-programming parse with
iterated Huffman costs (4 iterations), fixed-vs-dynamic block choice, 1 MiB
blocks. `squeeze()` runs the optimal parser only on the top candidate and
only when the best zlib total is large (>120,000 bytes, i.e. i006 only);
otherwise it keeps zlib level 9. The optimal stream is used only when it
is strictly smaller than zlib-9.

Five encoder bugs were found and fixed in-session, all verified by
inflate round-trip on every practice image:
1. Match-finder chain built upfront for the whole block walked only future
   positions and found no matches (zeros-100k encoded as 12,512 B instead
   of ~120 B). Fixed with incremental chain insert.
2. Weak XOR 3-byte hash caused heavy collisions on periodic data.
   Fixed with a multiplicative hash and a 65,536-entry table.
3. `DataView.getUint32` match-length was very slow. Fixed with direct
   byte reads.
4. `huffmanLengths` overflow fix returned lengths up to 16 (> DEFLATE
   limit 15), corrupting the dynamic header's RLE (16 is the repeat
   symbol). Fixed with a guard: fall back to the always-valid fixed block
   when the dynamic tree is out of range or incomplete (integer Kraft-sum
   completeness check).
5. Root cause: the iterated DP priced symbols with Huffman length 0 as
   FREE, so it "discovered" literals that have no code and the encoder
   wrote 0 bits for them — streams looked smaller but were corrupt
   (decoded bytes missing/wrong). Fixed by building the trees from the
   very parse they encode (no re-parse after tree construction) and
   removing the frequency seeding that bloated the tree. Every earlier
   "optimal beats zlib-9" measurement came from those corrupt streams
   and is VOID — do not quote 714,886 / 719,742 / 706,289 as v2 scores.

Result after all fixes (all 8 practice images inflate correctly and
byte-identically): the valid optimal-parse streams LOSE to zlib level 9
on every image — i001 +27 B, i002 +12,633 B, i003 +9,828 B,
i004 +18,877 B, i005 −5 B (the only win, negligible), i006 +21,790 B,
i007 +10,936 B, i008 +6,348 B. The match finder itself is fine (99.6%
match coverage, avg best length ~145 on i002), but the encoded size is
worse — the match-finder / tree quality does not reach zopfli's, and
increasing the chain to 128 and the frontier to 12 pairs only flips i002
to a +189 B win while i006 still loses by ~15.8 KB. Re-ranking the top-4
(rather than top-2) candidates at level 9 gains 0 bytes; greedy
nearest-neighbour palette ordering changes nothing vs v1. So `squeeze()`
falls back to zlib-9 everywhere and **v2 scores 703,220 / 1,000,000 —
exactly v1's score, byte-identical output on all 8 images**. Runtime
~42 s for the whole set (limit 60 s). grade-local --driver process:
score 703,220, passed, 8/8 answered. Determinism 2× byte-identical,
/tmp-cwd exit 0, grader-style 2× as uid 65534 byte-identical.

Conclusion: a from-scratch optimal parser does not beat zlib-9 on this
data. A real improvement needs a zopfli-quality matcher (deeper chains,
lazy matching, better cost model) — a larger project than this v2.
Submitting this v2 would NOT improve the rank; it ties v1.

## Rules the entry follows

- Resolves files relative to the script file only; writes only to
  `$MAKEFUN_OUTPUT_DIR`; never removes the output dir; no clock, no
  randomness, no network.
- All entry code written directly in-session (write/edit calls). LICENSE
  carries an SPDX line; README carries the three live make.fun badges and
  the bounty link; `.makefun/owner.json` holds the account's payable wallet.
