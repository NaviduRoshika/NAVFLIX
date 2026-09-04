'use strict';

// A QR encoder, written out rather than pulled in, because this project has no
// dependencies and one small generator is cheaper than that promise.
//
// Scope is deliberately narrow: byte mode, error correction level M, versions 1
// to 6 (up to 41x41). That covers a LAN URL with a pairing code on the end with
// room to spare, and stopping at version 6 avoids the version-information
// blocks that versions 7 and up require.
//
// Level M recovers from ~15% damage. Worth having: this gets photographed off a
// glossy laptop screen at an angle, in a dark room.

// ---------------------------------------------------------------- GF(256)
//
// Reed-Solomon works in a field of 256 elements. Multiplication is done by
// adding logarithms, so both tables are built once here.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;      // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// The generator polynomial for `degree` error correction codewords, which is
// (x - 2^0)(x - 2^1)...(x - 2^(degree-1)) multiplied out.
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// Polynomial long division; the remainder is the error correction block.
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

// ------------------------------------------------------------ version tables
//
// Per version at level M: error correction codewords per block, and the block
// layout as [blockCount, dataCodewordsPerBlock]. Totals are checked in tests.

const VERSIONS = {
  1: { ec: 10, blocks: [[1, 16]], align: [] },
  2: { ec: 16, blocks: [[1, 28]], align: [6, 18] },
  3: { ec: 26, blocks: [[1, 44]], align: [6, 22] },
  4: { ec: 18, blocks: [[2, 32]], align: [6, 26] },
  5: { ec: 24, blocks: [[2, 43]], align: [6, 30] },
  6: { ec: 16, blocks: [[4, 27]], align: [6, 34] },
};

function dataCapacity(version) {
  return VERSIONS[version].blocks.reduce((sum, [n, size]) => sum + n * size, 0);
}

// 4 bits of mode plus 8 bits of length sit in front of the payload, and a
// 4-bit terminator follows it: 2 bytes of overhead once rounded.
function pickVersion(byteLength) {
  for (let v = 1; v <= 6; v++) {
    if (byteLength + 2 <= dataCapacity(v)) return v;
  }
  throw new Error('QR payload too long: ' + byteLength + ' bytes');
}

// ------------------------------------------------------------------ encoding

function toCodewords(bytes, version) {
  const capacity = dataCapacity(version);
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                  // byte mode
  push(bytes.length, 8);            // length fits in 8 bits below version 10
  for (const b of bytes) push(b, 8);

  // Terminator, then pad to a byte boundary.
  const room = capacity * 8;
  for (let i = 0; i < 4 && bits.length < room; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    words.push(byte);
  }
  // Then the two alternating pad codewords, forever, until full.
  const PAD = [0xec, 0x11];
  while (words.length < capacity) words.push(PAD[(words.length - bits.length / 8) % 2]);

  return words;
}

// Split into blocks, compute each block's error correction, then interleave
// both sets. Interleaving is what lets a burst of damage hit many blocks
// lightly rather than destroying one completely.
function finalSequence(words, version) {
  const { ec, blocks } = VERSIONS[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let at = 0;
  for (const [count, size] of blocks) {
    for (let i = 0; i < count; i++) {
      const block = words.slice(at, at + size);
      at += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ec));
    }
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ec; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

// -------------------------------------------------------------------- matrix

function blankMatrix(size) {
  const m = [];
  for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
  return m;
}

function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = (r === 0 || r === 6 || c === 0 || c === 6);
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr][cc] = edge ? 0 : (ring || core ? 1 : 0);
    }
  }
}

function placeAlignment(m, version) {
  const centres = VERSIONS[version].align;
  if (!centres.length) return;
  for (const r of centres) {
    for (const c of centres) {
      // Skip the three corners already occupied by finder patterns.
      if (m[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = (ring === 1) ? 0 : 1;
        }
      }
    }
  }
}

function placeTiming(m) {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === null) m[6][i] = bit;
    if (m[i][6] === null) m[i][6] = bit;
  }
}

// The 15 format bits, BCH(15,5) protected and masked, written twice.
function formatBits(mask) {
  const ECC_M = 0b00;
  let value = (ECC_M << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  }
  return ((value << 10) | rem) ^ 0x5412;
}

// Both copies of the format information are written most significant bit
// first. Getting this backwards produces a symbol that looks perfect — every
// fixed pattern correct, every data module correct — and decodes in nothing,
// because a reader cannot work out the mask. Verified against a reference
// symbol from an independent generator rather than against our own reader,
// which shared the mistake and happily agreed with itself.
function placeFormat(m, mask) {
  const size = m.length;
  const bits = formatBits(mask);
  const at = (i) => (bits >> (14 - i)) & 1;

  // Copy one, wrapped around the top-left finder.
  const ring = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) m[ring[i][0]][ring[i][1]] = at(i);

  // Copy two: seven bits climbing beside the bottom-left finder, then eight
  // running along the top-right.
  for (let i = 0; i < 7; i++) m[size - 1 - i][8] = at(i);
  for (let i = 0; i < 8; i++) m[8][size - 8 + i] = at(7 + i);

  m[size - 8][8] = 1;               // the always-dark module
}

function reserveFormat(m) {
  const size = m.length;
  for (let i = 0; i <= 8; i++) {
    if (m[8][i] === null) m[8][i] = 2;
    if (m[i][8] === null) m[i][8] = 2;
  }
  for (let i = 0; i < 8; i++) {
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 2;
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 2;
  }
}

function maskFn(mask) {
  switch (mask) {
    case 0: return (r, c) => (r + c) % 2 === 0;
    case 1: return (r) => r % 2 === 0;
    case 2: return (r, c) => c % 3 === 0;
    case 3: return (r, c) => (r + c) % 3 === 0;
    case 4: return (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (r, c) => ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0;
    default: return (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
  }
}

// Zigzag up and down in two-column strips, right to left, skipping the
// vertical timing column.
function placeData(m, bytes, mask) {
  const size = m.length;
  const fn = maskFn(mask);
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;     // column 6 is timing, shift past it
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (m[row][col] !== null) continue;
        let bit = 0;
        if (bitIndex < bytes.length * 8) {
          bit = (bytes[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        m[row][col] = fn(row, col) ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }
}

// The four penalty rules from the specification. Lower is better; whichever
// mask scores lowest is the one a scanner will have the easiest time with.
function penalty(m) {
  const size = m.length;
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  for (let i = 0; i < size; i++) {
    score += runScore(m[i]);
    score += runScore(m.map((row) => row[i]));
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // The 1:1:3:1:1 finder-like sequence, in both orientations.
  const PATTERN = [1, 0, 1, 1, 1, 0, 1];
  const hasPattern = (line, at) => {
    for (let i = 0; i < 7; i++) if (line[at + i] !== PATTERN[i]) return false;
    const before = line.slice(Math.max(0, at - 4), at);
    const after = line.slice(at + 7, at + 11);
    const quiet = (arr) => arr.length >= 4 && arr.every((v) => v === 0);
    return quiet(before) || quiet(after);
  };
  for (let i = 0; i < size; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    for (let j = 0; j + 7 <= size; j++) {
      if (hasPattern(row, j)) score += 40;
      if (hasPattern(col, j)) score += 40;
    }
  }

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// ------------------------------------------------------------------- public

function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(bytes.length);
  const size = 17 + version * 4;
  const sequence = finalSequence(toCodewords(bytes, version), version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = blankMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlignment(m, version);
    placeTiming(m);
    reserveFormat(m);
    // The reserved cells were marked 2 so data placement skips them; clear
    // them back to null so the format bits can be written properly.
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (m[r][c] === 2) m[r][c] = null;
    }
    reserveFormat(m);
    placeData(m, sequence, mask);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (m[r][c] === 2) m[r][c] = 0;
    }
    placeFormat(m, mask);

    const p = penalty(m);
    if (!best || p < best.penalty) best = { matrix: m, penalty: p, mask: mask };
  }

  return { size: size, version: version, mask: best.mask, modules: best.matrix };
}

// A scalable image with a quiet zone, which scanners need to find the edges.
function toSvg(text, opts) {
  const o = opts || {};
  const quiet = o.quiet == null ? 4 : o.quiet;
  const scale = o.scale || 4;
  const dark = o.dark || '#000000';
  const light = o.light || '#ffffff';

  const qr = encode(text);
  const dim = (qr.size + quiet * 2) * scale;

  let path = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue;
      path += 'M' + ((c + quiet) * scale) + ' ' + ((r + quiet) * scale) +
        'h' + scale + 'v' + scale + 'h-' + scale + 'z';
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
    '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
    '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
    '<path d="' + path + '" fill="' + dark + '"/></svg>';
}

module.exports = { encode: encode, toSvg: toSvg };
