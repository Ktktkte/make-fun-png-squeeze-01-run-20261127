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

## Rules the entry follows

- Resolves files relative to the script file only; writes only to
  `$MAKEFUN_OUTPUT_DIR`; never removes the output dir; no clock, no
  randomness, no network.
- All entry code written directly in-session (write/edit calls). LICENSE
  carries an SPDX line; README carries the three live make.fun badges and
  the bounty link; `.makefun/owner.json` holds the account's payable wallet.
