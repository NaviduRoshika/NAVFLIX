'use strict';
/*
 * probe.js — what is actually inside a video file.
 *
 * Resolution, codecs, audio and subtitle tracks, real duration. No ffprobe, no
 * ffmpeg, no npm: every container writes a table of its streams into a header,
 * and this reads that header directly.
 *
 * Two formats cover a media library almost entirely:
 *
 *   Matroska (.mkv, .webm)  EBML — nested "id, length, payload" triplets.
 *   ISO base media (.mp4, .m4v, .mov)  atoms — nested "length, name, payload".
 *
 * Anything else (.avi, .ts, ...) returns nothing and the caller falls back to
 * what the filename claims. That is a rounding error on a real shelf: of 939
 * files here, 938 are one of the two formats above.
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ Matroska
 *
 * Every element is <id><size><payload>, both id and size written as a "vint"
 * whose leading zero bits say how many bytes it occupies. Master elements hold
 * more elements; the rest hold a number, a string or a float.
 */

const EBML = {
  SEGMENT: 0x18538067, INFO: 0x1549A966, TRACKS: 0x1654AE6B, TRACK_ENTRY: 0xAE,
  VIDEO: 0xE0, AUDIO: 0xE1,
  TRACK_TYPE: 0x83, LANGUAGE: 0x22B59C, LANG_BCP47: 0x22B59D,
  CODEC_ID: 0x86, NAME: 0x536E, FLAG_DEFAULT: 0x88, FLAG_FORCED: 0x55AA,
  PIXEL_W: 0xB0, PIXEL_H: 0xBA, DISPLAY_W: 0x54B0, DISPLAY_H: 0x54BA,
  CHANNELS: 0x9F, SAMPLE_RATE: 0xB5,
  DURATION: 0x4489, TIMECODE_SCALE: 0x2AD7B1,
};

const TRACK_TYPES = { 1: 'video', 2: 'audio', 17: 'subtitle' };

function readVint(buf, pos, keepMarker) {
  const b = buf[pos];
  if (b === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b & mask)) { mask >>= 1; len++; }
  if (len > 8) return null;
  let value = keepMarker ? b : (b & (mask - 1));
  let unknown = !keepMarker && (b & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    const nb = buf[pos + i];
    if (nb === undefined) return null;
    value = value * 256 + nb;
    if (nb !== 0xFF) unknown = false;
  }
  return { value: value, len: len, unknown: unknown };
}

function ebmlUint(b) { let v = 0; for (const x of b) v = v * 256 + x; return v; }
function ebmlStr(b) { return b.toString('utf8').replace(/\0+$/, ''); }
function ebmlFloat(b) {
  if (b.length === 4) return b.readFloatBE(0);
  if (b.length === 8) return b.readDoubleBE(0);
  return 0;
}

// `out` is the array of tracks; `out.info` collects the segment-level fields.
// Video and Audio are nested one level below the track they describe, so the
// walk descends into them carrying the same entry.
function ebmlWalk(buf, start, end, entry, out) {
  let pos = start;
  while (pos < end) {
    const id = readVint(buf, pos, true);
    if (!id) return;
    const size = readVint(buf, pos + id.len, false);
    if (!size) return;
    const body = pos + id.len + size.len;
    const stop = size.unknown ? end : Math.min(end, body + size.value);

    if (id.value === EBML.SEGMENT || id.value === EBML.TRACKS) {
      ebmlWalk(buf, body, stop, null, out);
    } else if (id.value === EBML.INFO) {
      ebmlWalk(buf, body, stop, out.info, out);
    } else if (id.value === EBML.TRACK_ENTRY) {
      const t = {};
      ebmlWalk(buf, body, stop, t, out);
      out.push(t);
    } else if (entry && (id.value === EBML.VIDEO || id.value === EBML.AUDIO)) {
      ebmlWalk(buf, body, stop, entry, out);
    } else if (entry) {
      const s = buf.slice(body, stop);
      if (id.value === EBML.TRACK_TYPE) entry.type = TRACK_TYPES[ebmlUint(s)] || 'other';
      else if (id.value === EBML.LANGUAGE) entry.lang = ebmlStr(s);
      else if (id.value === EBML.LANG_BCP47) entry.lang = ebmlStr(s) || entry.lang;
      else if (id.value === EBML.CODEC_ID) entry.codec = ebmlStr(s);
      else if (id.value === EBML.NAME) entry.name = ebmlStr(s);
      else if (id.value === EBML.FLAG_DEFAULT) entry.def = ebmlUint(s) === 1;
      else if (id.value === EBML.FLAG_FORCED) entry.forced = ebmlUint(s) === 1;
      else if (id.value === EBML.PIXEL_W) entry.width = ebmlUint(s);
      else if (id.value === EBML.PIXEL_H) entry.height = ebmlUint(s);
      else if (id.value === EBML.DISPLAY_W) entry.dwidth = ebmlUint(s);
      else if (id.value === EBML.DISPLAY_H) entry.dheight = ebmlUint(s);
      else if (id.value === EBML.CHANNELS) entry.channels = ebmlUint(s);
      else if (id.value === EBML.SAMPLE_RATE) entry.rate = Math.round(ebmlFloat(s));
      else if (id.value === EBML.DURATION) entry.duration = ebmlFloat(s);
      else if (id.value === EBML.TIMECODE_SCALE) entry.scale = ebmlUint(s);
    }
    if (size.unknown) return;
    pos = body + size.value;
  }
}

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// -> { tracks: [...], duration } . Track order is the order they appear in the
// file, and that is what VLC numbers its streams by.
function readMatroska(file) {
  let out = [];
  const parse = (bytes) => {
    const buf = readHead(file, bytes);
    const acc = [];
    acc.info = {};
    ebmlWalk(buf, 0, buf.length, null, acc);
    return acc;
  };

  out = parse(1024 * 1024);
  // A few muxers put Tracks after the first cluster. Only pay for the bigger
  // read when the small one found nothing.
  if (!out.length) out = parse(8 * 1024 * 1024);

  const scale = out.info && out.info.scale ? out.info.scale : 1000000;
  const ticks = out.info && out.info.duration ? out.info.duration : 0;
  return { tracks: out, duration: ticks ? (ticks * scale) / 1e9 : 0 };
}

/* ------------------------------------------------------- ISO base media (mp4)
 *
 * Atoms are <uint32 length><4-char name><payload>, nested the same way. The
 * stream table lives in moov, which is often written *after* the video data, so
 * the top level is walked by seeking header to header rather than by reading
 * the file in.
 */

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

// Language in mdhd is three 5-bit letters packed into a uint16, each offset
// from 0x60 — so 0x15C7 is "eng".
function mp4Lang(v) {
  if (!v || v === 0x7FFF) return '';
  const a = ((v >> 10) & 0x1F) + 0x60;
  const b = ((v >> 5) & 0x1F) + 0x60;
  const c = (v & 0x1F) + 0x60;
  const s = String.fromCharCode(a, b, c);
  return /^[a-z]{3}$/.test(s) ? s : '';
}

const MP4_HANDLERS = { vide: 'video', soun: 'audio', sbtl: 'subtitle', subt: 'subtitle', text: 'subtitle', clcp: 'subtitle' };

function mp4Atoms(buf, start, end, visit) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    let head = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      // 64-bit length. Beyond 2^53 the arithmetic would go wrong, but no atom
      // is that large and the read below is bounded by the buffer anyway.
      size = buf.readUInt32BE(pos + 8) * 4294967296 + buf.readUInt32BE(pos + 12);
      head = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < head || pos + size > end) return;
    visit(name, pos + head, pos + size);
    if (MP4_CONTAINERS.has(name)) mp4Atoms(buf, pos + head, pos + size, visit);
    pos += size;
  }
}

function readMp4(file) {
  const fd = fs.openSync(file, 'r');
  let moov = null;
  try {
    const total = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    // Step across the top level reading only each atom's 8-byte header, so a
    // 30 GB file costs a handful of seeks.
    while (pos + 8 <= total) {
      const n = fs.readSync(fd, head, 0, 16, pos);
      if (n < 8) break;
      let size = head.readUInt32BE(0);
      const name = head.toString('latin1', 4, 8);
      let skip = 8;
      if (size === 1) {
        if (n < 16) break;
        size = head.readUInt32BE(8) * 4294967296 + head.readUInt32BE(12);
        skip = 16;
      } else if (size === 0) {
        size = total - pos;
      }
      if (size < skip) break;
      if (name === 'moov') {
        if (size > 64 * 1024 * 1024) break;      // not a stream table; something is wrong
        moov = Buffer.alloc(size - skip);
        fs.readSync(fd, moov, 0, moov.length, pos + skip);
        break;
      }
      pos += size;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!moov) return { tracks: [], duration: 0 };

  const tracks = [];
  let duration = 0;
  let cur = null;

  mp4Atoms(moov, 0, moov.length, (name, from, to) => {
    const b = moov;
    if (name === 'mvhd' && to - from >= 20) {
      const ver = b[from];
      const ts = ver === 1 ? b.readUInt32BE(from + 20) : b.readUInt32BE(from + 12);
      const du = ver === 1
        ? b.readUInt32BE(from + 24) * 4294967296 + b.readUInt32BE(from + 28)
        : b.readUInt32BE(from + 16);
      if (ts) duration = du / ts;
      return;
    }
    if (name === 'trak') { cur = {}; tracks.push(cur); return; }
    if (!cur) return;

    if (name === 'tkhd' && to - from >= 84) {
      const ver = b[from];
      const at = ver === 1 ? from + 92 : from + 80;   // width/height, 16.16 fixed
      if (at + 8 <= to) {
        cur.width = Math.round(b.readUInt32BE(at) / 65536);
        cur.height = Math.round(b.readUInt32BE(at + 4) / 65536);
      }
      return;
    }
    if (name === 'mdhd' && to - from >= 20) {
      const ver = b[from];
      const at = ver === 1 ? from + 20 : from + 12;
      const ts = b.readUInt32BE(at);
      const du = ver === 1
        ? b.readUInt32BE(at + 4) * 4294967296 + b.readUInt32BE(at + 8)
        : b.readUInt32BE(at + 4);
      const langAt = ver === 1 ? at + 12 : at + 8;
      if (ts && du) cur.seconds = du / ts;
      if (langAt + 2 <= to) cur.lang = mp4Lang(b.readUInt16BE(langAt));
      return;
    }
    if (name === 'hdlr' && to - from >= 12) {
      cur.type = MP4_HANDLERS[b.toString('latin1', from + 8, from + 12)] || 'other';
      // Some muxers put a human name after the handler, which is the closest
      // thing mp4 has to Matroska's track name.
      const tail = b.slice(from + 24, to).toString('utf8').replace(/\0.*$/s, '').trim();
      if (tail && tail.length < 64 && /[a-z]/i.test(tail)) cur.name = tail;
      return;
    }
    if (name === 'stsd' && to - from >= 16) {
      cur.codec = b.toString('latin1', from + 12, from + 16);
      const entry = from + 8;
      if (cur.type === 'audio' && entry + 26 <= to) cur.channels = b.readUInt16BE(entry + 24);
      if (cur.type === 'audio' && entry + 36 <= to) cur.rate = Math.round(b.readUInt32BE(entry + 32) / 65536);
      if (cur.type === 'video' && entry + 36 <= to) {
        // The sample entry knows the coded size; tkhd only knows the display
        // size, which a rotation or aspect flag can have rewritten.
        const w = b.readUInt16BE(entry + 32), h = b.readUInt16BE(entry + 34);
        if (w > 0 && h > 0) { cur.width = w; cur.height = h; }
      }
    }
  });

  if (!duration) duration = Math.max(0, ...tracks.map((t) => t.seconds || 0));
  return { tracks: tracks, duration: duration };
}

/* ----------------------------------------------------------- naming the parts */

const VIDEO_CODECS = [
  [/V_MPEGH\/ISO\/HEVC|^hev1|^hvc1|^hvc|^dvh/i, 'H.265'],
  [/V_MPEG4\/ISO\/AVC|^avc1|^avc3/i, 'H.264'],
  [/V_AV1|^av01/i, 'AV1'],
  [/V_VP9|^vp09/i, 'VP9'],
  [/V_VP8/i, 'VP8'],
  [/V_MPEG2|^mp2v/i, 'MPEG-2'],
  [/V_MS\/VFW\/FOURCC|V_MPEG4\/MS|^mp4v|^divx|^xvid/i, 'MPEG-4'],
  [/V_THEORA/i, 'Theora'],
];

const AUDIO_CODECS = [
  [/A_TRUEHD|^mlpa/i, 'TrueHD'],
  [/A_EAC3|^ec-3/i, 'E-AC-3'],
  [/A_AC3|^ac-3/i, 'AC-3'],
  [/A_DTS\/?.*MA/i, 'DTS-HD MA'],
  [/A_DTS|^dtsc|^dtse|^dtsh/i, 'DTS'],
  [/A_AAC|^mp4a/i, 'AAC'],
  [/A_FLAC|^fLaC/i, 'FLAC'],
  [/A_OPUS|^Opus/i, 'Opus'],
  [/A_VORBIS/i, 'Vorbis'],
  [/A_MPEG\/L3|^\.mp3/i, 'MP3'],
  [/A_MPEG\/L2/i, 'MP2'],
  [/A_PCM|^lpcm|^sowt/i, 'PCM'],
  [/A_ALAC|^alac/i, 'ALAC'],
];

const SUB_CODECS = [
  [/S_TEXT\/UTF8|S_TEXT\/ASCII/i, 'SRT'],
  [/S_TEXT\/ASS|S_TEXT\/SSA/i, 'ASS'],
  [/S_TEXT\/WEBVTT/i, 'WebVTT'],
  [/S_HDMV\/PGS/i, 'PGS'],
  [/S_VOBSUB/i, 'VobSub'],
  [/S_DVBSUB/i, 'DVB'],
  [/^tx3g|^text/i, 'Timed text'],
];

function nameCodec(table, raw, fallback) {
  const s = String(raw || '');
  for (const [re, name] of table) if (re.test(s)) return name;
  return s ? (fallback || s) : '';
}

const LANGS = {
  eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French',
  fr: 'French', ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian',
  por: 'Portuguese', pt: 'Portuguese', rus: 'Russian', ru: 'Russian', jpn: 'Japanese',
  ja: 'Japanese', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
  hin: 'Hindi', hi: 'Hindi', tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu',
  sin: 'Sinhala', si: 'Sinhala', ara: 'Arabic', ar: 'Arabic', dut: 'Dutch', nld: 'Dutch',
  nl: 'Dutch', swe: 'Swedish', sv: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish',
  pol: 'Polish', pl: 'Polish', tur: 'Turkish', tr: 'Turkish', tha: 'Thai', vie: 'Vietnamese',
  ind: 'Indonesian', may: 'Malay', msa: 'Malay', heb: 'Hebrew', ell: 'Greek', gre: 'Greek',
  ces: 'Czech', cze: 'Czech', hun: 'Hungarian', ron: 'Romanian', rum: 'Romanian',
  ukr: 'Ukrainian', bul: 'Bulgarian', hrv: 'Croatian', srp: 'Serbian', slv: 'Slovenian',
  und: '', mis: '', zxx: '', mul: 'Multiple',
};

function langName(code) {
  const c = String(code || '').toLowerCase().split(/[-_]/)[0];
  if (LANGS[c] !== undefined) return LANGS[c];
  return c ? c.toUpperCase() : '';
}

// Neither dimension alone is enough. Height alone files a 1080p film
// letterboxed to 2.39:1 (1920x800) as 720p; width alone files 4:3 animation
// (960x720) as 576p. What everyone means by "720p" is the height the frame
// WOULD have at 16:9, so take whichever of the two is larger.
function qualityLabel(w, h) {
  const lines = Math.max(h || 0, w ? Math.round((w * 9) / 16) : 0);
  if (!lines) return '';
  if (lines >= 2000) return '4K';
  if (lines >= 1300) return '1440p';
  if (lines >= 900) return '1080p';
  if (lines >= 700) return '720p';
  if (lines >= 560) return '576p';
  if (lines >= 420) return '480p';
  return 'SD';
}

// What the release name claims, for the containers not parsed and as a sanity
// check on the ones that are.
function qualityFromName(name) {
  const s = String(name || '');
  if (/\b(2160p|4k|uhd)\b/i.test(s)) return '4K';
  if (/\b1440p\b/i.test(s)) return '1440p';
  if (/\b1080[pi]\b/i.test(s)) return '1080p';
  if (/\b720[pi]\b/i.test(s)) return '720p';
  if (/\b576[pi]\b/i.test(s)) return '576p';
  if (/\b480[pi]\b/i.test(s)) return '480p';
  return '';
}

function sourceFromName(name) {
  const s = String(name || '');
  if (/\bremux\b/i.test(s)) return 'Remux';
  if (/\b(bluray|blu-ray|bdrip|brrip|bdremux)\b/i.test(s)) return 'Blu-ray';
  if (/\b(web-?dl|webdl)\b/i.test(s)) return 'WEB-DL';
  if (/\bweb-?rip\b/i.test(s)) return 'WEBRip';
  if (/\b(hdtv|pdtv)\b/i.test(s)) return 'HDTV';
  if (/\b(dvdrip|dvd)\b/i.test(s)) return 'DVD';
  if (/\b(cam|hdcam|ts|telesync)\b/i.test(s)) return 'CAM';
  return '';
}

function hdrFromName(name) {
  const s = String(name || '');
  if (/\b(dolby[ .]?vision|dovi|\bdv\b)\b/i.test(s)) return 'Dolby Vision';
  if (/\bhdr10\+/i.test(s)) return 'HDR10+';
  if (/\bhdr\b|\bhdr10\b/i.test(s)) return 'HDR';
  return '';
}

/* ------------------------------------------------------------------ the probe */

// Extensions lie. One file on this shelf is named .mkv and is an MP4 inside,
// which the extension-based dispatch read as an empty Matroska and gave up on.
// Both formats announce themselves in their first bytes, so ask the file.
function sniff(abs) {
  let head;
  try {
    head = readHead(abs, 16);
  } catch (e) {
    return '';
  }
  if (head.length < 12) return '';
  if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) return 'matroska';
  if (head.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 11) === 'AVI') return 'avi';
  return '';
}

// The name the format goes by, once we know what it really is. Matroska and
// WebM share a container, so the extension still decides between those two.
function containerName(kind, ext) {
  if (kind === 'matroska') return ext === '.webm' ? 'WebM' : 'MKV';
  if (kind === 'mp4') return ext === '.mov' ? 'MOV' : (ext === '.m4v' ? 'M4V' : 'MP4');
  if (kind === 'avi') return 'AVI';
  return ext.replace('.', '').toUpperCase();
}

// -> { container, width, height, quality, video, duration, size, bitrate,
//      audio: [{codec, lang, channels}], subs: [{codec, lang, name, forced}],
//      source, hdr, guessed }
// `guessed` means the container was not parsed and the numbers come from the
// filename, so the UI can say so rather than pretending it looked.
function probeFile(abs) {
  let st;
  try { st = fs.statSync(abs); } catch (e) { return null; }

  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs);
  const kind = sniff(abs);
  const out = {
    container: containerName(kind, ext),
    misnamed: !!kind && (
      (kind !== 'matroska' && (ext === '.mkv' || ext === '.webm')) ||
      (kind !== 'mp4' && (ext === '.mp4' || ext === '.m4v' || ext === '.mov'))
    ),
    size: st.size, mtimeMs: st.mtimeMs,
    width: 0, height: 0, quality: '', video: '', duration: 0, bitrate: 0,
    audio: [], subs: [],
    source: sourceFromName(base), hdr: hdrFromName(base),
    guessed: false,
  };

  let read = null;
  try {
    if (kind === 'matroska') read = readMatroska(abs);
    else if (kind === 'mp4') read = readMp4(abs);
  } catch (e) {
    read = null;
  }

  if (!read || !read.tracks.length) {
    out.guessed = true;
    out.quality = qualityFromName(base);
    return out;
  }

  out.duration = Math.round(read.duration || 0);
  read.tracks.forEach((t) => {
    if (t.type === 'video' && !out.video) {
      out.width = t.width || t.dwidth || 0;
      out.height = t.height || t.dheight || 0;
      out.video = nameCodec(VIDEO_CODECS, t.codec, t.codec);
    } else if (t.type === 'audio') {
      out.audio.push({
        codec: nameCodec(AUDIO_CODECS, t.codec, t.codec),
        lang: langName(t.lang), channels: t.channels || 0,
      });
    } else if (t.type === 'subtitle') {
      out.subs.push({
        codec: nameCodec(SUB_CODECS, t.codec, t.codec),
        lang: langName(t.lang), name: t.name || '', forced: !!t.forced,
      });
    }
  });

  out.quality = qualityLabel(out.width, out.height) || qualityFromName(base);
  if (!out.hdr && /\bBT2020|PQ\b/i.test(out.video)) out.hdr = 'HDR';
  if (out.duration > 0) out.bitrate = Math.round((st.size * 8) / out.duration);
  return out;
}

// The raw track list, in file order — which is exactly how VLC numbers its
// streams, and therefore what --sub-track-id expects.
function matroskaTracks(abs) {
  return readMatroska(abs).tracks;
}

module.exports = {
  probeFile, matroskaTracks,
  qualityLabel, qualityFromName, langName,
};
