'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const qr = require('./qr');
const probe = require('./probe');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);

// ------------------------------------------------------------- portability
//
// The app and your films may sit on the same removable disk, which turns up as
// E:\ on one machine and /media/you/Films on another. Absolute paths would break
// on every move, so anything living on the same volume as the app is stored
// relative to the app folder, and resolved back to absolute on load. Paths
// genuinely elsewhere stay absolute, because they have to.
//
// Separators are stored as "/" throughout. Windows accepts them everywhere, and
// it means a progress key written on one machine matches on the other.

function slash(p) {
  return String(p == null ? '' : p).split('\\').join('/');
}

// path.isAbsolute only understands the host platform, so a Windows path read on
// Linux would look relative and get resolved into nonsense. Recognise both.
function looksAbsolute(p) {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('//') || p.startsWith('\\\\');
}

// Two levels of climbing, no more. E:\NAVFLIX beside E:\Films is one folder up
// and clearly part of the same bundle; something five levels up merely happens
// to share a drive letter today. Making that relative would quietly repoint it
// at the wrong disk the moment the app folder moves on its own, whereas the
// absolute path would still have been right.
const MAX_CLIMB = 2;

function toStored(abs) {
  if (!abs) return '';
  const rel = path.relative(ROOT, abs);
  // Across Windows volumes path.relative gives back an absolute path. That is
  // the signal that this folder will not travel with us.
  if (!rel || path.isAbsolute(rel)) return slash(abs);
  const climb = rel.split(/[\\/]/).filter((seg) => seg === '..').length;
  if (climb > MAX_CLIMB) return slash(abs);
  return slash(rel);
}

function fromStored(p) {
  if (!p) return '';
  if (looksAbsolute(p)) return path.normalize(p);
  return path.resolve(ROOT, p.split('/').join(path.sep));
}

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.wmv', '.flv',
  '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.ogv', '.3gp', '.divx',
]);

// A VLC shipped inside the app folder wins over an installed one, so a drive
// carried between machines uses the same player everywhere. VideoLAN publish no
// Linux build, so there the system package is still the only option.
const BUNDLED_VLC = IS_WIN
  ? path.join(ROOT, 'runtime', 'vlc', 'vlc.exe')
  : path.join(ROOT, 'runtime', 'vlc', 'vlc');

function vlcCandidates() {
  const home = os.homedir();
  const bundled = [];
  try { if (fs.existsSync(BUNDLED_VLC)) bundled.push(BUNDLED_VLC); } catch (e) {}

  if (IS_WIN) {
    return bundled.concat([
      'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
      path.join(home, 'scoop', 'apps', 'vlc', 'current', 'vlc.exe'),
    ]);
  }
  if (IS_MAC) {
    return bundled.concat([
      '/Applications/VLC.app/Contents/MacOS/VLC',
      path.join(home, 'Applications/VLC.app/Contents/MacOS/VLC'),
      '/opt/homebrew/bin/vlc',
      '/usr/local/bin/vlc',
    ]);
  }
  return bundled.concat([
    '/usr/bin/vlc',
    '/usr/local/bin/vlc',
    '/snap/bin/vlc',
    // Flatpak exports a real executable that forwards CLI arguments.
    '/var/lib/flatpak/exports/bin/org.videolan.VLC',
    path.join(home, '.local/share/flatpak/exports/bin/org.videolan.VLC'),
  ]);
}

// Last resort on Unix: whatever "vlc" resolves to on PATH.
function vlcOnPath() {
  if (IS_WIN) return null;
  try {
    const found = execFileSync('which', ['vlc'], { encoding: 'utf8' }).trim();
    return found && fs.existsSync(found) ? found : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- state

// v2 shape:
// { version, activeId, vlcPath, fullscreen, collections: [
//     { id, name, path, episodeMinutes, progress:{rel:{...}}, day:{key,secondsWatched}, history:[] }
// ]}

// Set by load() when it has just read a pre-portable state file.
let pendingPortableSave = false;

let state = load();

function newId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function blankCollection(dir, name) {
  return {
    id: newId(),
    name: name || path.basename(dir) || dir,
    path: dir,
    episodeMinutes: 60,
    // New folders start in whole-film mode: play it through. Switch it off per
    // collection to get the daily-sitting behaviour.
    fullMode: true,
    progress: {},
    day: { key: '', secondsWatched: 0 },
    history: [],
    // Filled in on the first scan; kept so an offline drive stays identifiable.
    isSeries: false,
    seasonCount: 0,
  };
}

// The phone remote is off until you turn it on, because switching it on binds
// the server to the network instead of just this machine.
function blankRemote() {
  return { enabled: false, pin: '', tokens: [] };
}

// A 6-digit code you can read off the console and type on a phone. Stable
// across restarts so a paired phone stays paired.
function newPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Every non-loopback IPv4 the machine answers on, so the console can print
// an address the phone can actually reach.
// Not every address this machine holds is one your phone can reach, and the
// order the OS lists them in means nothing. Two kinds are worse than useless:
//
//   - a /32 netmask, which is a point-to-point link with no network behind it.
//     Corporate VPN clients hand these out; a Fortinet adapter sitting on
//     10.x with mask 255.255.255.255 looks like a LAN address and is not.
//   - 169.254.x.x, which is what an interface assigns itself when no DHCP
//     server ever answered. Unplugged ports and idle Bluetooth adapters.
//
// What survives is ranked so the likeliest home network leads, because the
// first address is the one the QR code encodes.
const VIRTUAL_IFACE = /(vpn|virtual|vmware|virtualbox|hyper-?v|vethernet|tailscale|wireguard|tap-|bluetooth|docker)/i;

function addressRank(entry) {
  let score = 0;
  if (entry.address.startsWith('192.168.')) score += 30;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) score += 20;
  else if (entry.address.startsWith('10.')) score += 10;
  if (VIRTUAL_IFACE.test(entry.name)) score -= 25;
  return score;
}

function lanAddresses() {
  const found = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.netmask === '255.255.255.255') continue;   // nothing is behind a /32
      if (a.address.startsWith('169.254.')) continue;  // DHCP never answered
      found.push({ address: a.address, name: name });
    }
  }
  found.sort((x, y) => addressRank(y) - addressRank(x));
  return found.map((f) => f.address);
}

// Bring one collection into the shape the running app expects: absolute native
// path, progress keyed with "/" whichever machine wrote it, and subtitle files
// resolved back from their stored form.
// Downloaded subtitles are ours and live in data/subs, so they always travel
// with the app. If the stored path has gone stale — the folder was copied to a
// new machine while the path still named the old one — the file itself is
// almost certainly sitting right there under its hashed name.
// Cached artwork is filed under sha1(collection id + relative path), so
// switching the separator silently changes every filename. Left alone that
// would orphan the whole cache and send you back to the network for posters you
// already have on disk. Rename them to match the new key instead.
//
// DATA_DIR rather than ART_DIR because this runs during load(), before the
// later const declarations have been initialised.
function migrateArtKey(cid, oldRel, newRel) {
  const named = (rel, kind) => path.join(
    DATA_DIR, 'art',
    crypto.createHash('sha1').update(cid + '|' + rel).digest('hex') +
      (kind === 'bg' ? '-bg' : '') + '.jpg'
  );
  for (const kind of ['', 'bg']) {
    const from = named(oldRel, kind);
    const to = named(newRel, kind);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    } catch (e) { /* worst case the image is fetched again */ }
  }
}

function reseatSub(stored) {
  const p = fromStored(stored);
  try { if (fs.existsSync(p)) return p; } catch (e) {}

  const here = path.join(DATA_DIR, 'subs', path.basename(slash(stored)));
  try { if (fs.existsSync(here)) return here; } catch (e) {}

  return p;                    // genuinely gone; the UI will offer a re-download
}

function portCollection(c) {
  c.path = fromStored(c.path);

  const prog = {};
  for (const key of Object.keys(c.progress || {})) {
    const r = c.progress[key];
    if (r && r.extSub && r.extSub.file) {
      r.extSub = Object.assign({}, r.extSub, { file: reseatSub(r.extSub.file) });
    }
    // A state file written on Windows keyed everything with backslashes. Those
    // keys would never match a scan done on Linux, so the whole watch history
    // would silently look unwatched.
    const key2 = slash(key);
    if (key2 !== key) migrateArtKey(c.id, key, key2);
    prog[key2] = r;
  }
  c.progress = prog;

  c.history = (c.history || []).map((h) =>
    (h && h.file) ? Object.assign({}, h, { file: slash(h.file) }) : h);

  return c;
}

function load() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    raw = null;
  }

  // The portable format stores paths relative to the app folder. The first time
  // an older state file is read, keep a copy of it: the conversion is not
  // something you want to discover was wrong with no way back.
  const converting = !!(raw && !raw.portable);
  if (converting) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(STATE_FILE, STATE_FILE + '.before-portable-' + stamp + '.bak');
      console.log('   Saved a backup of your progress before converting it to the');
      console.log('   portable format: data/state.json.before-portable-*.bak');
    } catch (e) { /* not fatal; the conversion is reversible by hand */ }
    pendingPortableSave = true;
  }

  const fresh = { version: 2, activeId: '', vlcPath: '', vlcPaths: {}, fullscreen: true,
    tmdbKey: '', openOnStart: true, remote: blankRemote(), collections: [] };
  if (!raw) return fresh;

  // Already v2.
  if (Array.isArray(raw.collections)) {
    return {
      version: 2,
      activeId: raw.activeId || (raw.collections[0] && raw.collections[0].id) || '',
      vlcPath: raw.vlcPath || '',
      // One remembered VLC per platform, so two laptops sharing this disk do not
      // keep overwriting each other. An older single path seeds this machine.
      vlcPaths: Object.assign(
        raw.vlcPath ? { [process.platform]: raw.vlcPath } : {},
        raw.vlcPaths || {}
      ),
      fullscreen: raw.fullscreen !== false,
      tmdbKey: raw.tmdbKey || '',
      // Absent in older state files, and the old behaviour was to open.
      openOnStart: raw.openOnStart !== false,
      remote: Object.assign(blankRemote(), raw.remote || {}),
      collections: raw.collections.map((c) => portCollection({
        id: c.id || newId(),
        name: c.name || path.basename(c.path || '') || 'Collection',
        path: c.path || '',
        episodeMinutes: Number(c.episodeMinutes) || 60,
        fullMode: !!c.fullMode,
        progress: c.progress || {},
        day: Object.assign({ key: '', secondsWatched: 0 }, c.day),
        history: c.history || [],
        seriesMeta: c.seriesMeta || null,
        // Cached shape, so a collection on an unplugged drive still knows
        // whether it is a show. Refreshed whenever the folder is readable.
        isSeries: !!c.isSeries,
        seasonCount: Number(c.seasonCount) || 0,
      })),
    };
  }

  // v1 -> v2: the single library becomes the first collection, progress intact.
  const migrated = Object.assign({}, fresh, {
    vlcPath: raw.vlcPath || '',
    fullscreen: raw.fullscreen !== false,
    tmdbKey: raw.tmdbKey || '',
  });
  if (raw.libraryPath || (raw.progress && Object.keys(raw.progress).length)) {
    const c = blankCollection(raw.libraryPath || '', '');
    c.episodeMinutes = Number(raw.episodeMinutes) || 60;
    c.progress = raw.progress || {};
    c.day = Object.assign({ key: '', secondsWatched: 0 }, raw.day);
    c.history = raw.history || [];
    migrated.collections.push(c);
    migrated.activeId = c.id;
    console.log('   Migrated your existing library into a collection: ' + c.name);
  }
  return migrated;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}

// The in-memory state always holds absolute, native paths so the rest of the
// code never has to think about this. Only the file on disk is portable.
function onDisk(st) {
  return Object.assign({}, st, {
    portable: true,
    collections: st.collections.map((c) => {
      const prog = {};
      for (const rel of Object.keys(c.progress || {})) {
        const r = c.progress[rel];
        prog[rel] = (r && r.extSub && r.extSub.file)
          ? Object.assign({}, r, {
              extSub: Object.assign({}, r.extSub, { file: toStored(r.extSub.file) }),
            })
          : r;
      }
      return Object.assign({}, c, { path: toStored(c.path), progress: prog });
    }),
  });
}

function saveNow() {
  clearTimeout(saveTimer);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(onDisk(state), null, 2));
}

// Commit the converted state immediately. Waiting for the next incidental save
// left the file in the old format indefinitely, which meant the backup was
// taken again on every single start. This runs here rather than beside load()
// because saveTimer above is a 'let' and is not initialised any earlier.
if (pendingPortableSave) {
  saveNow();
  pendingPortableSave = false;
}

function dayKey(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// ---------------------------------------------------------------- collections

function findCollection(id) {
  return state.collections.find((c) => c.id === id) || null;
}

function activeCollection() {
  return findCollection(state.activeId) || state.collections[0] || null;
}

function rollDay(c) {
  const k = dayKey();
  if (c.day.key !== k) {
    c.day = { key: k, secondsWatched: 0 };
    save();
  }
}

// How long one sitting runs. It used to be a daily ration that shrank as you
// watched; it is now simply the episode length, so a second episode is just a
// second press. The day counter still ticks, but only as a statistic.
function sittingLength(c) {
  rollDay(c);
  return Math.max(0, c.episodeMinutes * 60);
}

// ---------------------------------------------------------------- library scan

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const scanCache = new Map(); // path -> { at, files }

function scanLibrary(dir) {
  const now = Date.now();
  const hit = scanCache.get(dir);
  if (hit && now - hit.at < 8000) return hit.files;

  const out = [];
  const walk = (abs, rel, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      // Always "/", never the platform separator: these become progress keys and
      // have to match whichever machine wrote them.
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        walk(path.join(abs, e.name), childRel, depth + 1);
      } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
        let size = 0;
        try { size = fs.statSync(path.join(abs, e.name)).size; } catch (err) { continue; }
        if (size < 20 * 1024 * 1024) continue; // skip samples and featurettes
        out.push({ rel: childRel, size: size });
      }
    }
  };

  if (dir && fs.existsSync(dir)) walk(dir, '', 0);
  out.sort((a, b) => collator.compare(a.rel, b.rel));
  scanCache.set(dir, { at: now, files: out });
  return out;
}

const NOISE = /\s*[\[(]?\b(1080p|720p|480p|2160p|4k|bluray|blu-ray|brrip|bdrip|webrip|web-dl|web-hd|webdl|hdrip|dvdrip|x264|x265|hevc|h264|h265|aac5?|ac3|dts|10bit|hdr|remux|yts|yify|rarbg|galaxyrg|psa|esub|msub|msubs|6ch|dual audio|hindi|tamil|telugu|proper|repack)\b[\])]?/gi;

function tidy(s) {
  return s.replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-\u2013.]+/, '')
    .replace(/[\s\-\u2013(.\[]+$/, '')
    .trim();
}

// Scene filenames put the year right after the title and noise right after the
// year, so cutting at the year is far more reliable than blacklisting tags.
// Uses the LAST year so "Blade Runner 2049 2017" keeps 2049 in the title.
function prettyTitle(rel) {
  const original = path.basename(rel, path.extname(rel));
  let name = original.replace(/[._]+/g, ' ');
  name = name.replace(/\[[^\]]*\]/g, ' ');   // drop [YTS.MX] / [RARBG] tags

  const years = Array.from(name.matchAll(/\b(?:19|20)\d{2}\b/g));
  if (years.length) {
    const y = years[years.length - 1];
    const head = tidy(name.slice(0, y.index));
    if (head) return head + ' (' + y[0] + ')';
  }

  name = tidy(name.replace(NOISE, ''));
  name = name.replace(/-[A-Za-z0-9]{2,12}$/, '');   // trailing -RELEASEGROUP, never a spaced word
  return tidy(name) || original;
}

// ---------------------------------------------------------------- tv series
//
// A folder of episodes needs different treatment from a folder of films: the
// title is an episode number, artwork comes from the show plus a per-episode
// still, and subtitles are looked up per episode rather than per film.

function epCode(s, e) {
  return 'S' + String(s).padStart(2, '0') + 'E' + String(e).padStart(2, '0');
}

function parseEpisode(rel) {
  const base = path.basename(rel, path.extname(rel)).replace(/[._]+/g, ' ');
  const dir = path.dirname(rel).replace(/[._]+/g, ' ');

  const made = (season, episode, at) => ({
    season: season, episode: episode,
    show: tidy(base.slice(0, at).replace(NOISE, '')),
    code: epCode(season, episode),
  });

  // Season and episode together in the filename. Release groups are wildly
  // inconsistent here — s01e01, s02ep1 and [3x01] all turn up in one show.
  const combined = [
    /\bS(\d{1,2})[\s\-]*E(?:P|PISODE)?[\s\-]*(\d{1,3})\b/i,   // S03E04, s02ep1, S03 - E04
    /\b(\d{1,2})\s*x\s*(\d{1,3})\b/i,                          // 3x04, [3x01]
    /\bSeason\s*(\d{1,2})[\s\-]*Episode\s*(\d{1,3})\b/i,
  ];
  for (const re of combined) {
    const m = base.match(re);
    if (m) return made(Number(m[1]), Number(m[2]), m.index);
  }

  // Otherwise the season often lives in the folder name and only the episode
  // number is in the file: "Season 2/Episode 05.mkv", "S02/05 - Grilled.mkv".
  const sm = dir.match(/\b(?:season|series|s)\s*(\d{1,2})\b/i);
  if (sm) {
    const em = base.match(/\bE(?:P|PISODE)?[\s\-]*(\d{1,3})\b/i) || base.match(/^\s*(\d{1,3})\b/);
    if (em) return made(Number(sm[1]), Number(em[1]), em.index);
  }
  return null;
}

// A collection is a series when most of its files look like episodes.
function seriesShape(c) {
  const files = scanLibrary(c.path);
  if (!files.length) return null;
  const names = {};
  let eps = 0;
  for (const f of files) {
    const p = parseEpisode(f.rel);
    if (!p) continue;
    eps++;
    if (p.show) names[p.show] = (names[p.show] || 0) + 1;
  }
  if (eps / files.length < 0.6) return null;
  const show = Object.keys(names).sort((a, b) => names[b] - names[a])[0] || path.basename(c.path);
  return { show: show, episodes: eps };
}

function episodeMeta(c, rel) {
  const p = parseEpisode(rel);
  if (!p) return null;
  const store = (c.seriesMeta && c.seriesMeta.episodes) || null;
  const hit = store ? store[p.season + ':' + p.episode] : null;
  return Object.assign({}, p, hit || {});
}

// "S03E04 · XXII." when the episode name is known, otherwise just the code.
function displayTitle(c, rel, series) {
  if (!series) return prettyTitle(rel);
  const m = episodeMeta(c, rel);
  if (!m) return prettyTitle(rel);
  return m.name ? m.code + ' · ' + m.name : m.code;
}

// ---------------------------------------------------------------- subtitles
//
// Matroska files carry subtitles as separate tracks inside the container. VLC
// will not show one unless told which, and picking well is fiddly: the plain
// "English" track sits alongside Forced (foreign dialogue only), SDH (adds
// [explosion] cues) and Commentary variants, and plenty of releases leave the
// language code as "und" while putting "English" in the track name instead.
//
// This reads the track table straight out of the file header. No ffmpeg.

// The container parsing lives in probe.js, which reads the same track table
// for the Details view. One reader, one set of edge cases.
const subCache = new Map(); // absolute path -> { mtimeMs, size, tracks }

// VLC numbers its streams by the track's position in the file, and that is
// exactly what --sub-track-id expects. Verified against VLC's reported ids.
function subtitleTracks(c, rel) {
  const file = path.join(c.path, rel);
  if (!/\.mkv$/i.test(file)) return [];       // only Matroska is parsed here

  let st;
  try { st = fs.statSync(file); } catch (e) { return []; }
  const hit = subCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.tracks;

  // Remembered from last time. Working this out means opening the video and
  // reading a megabyte of it, so a whole season costs real seconds on a USB
  // disk — and the answer only changes if the file itself does. Size and mtime
  // say whether it has.
  const saved = (c.progress && c.progress[rel] && c.progress[rel].tracks) || null;
  if (saved && saved.mtimeMs === st.mtimeMs && saved.size === st.size) {
    subCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, tracks: saved.list });
    return saved.list;
  }

  let all = [];
  try { all = probe.matroskaTracks(file); } catch (e) { all = []; }

  const tracks = [];
  all.forEach((t, position) => {
    if (t.type !== 'subtitle') return;
    const lang = (t.lang || '').toLowerCase();
    tracks.push({
      id: position,                 // == VLC stream id == --sub-track-id
      lang: t.lang || '',
      name: t.name || '',
      codec: t.codec || '',
      bitmap: /pgs|vobsub|dvbsub/i.test(t.codec || ''),
      def: !!t.def,
      untagged: !lang || lang === 'und' || lang === 'mis' || lang === 'zxx',
    });
  });

  subCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, tracks: tracks });
  if (c.progress) {
    rec(c, rel).tracks = { mtimeMs: st.mtimeMs, size: st.size, list: tracks };
    save();
  }
  return tracks;
}

function isEnglish(t) {
  return /^(en|eng)\b/.test((t.lang || '').toLowerCase()) || /\benglish\b/i.test(t.name || '');
}

function subKind(t) {
  const n = (t.name || '').toLowerCase();
  if (/comment/.test(n)) return 'commentary';
  if (/forced/.test(n)) return 'forced';
  if (/sdh|hearing|hoh|caption/.test(n)) return 'sdh';
  if (/sign|song/.test(n)) return 'signs';
  return 'full';
}

// Higher is better. 0 means "never choose this automatically".
function scoreSub(t) {
  if (!isEnglish(t)) return 0;
  const kind = subKind(t);
  if (kind === 'commentary') return 0;        // never matches the audio you hear
  let s = 100;
  if (kind === 'forced') s -= 60;             // stays silent through an English film
  if (kind === 'signs') s -= 50;
  if (kind === 'sdh') s -= 25;                // watchable, just noisier
  if (!t.bitmap) s += 12;                     // text scales and restyles
  if (t.def) s += 5;
  return s;
}

const LANG_NAMES = {
  en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  ru: 'Russian', rus: 'Russian', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', ar: 'Arabic', ara: 'Arabic', hi: 'Hindi', hin: 'Hindi',
  ta: 'Tamil', tam: 'Tamil', te: 'Telugu', tel: 'Telugu', si: 'Sinhala', sin: 'Sinhala',
  nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', sv: 'Swedish', swe: 'Swedish', da: 'Danish', dan: 'Danish',
  no: 'Norwegian', nor: 'Norwegian', fi: 'Finnish', fin: 'Finnish', pl: 'Polish', pol: 'Polish',
  tr: 'Turkish', tur: 'Turkish', cs: 'Czech', cze: 'Czech', ces: 'Czech', el: 'Greek', gre: 'Greek', ell: 'Greek',
  he: 'Hebrew', heb: 'Hebrew', th: 'Thai', tha: 'Thai', id: 'Indonesian', ind: 'Indonesian',
  ms: 'Malay', may: 'Malay', msa: 'Malay', vi: 'Vietnamese', vie: 'Vietnamese',
  hu: 'Hungarian', hun: 'Hungarian', ro: 'Romanian', rum: 'Romanian', ron: 'Romanian',
  sk: 'Slovak', slo: 'Slovak', slk: 'Slovak', is: 'Icelandic', ice: 'Icelandic', isl: 'Icelandic',
  uk: 'Ukrainian', ukr: 'Ukrainian', bg: 'Bulgarian', bul: 'Bulgarian', hr: 'Croatian', hrv: 'Croatian',
};

// Some releases dump the whole release name into the track title, which makes a
// useless 90-character dropdown entry. Treat those as having no name at all.
const JUNK_NAME = /(1080p|720p|480p|2160p|bluray|blu-ray|web-?dl|webrip|bdrip|x264|x265|hevc|ddp?\d|dts|remux|galaxyrg|psa|rarbg|yts|\.mkv|\.mp4)/i;
const BARE_QUALIFIER = /^(sdh|forced|full|commentary|signs|songs|cc|hi|hoh)$/i;

function langName(t) {
  const code = (t.lang || '').toLowerCase();
  return LANG_NAMES[code] || (code && code !== 'und' ? code.toUpperCase() : '');
}

function subLabel(t) {
  const lang = langName(t);
  const name = (t.name || '').trim();
  const usable = name && name.length <= 45 && !JUNK_NAME.test(name);

  if (!usable) return lang || 'Untagged';
  // "SDH" alone reads badly in a list; "English (SDH)" does not.
  if (BARE_QUALIFIER.test(name)) return lang ? lang + ' (' + name.toUpperCase() + ')' : name;
  return name;
}

function autoSub(tracks) {
  let best = null, bestScore = 0;
  for (const t of tracks) {
    const s = scoreSub(t);
    if (s > bestScore) { best = t; bestScore = s; }
  }
  if (best) return best;

  // Nothing declares itself English. A lone untagged track is almost always the
  // English one, so offer it rather than leaving the film bare — but mark it as a
  // guess so the UI can say so.
  //
  // Bitmap tracks were excluded from this, on the reasoning that text is nicer.
  // It is, but that is a reason to prefer text, not to refuse to guess when the
  // only candidate is a picture — and PGS is exactly what a Blu-ray rip carries.
  // A release with an untagged English PGS track alongside tagged Indonesian and
  // Malay ones played with no subtitle at all.
  const untagged = tracks.filter((t) => t.untagged);
  const text = untagged.filter((t) => !t.bitmap);
  const pool = text.length ? text : untagged;
  return pool.length === 1 ? Object.assign({}, pool[0], { guess: true }) : null;
}

// ---- external subtitle files ------------------------------------------------
// Either sitting beside the film already, or fetched by the download button.

const SUB_DIR = path.join(DATA_DIR, 'subs');
const SIDECAR_EXT = ['.srt', '.ass', '.ssa', '.sub', '.vtt'];

function externalSubs(c, rel) {
  const out = [];
  const abs = path.join(c.path, rel);
  const dir = path.dirname(abs);
  const base = path.basename(rel, path.extname(rel));

  // Files you put there yourself always come first. One folder listing rather
  // than a probe per candidate, for the same reason the artwork lookup uses one.
  const index = dirIndex(dir);
  for (const suffix of ['', '.en', '.eng', '.english']) {
    for (const ext of SIDECAR_EXT) {
      const real = index.get((base + suffix + ext).toLowerCase());
      if (!real) continue;
      const p = path.join(dir, real);
      if (!out.some((o) => o.path === p)) {
        out.push({ path: p, label: real, origin: 'beside the film' });
      }
    }
  }

  const r = c.progress[rel];
  if (r && r.extSub && r.extSub.file) {
    try {
      if (fs.existsSync(r.extSub.file)) {
        const cov = r.extSub.coverage ? ' · covers ' + r.extSub.coverage + '%' : '';
        out.push({ path: r.extSub.file, label: 'Downloaded English' + cov, origin: 'downloaded' });
      }
    } catch (e) {}
  }
  return out;
}

function subsFor(c, rel) {
  const tracks = subtitleTracks(c, rel);
  const prog = c.progress[rel] || {};
  const ext = prog.extSub || {};
  const saved = prog.sub;
  const auto = autoSub(tracks);

  // Two tracks can resolve to the same label; a dropdown of identical entries is
  // useless, so collisions get their track number appended.
  const counts = {};
  tracks.forEach((t) => { const l = subLabel(t); counts[l] = (counts[l] || 0) + 1; });
  const labelOf = (t) => {
    const l = subLabel(t);
    return counts[l] > 1 ? l + ' · track ' + t.id : l;
  };

  const external = externalSubs(c, rel);
  const options = tracks.map((t) => ({
    id: t.id, label: labelOf(t), kind: subKind(t),
    bitmap: t.bitmap, untagged: t.untagged, english: isEnglish(t), external: false,
  })).concat(external.map((x, i) => ({
    id: 'x' + i, label: x.label, kind: 'full', bitmap: false,
    untagged: false, english: true, external: true, origin: x.origin,
  })));

  // A file you supplied or fetched beats a poor embedded match, but a proper
  // embedded English track still wins — it is guaranteed to be in sync.
  let autoId = auto ? auto.id : null;
  if ((!auto || auto.guess) && external.length) autoId = 'x' + (external.length - 1);

  let activeId = autoId;
  if (saved === 'off') activeId = null;
  else if (saved !== undefined && options.some((o) => o.id === saved)) activeId = saved;

  const active = options.find((o) => o.id === activeId) || null;
  const hasEnglish = tracks.some((t) => isEnglish(t) && subKind(t) !== 'commentary');

  return {
    tracks: options,
    choice: saved === 'off' ? 'off' : (saved !== undefined && options.some((o) => o.id === saved) ? saved : 'auto'),
    activeId: activeId,
    activeLabel: active ? active.label : null,
    guess: !!(auto && auto.guess && activeId === auto.id),
    // Sync controls
    delayMs: Number(prog.subDelay) || 0,
    downloaded: !!ext.file,
    poolSize: (ext.pool || []).length,
    pick: ext.pick || 0,
    stretched: ext.stretched || 1,
    hasEnglish: hasEnglish,
    external: external.length > 0,
    // Worth offering a download when the film has nothing dependable in English.
    canDownload: !hasEnglish && external.length === 0,
  };
}

// Resolve a choice to what VLC needs: an embedded track id, or a file path.
function subTarget(c, rel) {
  const info = subsFor(c, rel);
  if (info.activeId === null) return { off: true };
  if (typeof info.activeId === 'string' && info.activeId[0] === 'x') {
    const ext = externalSubs(c, rel)[Number(info.activeId.slice(1))];
    return ext ? { file: ext.path } : { off: true };
  }
  return { track: info.activeId };
}

// ---- fetching subtitles -----------------------------------------------------
//
// Only runs when you press the button. Two of the three English results for a
// typical film are half-length "CD1 of 2" splits left over from the DVD era, so
// taking the first hit is not good enough: several are fetched and the one that
// actually covers the runtime wins.

let subJob = null;   // { collectionId, rel, title, running, note, error }

function srtStats(text) {
  const stamps = text.match(/(\d{2}):(\d{2}):(\d{2})[,.]\d{3}\s*-->/g) || [];
  if (!stamps.length) return null;
  let last = 0;
  for (const s of stamps) {
    const m = s.match(/(\d{2}):(\d{2}):(\d{2})/);
    const secs = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    if (secs > last) last = secs;
  }
  return { cues: stamps.length, lastCue: last };
}

async function imdbIdFor(title) {
  const { queries, year } = searchTerms(title);
  for (const q of queries) {
    try {
      const url = 'https://v3-cinemeta.strem.io/catalog/movie/top/search=' +
        encodeURIComponent(q) + '.json';
      const data = await getJson(url);
      const metas = (data && data.metas) || [];
      let best = null, bestScore = 0;
      for (const m of metas) {
        const sc = scoreMatch(m.name, m.releaseInfo, q, year);
        if (sc > bestScore) { best = m; bestScore = sc; }
      }
      if (bestScore >= 2 && best && /^tt\d+/.test(best.id || '')) return best.id;
    } catch (e) { /* try the next phrasing */ }
  }
  return null;
}

// Look the show up once per collection and keep its episode list on the
// collection, so every episode gets a name, a still and an IMDb id to search on.
// A year in the folder name, however it is bracketed.
function yearHint(text) {
  const m = String(text || '').match(/[([]\s*((?:19|20)\d{2})\s*[)\]]|[-\u2013\u2014]\s*((?:19|20)\d{2})\s*$/);
  return m ? (m[1] || m[2]) : '';
}

// The year is a hint for matching, not part of what to search for.
function withoutYear(text) {
  return String(text || '')
    .replace(/\s*[-\u2013\u2014]?\s*[([]\s*(?:19|20)\d{2}\s*[)\]]/g, '')
    .replace(/\s*[-\u2013\u2014]\s*(?:19|20)\d{2}\s*$/, '')
    .trim();
}

async function fetchSeriesMeta(c, shape) {
  // Remakes share their title with the original, so the title alone cannot tell
  // them apart: searching "Avatar The Last Airbender" returns the 2024 series
  // and the 2005 one under exactly the same name. A year in the folder is the
  // only thing that separates them, and it was being thrown away here.
  const hint = yearHint(c.name) || yearHint(path.basename(c.path));
  const tries = [shape.show, withoutYear(c.name), withoutYear(path.basename(c.path))]
    .filter(Boolean);

  let best = null;
  let bestScore = 0;
  for (const q of tries) {
    try {
      const data = await getJson('https://v3-cinemeta.strem.io/catalog/series/top/search=' +
        encodeURIComponent(q) + '.json');
      // Score every candidate and keep the strongest. Taking the first one over
      // the bar handed the answer to whichever the catalogue happened to rank
      // highest, which for a remake is the new one.
      for (const m of (data && data.metas) || []) {
        const sc = scoreMatch(m.name, m.releaseInfo, q, hint);
        if (sc > bestScore) { best = m; bestScore = sc; }
      }
    } catch (e) { /* try the next phrasing */ }
    if (bestScore >= 3) break;      // title and year both agree; nothing will beat it
  }
  if (!best || bestScore < 2) return null;

  const full = await getJson('https://v3-cinemeta.strem.io/meta/series/' + best.id + '.json');
  const episodes = {};
  for (const v of (full.meta && full.meta.videos) || []) {
    if (v.season == null || v.episode == null) continue;
    episodes[v.season + ':' + v.episode] = {
      name: v.name || '', thumbnail: v.thumbnail || '', overview: v.overview || '',
    };
  }
  c.seriesMeta = {
    imdb: best.id, name: best.name,
    poster: best.poster || '', background: best.background || '',
    episodes: episodes, at: new Date().toISOString(),
  };
  saveNow();
  return c.seriesMeta;
}

async function fetchSubtitle(c, item) {
  const shape = seriesShape(c);
  let listUrl;

  if (shape) {
    if (!c.seriesMeta) { subJob.note = 'identifying the show'; await fetchSeriesMeta(c, shape); }
    const ep = parseEpisode(item.rel);
    if (!c.seriesMeta || !c.seriesMeta.imdb || !ep) {
      throw new Error('Could not identify the show to search for subtitles.');
    }
    listUrl = 'https://opensubtitles-v3.strem.io/subtitles/series/' +
      c.seriesMeta.imdb + ':' + ep.season + ':' + ep.episode + '.json';
  } else {
    const imdb = await imdbIdFor(item.title);
    if (!imdb) throw new Error('Could not identify "' + item.title + '" to search for subtitles.');
    listUrl = 'https://opensubtitles-v3.strem.io/subtitles/movie/' + imdb + '.json';
  }

  subJob.note = 'searching';
  const list = await getJson(listUrl);
  const eng = ((list && list.subtitles) || []).filter((s) => /^(eng|en)$/i.test(s.lang) && s.url);
  if (!eng.length) throw new Error('No English subtitles listed for this film.');

  const runtime = item.duration > 0 ? item.duration : 0;
  let best = null;

  for (let i = 0; i < Math.min(5, eng.length); i++) {
    if (!subJob || !subJob.running) break;
    subJob.note = 'checking candidate ' + (i + 1) + ' of ' + Math.min(5, eng.length);
    const cand = eng[i];

    // A filename that announces itself as one half of a pair is not worth fetching.
    if (/\bcd[12]\b|\bpart[._ ]?[12]\b/i.test(cand.subtitleFileName || '')) continue;

    let text;
    try {
      const res = await fetch(cand.url, {
        headers: { 'User-Agent': 'NAVFLIX/1.0 (personal media library)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500 || buf.length > 4 * 1024 * 1024) continue;
      text = buf.toString('utf8');
    } catch (e) { continue; }

    const stats = srtStats(text);
    if (!stats) continue;

    // Score on how much of the film it actually covers.
    let score = stats.cues;
    let coverage = null;
    if (runtime > 0) {
      coverage = Math.round((stats.lastCue / runtime) * 100);
      if (coverage < 70) continue;                 // truncated - skip it entirely
      score += (coverage > 100 ? 0 : coverage) * 20;
    } else {
      // Runtime unknown, so judge by absolute length instead. An episode is
      // legitimately ~45 minutes, so the film threshold would reject them all.
      const floor = shape ? 12 * 60 : 45 * 60;
      if (stats.lastCue < floor) continue;
      score += Math.round(stats.lastCue / 10);
    }

    if (!best || score > best.score) {
      best = { text, score, cues: stats.cues, lastCue: stats.lastCue, coverage,
        name: cand.subtitleFileName || '', poolIndex: i };
    }
    if (coverage !== null && coverage >= 90) break;   // good enough, stop early
  }

  if (!best) throw new Error('Only partial subtitles were available for this film.');

  // Keep the other candidates: the best-covering one is not always the one timed
  // for your particular release, so "try another" needs somewhere to go.
  const pool = eng.slice(0, 8).map((s) => ({ url: s.url, name: s.subtitleFileName || '' }));
  saveSubtitleFile(c, item, best.text, {
    cues: best.cues, lastCue: Math.round(best.lastCue), coverage: best.coverage,
    pool: pool, pick: best.poolIndex == null ? 0 : best.poolIndex,
  });
  return rec(c, item.rel).extSub;
}

function subFilePath(c, rel) {
  return path.join(SUB_DIR, crypto.createHash('sha1').update(c.id + '|' + rel).digest('hex') + '.srt');
}

function saveSubtitleFile(c, item, text, meta) {
  fs.mkdirSync(SUB_DIR, { recursive: true });
  const file = subFilePath(c, item.rel);
  fs.writeFileSync(file, text, 'utf8');

  const r = rec(c, item.rel);
  const prev = r.extSub || {};
  r.extSub = Object.assign({}, prev, meta, {
    file: file, source: 'opensubtitles', at: new Date().toISOString(),
  });
  delete r.sub;              // fall back to auto, which now prefers this file
  saveNow();
  return r.extSub;
}

// Fetch a specific candidate from the pool, no coverage filtering — you asked
// for this one, so you get it.
async function fetchCandidate(c, item, poolIndex) {
  const r = rec(c, item.rel);
  const pool = (r.extSub && r.extSub.pool) || [];
  if (!pool.length) throw new Error('No other subtitles were found for this one.');

  const idx = ((poolIndex % pool.length) + pool.length) % pool.length;
  const cand = pool[idx];
  const res = await fetch(cand.url, {
    headers: { 'User-Agent': 'NAVFLIX/1.0 (personal media library)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error('That subtitle could not be downloaded (HTTP ' + res.status + ').');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error('That subtitle file looks empty.');

  const text = buf.toString('utf8');
  const stats = srtStats(text);
  if (!stats) throw new Error('That file is not readable as subtitles.');

  const runtime = item.duration > 0 ? item.duration : 0;
  saveSubtitleFile(c, item, text, {
    cues: stats.cues,
    lastCue: Math.round(stats.lastCue),
    coverage: runtime > 0 ? Math.round((stats.lastCue / runtime) * 100) : null,
    pick: idx,
  });
  // A different file means the old nudge no longer applies.
  delete r.subDelay;
  saveNow();
  return r.extSub;
}

// Rewrite every timestamp in a stored .srt, for subtitles that drift because
// they were timed against a different frame rate.
function stretchSubtitle(c, item, ratio) {
  const r = rec(c, item.rel);
  if (!r.extSub || !r.extSub.file || !fs.existsSync(r.extSub.file)) {
    throw new Error('There is no downloaded subtitle to re-time.');
  }
  if (!(ratio > 0.5 && ratio < 2)) throw new Error('That stretch factor is out of range.');

  const text = fs.readFileSync(r.extSub.file, 'utf8');
  const shifted = text.replace(/(\d{2}):(\d{2}):(\d{2})([,.])(\d{3})/g, (m, hh, mm, ss, sep, ms) => {
    const total = ((+hh) * 3600 + (+mm) * 60 + (+ss)) * 1000 + (+ms);
    let out = Math.max(0, Math.round(total * ratio));
    const h = Math.floor(out / 3600000); out -= h * 3600000;
    const mi = Math.floor(out / 60000);  out -= mi * 60000;
    const s = Math.floor(out / 1000);    out -= s * 1000;
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(h) + ':' + p2(mi) + ':' + p2(s) + sep + String(out).padStart(3, '0');
  });

  fs.writeFileSync(r.extSub.file, shifted, 'utf8');
  const stats = srtStats(shifted);
  if (stats) {
    r.extSub.cues = stats.cues;
    r.extSub.lastCue = Math.round(stats.lastCue);
    if (item.duration > 0) r.extSub.coverage = Math.round((stats.lastCue / item.duration) * 100);
  }
  r.extSub.stretched = Number(((r.extSub.stretched || 1) * ratio).toFixed(4));
  saveNow();
  return r.extSub;
}

async function runSubJob(c, item) {
  subJob = { collectionId: c.id, rel: item.rel, title: item.title, running: true, note: 'identifying film', error: null };
  try {
    await fetchSubtitle(c, item);
    subJob.note = 'done';
  } catch (e) {
    subJob.error = e.message || String(e);
  }
  subJob.running = false;
  subJob.finishedAt = Date.now();
}

// ---------------------------------------------------------------- artwork

const IMG_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};
const GENERIC_ART = ['poster', 'folder', 'cover', 'movie', 'fanart', 'backdrop', 'thumb', 'banner', 'default'];
const ART_DIR = path.join(DATA_DIR, 'art');
const artCache = new Map(); // key -> { at, p }  (p = absolute image path, or '')
const ART_TTL = 60000;      // so art you drop in by hand is noticed without a restart

// One listing per folder, held as long as the art cache is. Looking for sixty
// candidate filenames used to mean sixty existsSync calls per video, and with
// a poster and a backdrop each that came to about a hundred and twenty. Across
// a real library on an external disk that was sixty-six thousand seeks and the
// better part of a minute staring at an empty page.
//
// Keyed on the lowercased name because Windows filesystems are not case
// sensitive and existsSync was matching Poster.JPG all along.
const dirCache = new Map();   // dir -> { at, index: Map(lowercase -> real name) }

function dirIndex(dir) {
  const now = Date.now();
  const hit = dirCache.get(dir);
  if (hit && now - hit.at < ART_TTL) return hit.index;

  const index = new Map();
  try {
    for (const name of fs.readdirSync(dir)) index.set(name.toLowerCase(), name);
  } catch (e) { /* folder gone or unreadable; an empty index is the right answer */ }
  dirCache.set(dir, { at: now, index: index });
  return index;
}

// The first candidate the folder actually holds, or empty.
function firstPresent(dir, names) {
  const index = dirIndex(dir);
  for (const n of names) {
    const real = index.get(n.toLowerCase());
    if (real) return path.join(dir, real);
  }
  return '';
}

function artCacheGet(key) {
  const hit = artCache.get(key);
  if (hit && Date.now() - hit.at < ART_TTL) return hit.p;
  return undefined;
}
function artCacheSet(key, p) {
  artCache.set(key, { at: Date.now(), p: p });
  return p;
}

// Downloaded artwork lives beside the state file, keyed by collection + filename,
// so it survives restarts and keeps working with no network. Two kinds: the
// portrait "poster" for rails, and the landscape "bg" for the billboard.
function cachedArtPath(c, rel, kind) {
  const h = crypto.createHash('sha1').update(c.id + '|' + rel).digest('hex');
  return path.join(ART_DIR, h + (kind === 'bg' ? '-bg' : '') + '.jpg');
}

// One poster for the whole show, rather than the same image copied per episode.
function showArtPath(c, kind) {
  const h = crypto.createHash('sha1').update(c.id + '|__show__').digest('hex');
  return path.join(ART_DIR, h + (kind === 'bg' ? '-bg' : '') + '.jpg');
}

const BACKDROP_ART = ['fanart', 'backdrop', 'background', 'banner'];

// A landscape image for the hero. Falls back to nothing — the UI then uses the
// poster, which is better than an empty billboard but crops badly.
function findBackdrop(c, rel) {
  const key = 'bg|' + c.id + '|' + rel;
  const memo = artCacheGet(key);
  if (memo !== undefined) return memo;

  const dir = path.dirname(path.join(c.path, rel));
  const base = path.basename(rel, path.extname(rel));
  const exts = Object.keys(IMG_MIME);
  const names = [];
  for (const suffix of ['-fanart', '-backdrop', '-background']) {
    for (const e of exts) names.push(base + suffix + e);
  }
  if (path.dirname(rel) !== '.') {
    for (const n of BACKDROP_ART) for (const e of exts) names.push(n + e);
  }

  let found = firstPresent(dir, names);
  if (!found) {
    const cached = cachedArtPath(c, rel, 'bg');
    try { if (fs.existsSync(cached)) found = cached; } catch (e) {}
  }
  if (!found && seriesShape(c)) {
    const showBg = showArtPath(c, 'bg');
    try { if (fs.existsSync(showBg)) found = showBg; } catch (e) {}
  }

  return artCacheSet(key, found);
}

function findArt(c, rel) {
  const key = c.id + '|' + rel;
  const memo = artCacheGet(key);
  if (memo !== undefined) return memo;

  const abs = path.join(c.path, rel);
  const dir = path.dirname(abs);
  const base = path.basename(rel, path.extname(rel));
  const exts = Object.keys(IMG_MIME);

  // An image named after the file is always safe.
  const names = exts.map((e) => base + e);

  // Generic names only count when the film sits in its own subfolder — in a flat
  // folder one poster.jpg would otherwise be used for every single film.
  if (path.dirname(rel) !== '.') {
    for (const n of GENERIC_ART) for (const e of exts) names.push(n + e);
  }

  let found = firstPresent(dir, names);

  // Files you supplied always beat anything downloaded.
  if (!found) {
    const cached = cachedArtPath(c, rel);
    try { if (fs.existsSync(cached)) found = cached; } catch (e) {}
  }
  // Episodes share the show's poster.
  if (!found && seriesShape(c)) {
    const showFile = showArtPath(c);
    try { if (fs.existsSync(showFile)) found = showFile; } catch (e) {}
  }

  return artCacheSet(key, found);
}

function serveArt(res, c, rel, kind) {
  if (!c) { res.writeHead(404); return res.end(); }
  // Keep the request inside the collection folder.
  const abs = path.resolve(c.path, rel);
  if (abs.indexOf(path.resolve(c.path)) !== 0) { res.writeHead(403); return res.end(); }

  const img = kind === 'bg' ? findBackdrop(c, rel) : findArt(c, rel);
  if (!img) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'Content-Type': IMG_MIME[path.extname(img).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  });
  return fs.createReadStream(img).pipe(res);
}

// ---------------------------------------------------------------- poster fetch
//
// Only ever runs when you press "Get posters". It sends the film's title and year
// to a public catalogue, downloads the artwork once, and caches it on disk — after
// that the app is fully offline again. iTunes needs no key; TMDB is used instead
// when you supply one, because its coverage is better.

let artJob = null; // { collectionId, total, done, found, failed, running, note }

// "01 Iron Man (2008)" -> { query: "Iron Man", year: "2008" }
function searchTerms(title) {
  let t = title;
  let year = '';
  const ym = t.match(/\((19|20)\d{2}\)\s*$/);
  if (ym) {
    year = ym[0].replace(/[()\s]/g, '');
    t = t.slice(0, ym.index);
  }
  const full = t.trim();
  // A leading "01 " is an ordering prefix, but "12 Angry Men" is a real title, so
  // the unstripped form is tried first and this is only the fallback.
  const stripped = full.replace(/^\d{1,3}[\s.\-)]+/, '').trim();
  const queries = [full];
  if (stripped && stripped !== full) queries.push(stripped);
  return { queries: queries.filter(Boolean), year: year };
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NAVFLIX/1.0 (personal media library)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// A search always returns *something*, so an unrecognised film would otherwise be
// given the poster of an unrelated one. Only accept a confident match: the title
// matches exactly, or the year matches and the title is at least a prefix.
function scoreMatch(candidateTitle, candidateYear, wantTitle, wantYear) {
  const a = norm(candidateTitle), b = norm(wantTitle);
  const titleExact = a === b;
  const titlePartial = !titleExact && (a.startsWith(b) || b.startsWith(a));
  const yearExact = !!wantYear && String(candidateYear || '').slice(0, 4) === wantYear;
  if (titleExact && (yearExact || !wantYear)) return 3;
  if (titleExact) return 2;
  if (yearExact && titlePartial) return 2;
  return 0;
}

// Stremio's public Cinemeta catalogue: no key, no signup, IMDb-backed.
async function lookupCinemeta(query, year) {
  const url = 'https://v3-cinemeta.strem.io/catalog/movie/top/search=' +
    encodeURIComponent(query) + '.json';
  const data = await getJson(url);
  const metas = (data && data.metas) || [];

  let best = null, bestScore = 0;
  for (const m of metas) {
    if (!m.poster) continue;
    const sc = scoreMatch(m.name, m.releaseInfo, query, year);
    if (sc > bestScore) { best = m; bestScore = sc; }
  }
  if (bestScore < 2 || !best) return null;
  return { poster: best.poster, background: best.background || null };
}

async function lookupTmdb(query, year, key) {
  let url = 'https://api.themoviedb.org/3/search/movie?api_key=' + encodeURIComponent(key) +
    '&query=' + encodeURIComponent(query);
  if (year) url += '&year=' + year;
  const data = await getJson(url);
  const hit = (data && data.results || []).find((r) => r.poster_path);
  if (!hit) return null;
  return {
    poster: 'https://image.tmdb.org/t/p/w500' + hit.poster_path,
    background: hit.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + hit.backdrop_path : null,
  };
}

// -> { poster, background } or null
async function lookupArtwork(title) {
  const { queries, year } = searchTerms(title);
  const key = (state.tmdbKey || '').trim();
  for (const q of queries) {
    try {
      const hit = key ? await lookupTmdb(q, year, key) : await lookupCinemeta(q, year);
      if (hit && hit.poster) return hit;
    } catch (e) { /* try the next phrasing */ }
  }
  return null;
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 || buf.length > 8 * 1024 * 1024) throw new Error('bad size');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

// A series is one lookup for the whole show plus a still per episode — quite
// unlike a film folder, where every entry is a separate title to identify.
async function runSeriesArtJob(c, force) {
  const shape = seriesShape(c);
  const queue = buildQueue(c);
  artJob = {
    collectionId: c.id, total: queue.length, done: 0, found: 0, failed: 0,
    running: true, note: 'Cinemeta · series',
  };

  try {
    if (!c.seriesMeta || force) await fetchSeriesMeta(c, shape);
  } catch (e) { /* handled by the check below */ }

  if (!c.seriesMeta) {
    artJob.done = queue.length;
    artJob.failed = queue.length;
    artJob.running = false;
    artJob.error = 'Could not identify the show "' + shape.show + '".';
    return;
  }

  // One poster and one backdrop for the show itself.
  for (const kind of ['', 'bg']) {
    const url = kind === 'bg' ? c.seriesMeta.background : c.seriesMeta.poster;
    const dest = showArtPath(c, kind);
    if (!url) continue;
    if (!force && fs.existsSync(dest)) continue;
    try { await downloadTo(url, dest); } catch (e) { /* not fatal */ }
  }
  artCache.clear();

  // Then the per-episode still, which is what the billboard shows.
  for (const item of queue) {
    if (!artJob || !artJob.running) break;
    artJob.done++;
    const ep = parseEpisode(item.rel);
    const meta = ep && c.seriesMeta.episodes[ep.season + ':' + ep.episode];
    if (!meta || !meta.thumbnail) { artJob.failed++; continue; }

    const dest = cachedArtPath(c, item.rel, 'bg');
    rec(c, item.rel).artTried = true;
    if (!force && fs.existsSync(dest)) { artJob.found++; continue; }
    try {
      await downloadTo(meta.thumbnail, dest);
      artCache.delete('bg|' + c.id + '|' + item.rel);
      artJob.found++;
    } catch (e) {
      artJob.failed++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  saveNow();
  artJob.running = false;
  artJob.finishedAt = Date.now();
}

async function runArtJob(c, force) {
  if (seriesShape(c)) return runSeriesArtJob(c, force);

  const queue = buildQueue(c);
  artJob = {
    collectionId: c.id, total: queue.length, done: 0, found: 0, failed: 0,
    running: true, note: (state.tmdbKey || '').trim() ? 'TMDB' : 'Cinemeta',
  };

  for (const item of queue) {
    if (!artJob || !artJob.running) break;
    artJob.done++;

    const needPoster = force || !findArt(c, item.rel);
    const needBg = force || !findBackdrop(c, item.rel);
    if (!needPoster && !needBg) continue;                   // already covered

    try {
      const hit = await lookupArtwork(item.title);
      if (!hit) {
        artJob.failed++;
        rec(c, item.rel).artTried = true;                   // don't keep retrying
        continue;
      }
      if (needPoster && hit.poster) {
        await downloadTo(hit.poster, cachedArtPath(c, item.rel));
        artCache.delete(c.id + '|' + item.rel);
      }
      if (needBg && hit.background) {
        await downloadTo(hit.background, cachedArtPath(c, item.rel, 'bg'));
        artCache.delete('bg|' + c.id + '|' + item.rel);
      }
      rec(c, item.rel).artTried = true;
      artJob.found++;
    } catch (e) {
      artJob.failed++;
    }
    save();
    // Be a polite guest on a free public API.
    await new Promise((r) => setTimeout(r, 320));
  }
  saveNow();

  if (artJob) {
    artJob.running = false;
    artJob.finishedAt = Date.now();
  }
}

// ---------------------------------------------------------------- search
//
// Finding a title across every folder at once. Deliberately not buildQueue: that
// resolves artwork, subtitles and progress for every file, and doing it for nine
// hundred files on each keystroke would be absurd. This walks the cached
// directory listing and compares names, nothing more.

const SEARCH_LIMIT = 60;

function searchTitles(q) {
  const needle = String(q || '').trim().toLowerCase();
  // One letter matches most of a library, which is neither useful nor cheap.
  if (needle.length < 2) return { q: needle, hits: [], total: 0, folders: 0 };

  const hits = [];
  let total = 0;
  let folders = 0;

  for (const c of state.collections) {
    if (!c.path || !fs.existsSync(c.path)) continue;
    const series = !!seriesShape(c);
    let matchedHere = false;

    orderedFiles(c).forEach((f, i) => {
      const title = displayTitle(c, f.rel, series);
      // The filename is searched too: a release name carries the year and the
      // original title, which is often what you half-remember.
      if ((title + ' ' + f.rel).toLowerCase().indexOf(needle) === -1) return;
      total++;
      matchedHere = true;
      if (hits.length >= SEARCH_LIMIT) return;

      // Read the record without creating one — searching should not write.
      const r = (c.progress && c.progress[f.rel]) || null;
      hits.push({
        collectionId: c.id,
        collection: c.name,
        index: i,
        rel: f.rel,
        title: title,
        file: f.rel.split('/').pop(),
        series: series,
        done: !!(r && r.done),
        position: r ? r.position : 0,
        duration: r ? r.duration : 0,
        art: findArt(c, f.rel) ? '/api/art?c=' + encodeURIComponent(c.id) + '&rel=' + urlPart(f.rel) : null,
        backdrop: findBackdrop(c, f.rel) ? '/api/art?kind=bg&c=' + encodeURIComponent(c.id) + '&rel=' + urlPart(f.rel) : null,
      });
    });
    if (matchedHere) folders++;
  }

  return { q: needle, hits: hits, total: total, folders: folders };
}

// ---------------------------------------------------------------- details
//
// Two very different kinds of fact about the same film, gathered by one job.
//
//   What is in the file   resolution, codecs, audio and subtitle tracks, real
//                         runtime. Read straight out of the container header by
//                         probe.js. Local, exact, and free.
//
//   What the film is      cast, director, writer, genres, IMDb rating, plot.
//                         One catalogue lookup per title, cached forever after.
//
// Both are kept on the file's own progress record, so they survive a restart and
// a drive being unplugged. Neither is ever gathered behind your back: the scan
// only runs when you press the button.

let detailJob = null; // { collectionId, total, done, phase, running, ... }

// The probe is cheap to repeat but not free — roughly 75ms a file on an external
// drive, which is a minute for a shelf of 800. Cache on size and mtime so a
// rescan only pays for what actually changed.
function storedMedia(c, rel, size) {
  const m = rec(c, rel).media;
  if (!m || !m.at) return null;
  if (size && m.size && m.size !== size) return null;   // the file was replaced
  return m;
}

function probeInto(c, rel) {
  const file = path.join(c.path, rel.split('/').join(path.sep));
  const p = probe.probeFile(file);
  if (!p) return null;
  p.at = new Date().toISOString();
  const r = rec(c, rel);
  r.media = p;
  // Runtime used to arrive only after VLC had played a title once, which is why
  // an untouched shelf shows "Not started" with no length and no part strip.
  // The container knows it already. VLC still overwrites this on first play, so
  // the worst case is the estimate being replaced by the same number.
  if (!r.duration && p.duration > 0) r.duration = p.duration;
  return p;
}

// Cinemeta's catalogue search returns no people at all — only id, name, poster
// and year — so identifying a film and describing it are two separate requests.
async function fetchTitleInfo(kind, imdb) {
  const full = await getJson('https://v3-cinemeta.strem.io/meta/' + kind + '/' + imdb + '.json');
  const m = (full && full.meta) || {};
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : (v ? [String(v)] : []));
  return {
    imdb: imdb,
    name: m.name || '',
    year: String(m.year || m.releaseInfo || ''),
    rating: m.imdbRating ? String(m.imdbRating) : '',
    runtime: m.runtime || '',
    genres: list(m.genres || m.genre),
    cast: list(m.cast),
    director: list(m.director),
    writer: list(m.writer),
    country: m.country || '',
    awards: m.awards || '',
    description: m.description || '',
    at: new Date().toISOString(),
  };
}

// A show is one lookup for the whole collection; its people go on seriesMeta
// beside the episode list that is already there.
async function fetchShowInfo(c) {
  if (!c.seriesMeta || !c.seriesMeta.imdb) return null;
  const info = await fetchTitleInfo('series', c.seriesMeta.imdb);
  c.seriesMeta.info = info;
  saveNow();
  return info;
}

async function runDetailJob(c, force) {
  const queue = buildQueue(c);
  const series = !!seriesShape(c);
  detailJob = {
    collectionId: c.id, total: queue.length, done: 0,
    read: 0, found: 0, failed: 0, running: true,
    phase: 'files', note: 'reading file headers',
  };

  // Phase one: what is inside each file. No network, so this always works.
  //
  // Reading a header is synchronous and takes about 75ms on an external drive,
  // so a shelf of 100 films would hold the event loop for eight seconds — long
  // enough that the progress bar could never be drawn and the page would look
  // hung. Hand control back between files so the poll gets served.
  for (const item of queue) {
    if (!detailJob || !detailJob.running) break;
    detailJob.done++;
    if (!force && storedMedia(c, item.rel, item.size)) continue;
    try { if (probeInto(c, item.rel)) detailJob.read++; } catch (e) { /* unreadable file */ }
    await new Promise((resolve) => setImmediate(resolve));
  }
  saveNow();
  if (!detailJob || !detailJob.running) return;

  // Phase two: who made it. One request for a show, one per film otherwise.
  detailJob.phase = 'titles';
  detailJob.done = 0;
  detailJob.note = 'looking up cast and crew';

  if (series) {
    detailJob.total = 1;
    try {
      if (force || !(c.seriesMeta && c.seriesMeta.info)) await fetchShowInfo(c);
      if (c.seriesMeta && c.seriesMeta.info) detailJob.found++; else detailJob.failed++;
    } catch (e) {
      detailJob.failed++;
      detailJob.error = 'Could not reach the catalogue.';
    }
    detailJob.done = 1;
  } else {
    detailJob.total = queue.length;
    for (const item of queue) {
      if (!detailJob || !detailJob.running) break;
      detailJob.done++;
      const r = rec(c, item.rel);
      if (!force && r.info) { detailJob.found++; continue; }
      // A film that has already been looked up for artwork or subtitles knows
      // its own id; only the ones that do not cost a second request.
      try {
        const id = (r.info && r.info.imdb) || await imdbIdFor(item.title);
        if (!id) { r.info = null; detailJob.failed++; continue; }
        r.info = await fetchTitleInfo('movie', id);
        detailJob.found++;
      } catch (e) {
        detailJob.failed++;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    saveNow();
  }

  detailJob.running = false;
  detailJob.finishedAt = Date.now();
}

const KB = 1024, MB = KB * 1024, GB = MB * 1024;
function niceSize(n) {
  if (!n) return '';
  if (n >= GB) return (n / GB).toFixed(n >= 10 * GB ? 0 : 1) + ' GB';
  if (n >= MB) return Math.round(n / MB) + ' MB';
  return Math.round(n / KB) + ' KB';
}

// Everything the Details view draws, for one collection. Only what has already
// been gathered — this never reads a file or the network, so opening the page is
// instant whether or not you have run a scan.
function detailsFor(c) {
  const missing = !c.path || !fs.existsSync(c.path);
  const queue = missing ? [] : buildQueue(c);
  const series = !!seriesShape(c);
  const show = (c.seriesMeta && c.seriesMeta.info) || null;

  const items = queue.map((m) => {
    const r = rec(c, m.rel);
    const media = r.media || null;
    // The pixels are the fact and the label is an opinion about them, so the
    // label is worked out fresh every time. A cached "576p" would otherwise
    // outlive the day the bucketing was wrong about 4:3 video.
    if (media && media.width) media.quality = probe.qualityLabel(media.width, media.height) || media.quality;
    return {
      rel: m.rel,
      title: m.title,
      file: m.rel.split('/').pop(),
      season: m.season, episode: m.episode,
      done: m.done,
      size: m.size || (media && media.size) || 0,
      sizeText: niceSize(m.size || (media && media.size) || 0),
      art: m.art,
      backdrop: m.backdrop,
      media: media,
      info: series ? null : (r.info || null),
    };
  });

  // A shelf-level summary: what you actually own, in one line each.
  const tally = (key, pick) => {
    const counts = {};
    for (const it of items) {
      const v = pick(it);
      if (!v) continue;
      counts[v] = (counts[v] || 0) + 1;
    }
    return Object.keys(counts)
      .map((k) => ({ name: k, count: counts[k] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  const scanned = items.filter((it) => it.media).length;
  const identified = series ? (show ? items.length : 0) : items.filter((it) => it.info).length;
  const bytes = items.reduce((n, it) => n + (it.size || 0), 0);
  const seconds = items.reduce((n, it) => n + ((it.media && it.media.duration) || 0), 0);

  // People, counted across the whole folder. For a show there is one credit
  // list, so this is really only interesting on a film shelf.
  const credit = (field) => {
    const counts = {};
    for (const it of items) {
      for (const who of ((it.info && it.info[field]) || [])) counts[who] = (counts[who] || 0) + 1;
    }
    return Object.keys(counts).map((k) => ({ name: k, count: counts[k] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  return {
    id: c.id, name: c.name, series: series, missing: missing,
    show: show,
    items: items,
    summary: {
      files: items.length, scanned: scanned, identified: identified,
      bytes: bytes, bytesText: niceSize(bytes), seconds: Math.round(seconds),
      quality: tally('quality', (it) => it.media && it.media.quality),
      video: tally('video', (it) => it.media && it.media.video),
      container: tally('container', (it) => it.media && it.media.container),
      source: tally('source', (it) => it.media && it.media.source),
      genres: (function () {
        const counts = {};
        const lists = series
          ? [(show && show.genres) || []]
          : items.map((it) => (it.info && it.info.genres) || []);
        for (const g of lists) for (const name of g) counts[name] = (counts[name] || 0) + 1;
        return Object.keys(counts).map((k) => ({ name: k, count: counts[k] }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      })(),
      cast: series ? ((show && show.cast) || []).map((n) => ({ name: n, count: 1 })) : credit('cast'),
      directors: series ? ((show && show.director) || []).map((n) => ({ name: n, count: 1 })) : credit('director'),
    },
    job: detailJob && detailJob.collectionId === c.id ? detailJob : null,
  };
}

// encodeURIComponent leaves ( ) ' * ! alone, and those break CSS url() when the
// address is dropped into a background-image. Encode them too.
function urlPart(s) {
  return encodeURIComponent(s).replace(/[()'*!]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

function rec(c, rel) {
  if (!c.progress[rel]) {
    c.progress[rel] = { position: 0, duration: 0, done: false, lastPlayed: null };
  }
  return c.progress[rel];
}

// The order the queue numbers files in. Search needs the same numbering to hand
// back an index that opens the film you clicked, so both go through here rather
// than each sorting for itself and drifting apart later.
function orderedFiles(c) {
  const files = scanLibrary(c.path).slice();

  // Filename order is usually right, but season/episode order is definitive —
  // it survives inconsistent naming across seasons.
  if (seriesShape(c)) {
    files.sort((a, b) => {
      const pa = parseEpisode(a.rel), pb = parseEpisode(b.rel);
      if (!pa || !pb) return collator.compare(a.rel, b.rel);
      return (pa.season - pb.season) || (pa.episode - pb.episode) || collator.compare(a.rel, b.rel);
    });
  }
  return files;
}

// Listing a video's subtitle tracks means opening the video: a megabyte off the
// disk per file, nine when the track table sits past the first one. It is by far
// the most expensive thing a queue does, and almost nothing needs it — only the
// collection you actually have open draws a subtitle dropdown.
//
// It used to happen for every collection on every /api/state, because the Library
// grid and the tab counts are built from queues too. Measured on a 23-folder
// library: 1,085 MB read to draw a list of folder names, of which 1,084 MB was
// for folders that were not even on screen. On an external drive that is the
// difference between a two-minute first load and an instant one. So `withSubs`
// is opt-in, and the two callers that genuinely need it ask.
function buildQueue(c, withSubs) {
  const files = orderedFiles(c);
  const series = seriesShape(c);

  return files.map((f, i) => {
    const r = rec(c, f.rel);
    const ep = series ? parseEpisode(f.rel) : null;
    return {
      index: i,
      rel: f.rel,
      size: f.size,
      title: displayTitle(c, f.rel, series),
      season: ep ? ep.season : null,
      episode: ep ? ep.episode : null,
      overview: (series && episodeMeta(c, f.rel) || {}).overview || null,
      position: r.position,
      duration: r.duration,
      done: r.done,
      lastPlayed: r.lastPlayed,
      art: findArt(c, f.rel) ? '/api/art?c=' + encodeURIComponent(c.id) + '&rel=' + urlPart(f.rel) : null,
      backdrop: findBackdrop(c, f.rel) ? '/api/art?kind=bg&c=' + encodeURIComponent(c.id) + '&rel=' + urlPart(f.rel) : null,
      artTried: !!r.artTried,
      subs: withSubs ? subsFor(c, f.rel) : null,
    };
  });
}

function currentIndex(queue) {
  return queue.findIndex((m) => !m.done);
}

// ---------------------------------------------------------------- vlc

let session = null;

// VLC lives somewhere different on each machine, so remember one path per
// platform. Sharing a single field meant the two laptops overwrote each other
// every time the disk moved.
function vlcSlot() {
  return process.platform;
}

function rememberVlc(p) {
  state.vlcPaths = state.vlcPaths || {};
  state.vlcPaths[vlcSlot()] = p;
  state.vlcPath = p;             // what this machine is using, for the UI
  save();
}

function findVlc() {
  const saved = (state.vlcPaths && state.vlcPaths[vlcSlot()]) || '';
  if (saved && fs.existsSync(saved)) { state.vlcPath = saved; return saved; }
  for (const cand of vlcCandidates()) {
    if (fs.existsSync(cand)) { rememberVlc(cand); return cand; }
  }
  const onPath = vlcOnPath();
  if (onPath) { rememberVlc(onPath); return onPath; }
  state.vlcPath = '';
  return null;
}

function play(c, index, extraSeconds) {
  if (session) throw new Error('An episode is already playing.');
  const vlc = findVlc();
  if (!vlc) throw new Error('VLC was not found. Set the VLC path in Settings.');

  const queue = buildQueue(c);
  const item = queue[index];
  if (!item) throw new Error('That episode is no longer in the collection.');

  const file = path.join(c.path, item.rel);
  if (!fs.existsSync(file)) throw new Error('File is missing: ' + item.rel);

  const start = Math.max(0, Math.floor(item.position));
  const budget = Math.floor(sittingLength(c)) + (Number(extraSeconds) || 0);
  const whole = !!c.fullMode;                  // watch it all in one go
  const leftInFilm = item.duration > 0 ? Math.max(0, Math.floor(item.duration) - start) : Infinity;

  // No short-sitting guard any more: every sitting is a full episode unless the
  // film itself runs out first, and finishing a film off is always worth doing.

  // In whole-film mode nothing is capped: VLC simply runs to the end.
  let stop = whole ? (item.duration > 0 ? Math.floor(item.duration) : 0) : start + budget;
  if (!whole && item.duration > 0) stop = Math.min(stop, Math.floor(item.duration));
  if (leftInFilm !== Infinity && leftInFilm < 5) {
    throw new Error('There is nothing left to watch in this file.');
  }
  if (!whole && stop - start < 5) throw new Error('There is nothing left to watch in this file.');

  const httpPort = 9911 + Math.floor(Math.random() * 60);
  const password = 'ep' + Math.random().toString(36).slice(2, 10);

  const args = [
    file,
    '--start-time=' + start,
    '--play-and-exit',
    '--no-one-instance',
    '--no-loop',
    '--no-repeat',
    '--no-random',
    '--no-video-title-show',
    '--extraintf=http',
    '--http-host=127.0.0.1',
    '--http-port=' + httpPort,
    '--http-password=' + password,
  ];
  // Subtitles: an embedded track, an external file, or none at all.
  const sub = subTarget(c, item.rel);
  if (sub.off) args.push('--no-spu');
  else if (sub.file) args.push('--sub-file=' + sub.file);
  else args.push('--sub-track-id=' + sub.track);


  // VLC forgets a hand-tuned delay the moment it closes, and NAVFLIX starts a
  // fresh VLC every sitting — so the offset is stored per film and reapplied.
  // --sub-delay counts in tenths of a second.
  const delayMs = Number(rec(c, item.rel).subDelay) || 0;
  if (!sub.off && delayMs) args.push('--sub-delay=' + Math.round(delayMs / 100));

  // Only cap the session when there is a daily limit to respect.
  if (!whole) args.push('--stop-time=' + stop);

  if (state.fullscreen) args.push('--fullscreen');

  const proc = spawn(vlc, args, { detached: false, stdio: 'ignore' });

  session = {
    proc: proc,
    collectionId: c.id,
    index: index,
    rel: item.rel,
    title: item.title,
    start: start,
    stop: stop,
    httpPort: httpPort,
    password: password,
    time: start,
    length: item.duration || 0,
    vlcState: 'starting',
    lastPoll: Date.now(),
    timer: null,
  };

  rec(c, item.rel).lastPlayed = new Date().toISOString();
  save();

  session.timer = setInterval(poll, 2000);
  proc.on('exit', finish);
  proc.on('error', finish);

  return session;
}

// The same local interface poll() reads from also takes commands, so pausing
// and seeking from the phone need no extra machinery.
function vlcCommand(command, params) {
  if (!session) return false;
  const s = session;
  const qs = new URLSearchParams(Object.assign({ command: command }, params || {}));
  const req = http.request(
    {
      host: '127.0.0.1',
      port: s.httpPort,
      path: '/requests/status.json?' + qs.toString(),
      headers: {
        Authorization: 'Basic ' + Buffer.from(':' + s.password).toString('base64'),
      },
      timeout: 1800,
    },
    (res) => { res.resume(); }        // fire and forget; poll() reads the result
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
  return true;
}

function poll() {
  if (!session) return;
  const s = session;
  const req = http.request(
    {
      host: '127.0.0.1',
      port: s.httpPort,
      path: '/requests/status.json',
      headers: {
        Authorization: 'Basic ' + Buffer.from(':' + s.password).toString('base64'),
      },
      timeout: 1800,
    },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { apply(JSON.parse(body)); } catch (e) { /* vlc not ready yet */ }
      });
    }
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

function apply(json) {
  if (!session) return;
  const c = findCollection(session.collectionId);
  if (!c) return;

  const now = Date.now();
  const elapsed = (now - session.lastPoll) / 1000;
  session.lastPoll = now;

  const time = Number(json.time) || 0;
  const length = Number(json.length) || 0;
  session.vlcState = json.state || 'unknown';
  if (length > 0) session.length = length;
  if (time > 0) session.time = time;

  const r = rec(c, session.rel);
  if (length > 0) r.duration = length;
  if (time > 0) r.position = time;

  // Only real playing time is counted, so pausing to make tea is free. This is
  // now just a statistic — nothing is rationed by it.
  if (json.state === 'playing' && elapsed > 0 && elapsed < 15) {
    c.day.secondsWatched += elapsed;
  }
  save();
}

function finish() {
  if (!session) return;
  const s = session;
  session = null;
  clearInterval(s.timer);

  const c = findCollection(s.collectionId);
  if (!c) return saveNow();

  const r = rec(c, s.rel);
  const reached = Math.max(r.position, s.time);
  r.position = reached;
  if (r.duration > 0 && reached >= r.duration - 30) {
    r.done = true;
    r.position = r.duration;
  }

  const seconds = Math.max(0, Math.round(reached - s.start));
  if (seconds > 20) {
    c.history.unshift({
      date: dayKey(),
      file: s.rel,
      title: s.title,
      from: Math.round(s.start),
      to: Math.round(reached),
      seconds: seconds,
    });
    c.history = c.history.slice(0, 300);
  }
  saveNow();
}

function stopSession() {
  if (!session) return;
  try { session.proc.kill(); } catch (e) {}
  setTimeout(() => { if (session) finish(); }, 800);
}

// ---------------------------------------------------------------- folder picker

function listRoots() {
  const out = [];
  const add = (name, p) => {
    try { if (p && fs.existsSync(p)) out.push({ name: name, path: p }); } catch (e) {}
  };

  if (IS_WIN) {
    for (let i = 67; i <= 90; i++) {
      add(String.fromCharCode(i) + ':\\', String.fromCharCode(i) + ':\\');
    }
    return out;
  }

  const home = os.homedir();
  add('Home', home);
  add('Movies', path.join(home, IS_MAC ? 'Movies' : 'Videos'));
  add('Downloads', path.join(home, 'Downloads'));

  const containers = IS_MAC
    ? ['/Volumes']
    : ['/media/' + (process.env.USER || ''), '/media', '/mnt', '/run/media/' + (process.env.USER || '')];
  for (const container of containers) {
    let kids = [];
    try { kids = fs.readdirSync(container, { withFileTypes: true }); } catch (e) { continue; }
    for (const k of kids) {
      if (k.isDirectory() && !k.name.startsWith('.')) add(k.name, path.join(container, k.name));
    }
  }

  add('/', '/');
  return out;
}

function browse(dir) {
  if (!dir) return { path: '', parent: '', dirs: listRoots(), videoCount: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { path: dir, parent: '', dirs: [], videoCount: 0, error: 'Cannot open that folder.' };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  const videoCount = entries.filter(
    (e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())
  ).length;
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? '' : parent, dirs: dirs, videoCount: videoCount };
}

// ---------------------------------------------------------------- api

// Is this collection a show, and how many seasons?
//
// Normally read straight off the folder. When the folder is unreachable — an
// external drive unplugged — fall back to the progress map, which still holds
// every filename the app has ever scanned. Running the same episode test over
// those names separates shows from film shelves cleanly (measured on a real
// library: 99-100% of names parse as episodes for shows, 0% for film folders),
// so the Library can sort itself without asking you to plug the drive in.
function shapeOf(c, queue, missing) {
  if (!missing) {
    const series = !!seriesShape(c);
    const seen = {};
    queue.forEach((m) => { if (m.season != null) seen[m.season] = true; });
    const seasons = Object.keys(seen).length;

    if (c.isSeries !== series || c.seasonCount !== seasons) {
      c.isSeries = series;
      c.seasonCount = seasons;
      save();
    }
    return { series: series, seasons: seasons };
  }

  const rels = Object.keys(c.progress || {});
  if (!rels.length) return { series: !!c.isSeries, seasons: c.seasonCount || 0 };

  const seen = {};
  let eps = 0;
  for (const rel of rels) {
    const p = parseEpisode(rel);
    if (!p) continue;
    eps++;
    seen[p.season] = true;
  }
  // Same 60% bar seriesShape uses. Shows clear it easily even with a stray
  // Extras folder or a double-episode file the pattern cannot read.
  const series = eps / rels.length >= 0.6;
  return { series: series, seasons: series ? Object.keys(seen).length : 0 };
}

function collectionCard(c) {
  rollDay(c);
  const missing = !c.path || !fs.existsSync(c.path);
  const queue = missing ? [] : buildQueue(c);
  const cur = currentIndex(queue);
  return {
    id: c.id,
    name: c.name,
    path: c.path,
    missing: missing,
    episodeMinutes: c.episodeMinutes,
    total: queue.length,
    done: queue.filter((m) => m.done).length,
    currentTitle: cur >= 0 ? queue[cur].title : null,
    noArt: queue.filter((m) => (!m.art || !m.backdrop) && !m.artTried).length,
    series: shapeOf(c, queue, missing).series,
    // A cover for the library grid: whatever the collection is up to next.
    art: (function () {
      const pick = queue[cur >= 0 ? cur : 0];
      if (!pick) return null;
      return pick.backdrop || pick.art || null;
    })(),
    seasons: shapeOf(c, queue, missing).seasons,
    fullMode: !!c.fullMode,
    sittingLength: Math.round(sittingLength(c)),
    watchedToday: Math.round(c.day.secondsWatched),
    playing: !!(session && session.collectionId === c.id),
    // Newest play anywhere in the collection. The tab row uses it to show the
    // two or three marathons you are mid-way through instead of every folder
    // you have ever added. ISO timestamps sort correctly as plain strings.
    lastPlayed: (function () {
      let best = null;
      for (const rel of Object.keys(c.progress || {})) {
        const t = c.progress[rel].lastPlayed;
        if (t && (!best || t > best)) best = t;
      }
      return best;
    })(),
  };
}

function snapshot(local) {
  const c = activeCollection();
  const cards = state.collections.map(collectionCard);

  const base = {
    collections: cards,
    activeId: c ? c.id : '',
    vlcPath: findVlc() || '',
    fullscreen: state.fullscreen,
    tmdbKey: state.tmdbKey || '',
    openOnStart: state.openOnStart !== false,
    remote: {
      enabled: !!state.remote.enabled,
      // The code and the addresses are only ever sent to this machine. A paired
      // phone has no business reading the credential it paired with.
      pin: local ? state.remote.pin : '',
      addresses: local ? lanAddresses().map((a) => 'http://' + a + ':' + PORT + '/remote') : [],
      paired: (state.remote.tokens || []).length,
    },
    artJob: artJob,
    subJob: subJob,
    playing: session
      ? {
          collectionId: session.collectionId,
          rel: session.rel,
          title: session.title,
          index: session.index,
          time: session.time,
          length: session.length,
          start: session.start,
          stop: session.stop,
          vlcState: session.vlcState,
        }
      : null,
  };

  if (!c) return Object.assign(base, { active: null });

  const missing = !c.path || !fs.existsSync(c.path);
  // The one queue that is actually looked at, so the one that pays for subtitles.
  const queue = missing ? [] : buildQueue(c, true);
  const totalDuration = queue.reduce((a, m) => a + (m.duration || 0), 0);
  const watched = queue.reduce((a, m) => a + (m.done ? (m.duration || m.position) : m.position), 0);
  const days = new Set(c.history.map((h) => h.date));

  return Object.assign(base, {
    active: {
      id: c.id,
      name: c.name,
      path: c.path,
      missing: missing,
      episodeMinutes: c.episodeMinutes,
      fullMode: !!c.fullMode,
      series: (function () { const sh = seriesShape(c); return sh ? { show: (c.seriesMeta && c.seriesMeta.name) || sh.show } : null; })(),
      queue: queue,
      currentIndex: currentIndex(queue),
      sittingLength: Math.round(sittingLength(c)),
      watchedToday: Math.round(c.day.secondsWatched),
      totalDuration: totalDuration,
      watched: watched,
      daysWatched: days.size,
      history: c.history.slice(0, 40),
    },
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (chunk) => { b += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Resolve the collection a request targets: explicit id, else the active one.
function target(body) {
  const c = body && body.collectionId ? findCollection(body.collectionId) : activeCollection();
  if (!c) throw new Error('No collection selected. Add a folder first.');
  return c;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// Requests from this machine are trusted exactly as before. Anything arriving
// over the network is a paired phone, and gets a much smaller surface: it can
// drive playback, but not reconfigure the app or read the filesystem.
//
// That distinction is not cosmetic. /api/settings takes a vlcPath that ends up
// in spawn(), and /api/browse lists any directory, so both stay local-only.
const REMOTE_ALLOWED = new Set([
  '/api/state', '/api/art', '/api/play', '/api/stop', '/api/mark',
  '/api/collections/select', '/api/subs', '/api/subs/next', '/api/subs/delay',
  '/api/vlc/pause', '/api/vlc/seek', '/api/remote/unpair',
]);

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function bearer(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return url.searchParams.get('t') || '';
}

function validToken(tok) {
  if (!tok) return false;
  const list = (state.remote && state.remote.tokens) || [];
  // Constant-time compare so a token cannot be guessed a byte at a time.
  const a = Buffer.from(tok);
  return list.some((t) => {
    const b = Buffer.from(t);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// Pairing is the one thing an unpaired phone may call, so it is the one thing
// worth brute-forcing. Five wrong guesses buys a five minute wait.
const pairFails = new Map();
const PAIR_MAX = 5;
const PAIR_LOCK = 5 * 60 * 1000;

function pairBlocked(ip) {
  const f = pairFails.get(ip);
  if (!f) return false;
  if (Date.now() - f.at > PAIR_LOCK) { pairFails.delete(ip); return false; }
  return f.n >= PAIR_MAX;
}

function pairFailed(ip) {
  const f = pairFails.get(ip);
  if (f && Date.now() - f.at <= PAIR_LOCK) { f.n++; f.at = Date.now(); }
  else pairFails.set(ip, { n: 1, at: Date.now() });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const local = isLocal(req);

  try {
    if (!local) {
      if (!state.remote.enabled) return json(res, 403, { error: 'The remote is switched off.' });

      // The remote page and its assets load before there is a token to send.
      const isPublic = p === '/remote' || p === '/remote.html' ||
        p === '/manifest.webmanifest' || p.startsWith('/icon-') || p.startsWith('/favicon');

      if (p === '/api/remote/pair' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || '?';
        if (pairBlocked(ip)) return json(res, 429, { error: 'Too many attempts. Wait five minutes.' });
        const b = await readBody(req);
        if (String(b.pin || '').trim() !== state.remote.pin) {
          pairFailed(ip);
          return json(res, 401, { error: 'Wrong code.' });
        }
        pairFails.delete(ip);
        const tok = crypto.randomBytes(24).toString('hex');
        state.remote.tokens.push(tok);
        // Keep the list from growing without bound as phones re-pair.
        state.remote.tokens = state.remote.tokens.slice(-10);
        saveNow();
        return json(res, 200, { token: tok });
      }

      if (!isPublic) {
        if (!validToken(bearer(req, url))) return json(res, 401, { error: 'Pair this device first.' });
        if (p.startsWith('/api/') && !REMOTE_ALLOWED.has(p)) {
          return json(res, 403, { error: 'That is not available from the remote.' });
        }
      }
    }
    if (p === '/api/state') return json(res, 200, snapshot(local));

    // The pairing QR carries the address and the code together, so the phone
    // is one scan from paired. Local-only, deliberately: it contains the code,
    // and a device that already has it has no use for a picture of it.
    if (p === '/api/remote/qr') {
      if (!local) return json(res, 403, { error: 'Not available remotely.' });
      if (!state.remote.enabled || !state.remote.pin) {
        return json(res, 400, { error: 'The remote is off.' });
      }
      const addrs = lanAddresses();
      if (!addrs.length) return json(res, 400, { error: 'No network address.' });
      const pick = Math.min(addrs.length - 1, Math.max(0, Number(url.searchParams.get('a')) || 0));
      // The code rides in the fragment, which browsers never send to a server,
      // so it stays out of logs and proxies on the way.
      const target = 'http://' + addrs[pick] + ':' + PORT + '/remote#' + state.remote.pin;
      const svg = qr.toSvg(target, { scale: 4, quiet: 3, dark: '#0a0a0c', light: '#ffffff' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(svg);
    }

    if (p === '/remote') {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'remote.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (p === '/api/browse') return json(res, 200, browse(url.searchParams.get('path') || ''));

    if (p === '/api/art') {
      return serveArt(res, findCollection(url.searchParams.get('c')), url.searchParams.get('rel') || '', url.searchParams.get('kind') || '');
    }

    if (p === '/api/collections/add' && req.method === 'POST') {
      const b = await readBody(req);
      // One folder, or a batch of them: the picker can tick several at once, which
      // is what you want the first time you point NAVFLIX at a shelf of shows.
      const batch = Array.isArray(b.paths) && b.paths.length > 0;
      const wanted = batch
        ? b.paths.map((x) => String(x || '').trim())
        : [String(b.path || '').trim()];

      let firstAdded = null;
      let added = 0;
      const skipped = [];

      for (const dir of wanted) {
        if (!dir || !fs.existsSync(dir)) { skipped.push({ name: path.basename(dir) || dir, why: 'gone' }); continue; }
        const existing = state.collections.find((c) => c.path === dir);
        if (existing) {
          if (!firstAdded) state.activeId = existing.id;
          skipped.push({ name: existing.name, why: 'already' });
          continue;
        }
        // Only when several were ticked. Adding one empty folder on purpose —
        // before copying files into it — has always been allowed and still is.
        // The scan costs nothing here: the snapshot below walks every collection
        // anyway, and scanLibrary caches what it just read.
        if (batch && wanted.length > 1 && !scanLibrary(dir).length) {
          skipped.push({ name: path.basename(dir), why: 'empty' });
          continue;
        }
        const c = blankCollection(dir, batch ? '' : String(b.name || '').trim());
        state.collections.push(c);
        added++;
        if (!firstAdded) { firstAdded = c.id; state.activeId = c.id; }
      }

      if (!added && !skipped.length) return json(res, 400, { error: 'That folder does not exist.' });
      if (!added && skipped.every((s) => s.why === 'gone')) {
        return json(res, 400, { error: 'That folder does not exist.' });
      }
      saveNow();
      return json(res, 200, Object.assign(snapshot(local), { added: added, skipped: skipped }));
    }

    if (p === '/api/collections/select' && req.method === 'POST') {
      const b = await readBody(req);
      const c = findCollection(b.id);
      if (!c) return json(res, 400, { error: 'Unknown collection.' });
      state.activeId = c.id;
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/collections/rename' && req.method === 'POST') {
      const b = await readBody(req);
      const c = findCollection(b.id);
      if (!c) return json(res, 400, { error: 'Unknown collection.' });
      const name = String(b.name || '').trim();
      if (!name) return json(res, 400, { error: 'Give it a name.' });
      c.name = name.slice(0, 60);
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/collections/repath' && req.method === 'POST') {
      const b = await readBody(req);
      const c = findCollection(b.id);
      if (!c) return json(res, 400, { error: 'Unknown collection.' });
      const dir = String(b.path || '').trim();
      if (!dir || !fs.existsSync(dir)) return json(res, 400, { error: 'That folder does not exist.' });
      c.path = dir;   // progress is keyed on relative paths, so it survives the move
      scanCache.clear();
      artCache.clear();
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/collections/remove' && req.method === 'POST') {
      const b = await readBody(req);
      const c = findCollection(b.id);
      if (!c) return json(res, 400, { error: 'Unknown collection.' });
      if (session && session.collectionId === c.id) stopSession();
      state.collections = state.collections.filter((x) => x.id !== c.id);
      if (state.activeId === c.id) {
        state.activeId = state.collections.length ? state.collections[0].id : '';
      }
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.episodeMinutes != null) {
        const c = target(b);
        c.episodeMinutes = Math.min(600, Math.max(5, Number(b.episodeMinutes) || 60));
      }
      if (b.fullMode != null) target(b).fullMode = !!b.fullMode;
      if (b.fullscreen != null) state.fullscreen = !!b.fullscreen;
      if (b.vlcPath != null) rememberVlc(String(b.vlcPath).trim());
      if (b.tmdbKey != null) state.tmdbKey = String(b.tmdbKey).trim();
      if (b.openOnStart != null) state.openOnStart = !!b.openOnStart;
      if (b.remoteEnabled != null) {
        state.remote.enabled = !!b.remoteEnabled;
        // First time on, mint a code. Turning it off drops every paired phone,
        // so re-enabling it later cannot be silently walked back into.
        if (state.remote.enabled && !state.remote.pin) state.remote.pin = newPin();
        if (!state.remote.enabled) state.remote.tokens = [];
      }
      if (b.newRemotePin) { state.remote.pin = newPin(); state.remote.tokens = []; }
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/play' && req.method === 'POST') {
      const b = await readBody(req);
      const c = target(b);
      const q = buildQueue(c);
      const idx = b.index != null ? Number(b.index) : currentIndex(q);
      if (idx == null || idx < 0) {
        return json(res, 400, { error: c.name + ' is complete \u2014 nothing left to watch.' });
      }
      play(c, idx, b.extraSeconds);
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/search') {
      return json(res, 200, searchTitles(url.searchParams.get('q') || ''));
    }

    if (p === '/api/details') {
      const c = state.collections.find((x) => x.id === url.searchParams.get('c')) || activeCollection();
      if (!c) return json(res, 404, { error: 'no collection' });
      return json(res, 200, detailsFor(c));
    }

    if (p === '/api/details/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const c = state.collections.find((x) => x.id === body.id) || activeCollection();
      if (!c) return json(res, 404, { error: 'no collection' });
      if (detailJob && detailJob.running) return json(res, 409, { error: 'a scan is already running' });
      runDetailJob(c, !!body.force).catch((e) => {
        if (detailJob) { detailJob.running = false; detailJob.error = String(e.message || e); }
      });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/details/cancel' && req.method === 'POST') {
      if (detailJob) detailJob.running = false;
      return json(res, 200, { ok: true });
    }

    if (p === '/api/art/fetch' && req.method === 'POST') {
      const b = await readBody(req);
      if (artJob && artJob.running) return json(res, 400, { error: 'Already fetching posters.' });
      const c = target(b);
      if (!c.path || !fs.existsSync(c.path)) return json(res, 400, { error: 'That folder is not reachable.' });
      runArtJob(c, !!b.force).catch(() => { if (artJob) artJob.running = false; });
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/art/cancel' && req.method === 'POST') {
      if (artJob) artJob.running = false;
      return json(res, 200, snapshot(local));
    }

    // Hands the token back. Doing this only on the phone would leave a working
    // credential on the server for anyone who had copied it.
    if (p === '/api/remote/unpair' && req.method === 'POST') {
      const tok = bearer(req, url);
      state.remote.tokens = (state.remote.tokens || []).filter((t) => t !== tok);
      saveNow();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/vlc/pause' && req.method === 'POST') {
      if (!session) return json(res, 400, { error: 'Nothing is playing.' });
      vlcCommand('pl_pause');
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/vlc/seek' && req.method === 'POST') {
      const b = await readBody(req);
      if (!session) return json(res, 400, { error: 'Nothing is playing.' });
      const d = Math.max(-600, Math.min(600, Number(b.delta) || 0));
      if (!d) return json(res, 400, { error: 'No seek amount given.' });
      vlcCommand('seek', { val: (d > 0 ? '+' : '') + d });
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/stop' && req.method === 'POST') {
      stopSession();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/subs/download' && req.method === 'POST') {
      const b = await readBody(req);
      if (subJob && subJob.running) return json(res, 400, { error: 'Already fetching subtitles.' });
      const c = target(b);
      const item = buildQueue(c)[Number(b.index)];
      if (!item) return json(res, 400, { error: 'Unknown episode.' });
      runSubJob(c, item);
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/subs/delay' && req.method === 'POST') {
      const b = await readBody(req);
      const c = target(b);
      const item = buildQueue(c)[Number(b.index)];
      if (!item) return json(res, 400, { error: 'Unknown episode.' });
      const r = rec(c, item.rel);
      const now = Number(r.subDelay) || 0;
      let next = b.reset ? 0 : now + (Number(b.deltaMs) || 0);
      next = Math.max(-60000, Math.min(60000, Math.round(next / 100) * 100));
      if (next === 0) delete r.subDelay; else r.subDelay = next;
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/subs/next' && req.method === 'POST') {
      const b = await readBody(req);
      const c = target(b);
      const item = buildQueue(c)[Number(b.index)];
      if (!item) return json(res, 400, { error: 'Unknown episode.' });
      const r = rec(c, item.rel);
      const pool = (r.extSub && r.extSub.pool) || [];
      if (pool.length < 2) return json(res, 400, { error: 'No other subtitles were found for this one.' });
      try {
        await fetchCandidate(c, item, (r.extSub.pick || 0) + 1);
      } catch (e) {
        return json(res, 400, { error: e.message || String(e) });
      }
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/subs/stretch' && req.method === 'POST') {
      const b = await readBody(req);
      const c = target(b);
      const item = buildQueue(c)[Number(b.index)];
      if (!item) return json(res, 400, { error: 'Unknown episode.' });
      try {
        stretchSubtitle(c, item, Number(b.ratio));
      } catch (e) {
        return json(res, 400, { error: e.message || String(e) });
      }
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/subs' && req.method === 'POST') {
      const b = await readBody(req);
      const c = target(b);
      const item = buildQueue(c)[Number(b.index)];
      if (!item) return json(res, 400, { error: 'Unknown episode.' });
      const r = rec(c, item.rel);
      if (b.choice === 'auto') delete r.sub;
      else if (b.choice === 'off') r.sub = 'off';
      else {
        const raw = String(b.choice);
        const want = /^x\d+$/.test(raw) ? raw : Number(raw);
        // One file's tracks, not the whole shelf's.
        if (!subsFor(c, item.rel).tracks.some((t) => t.id === want)) {
          return json(res, 400, { error: 'That subtitle track is not available for this film.' });
        }
        r.sub = want;
      }
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/mark' && req.method === 'POST') {
      const b = await readBody(req);
      const c = target(b);
      const item = buildQueue(c)[Number(b.index)];
      if (!item) return json(res, 400, { error: 'Unknown episode.' });
      const r = rec(c, item.rel);
      if (b.done === true) {
        r.done = true;
        if (r.duration) r.position = r.duration;
      } else if (b.done === false) {
        r.done = false;
      }
      if (b.rewind === true) {
        r.position = 0;
        r.done = false;
      }
      // Clicking a part on the strip moves the resume point to that sitting.
      if (b.seekTo != null) {
        const to = Math.max(0, Math.floor(Number(b.seekTo) || 0));
        r.position = r.duration > 0 ? Math.min(to, Math.floor(r.duration)) : to;
        r.done = false;
      }
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/reset-day' && req.method === 'POST') {
      const b = await readBody(req);
      const c = target(b);
      c.day = { key: dayKey(), secondsWatched: 0 };
      saveNow();
      return json(res, 200, snapshot(local));
    }

    if (p === '/api/reset-all' && req.method === 'POST') {
      const b = await readBody(req);
      const c = target(b);
      c.progress = {};
      c.history = [];
      c.day = { key: dayKey(), secondsWatched: 0 };
      saveNow();
      return json(res, 200, snapshot(local));
    }

    const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const abs = path.join(PUBLIC_DIR, file);
    if (abs.indexOf(PUBLIC_DIR) !== 0 || !fs.existsSync(abs)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(abs);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // The pages are the app. Serving a stale one against a newer API is how
      // you get a screen full of blanks, so they are never cached. Icons and
      // the manifest barely change and are cheap to keep.
      'Cache-Control': ext === '.html' ? 'no-store' : 'max-age=3600',
    });
    return fs.createReadStream(abs).pipe(res);
  } catch (err) {
    return json(res, 400, { error: err.message || String(err) });
  }
});

function openBrowser(url) {
  let cmd, args;
  if (IS_WIN) { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else if (IS_MAC) { cmd = 'open'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try {
    const proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    proc.on('error', () => {});   // headless box, or no xdg-open: the URL above still works
    proc.unref();
  } catch (e) { /* ignore */ }
}

// Loopback only unless you have deliberately switched the remote on.
const HOST = state.remote.enabled ? '0.0.0.0' : '127.0.0.1';

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log('');
  console.log('   Port ' + PORT + ' is already taken on ' + HOST + '.');
  if (HOST !== '127.0.0.1') {
    console.log('');
    console.log('   The phone remote is on, so NAVFLIX needs the port on every');
    console.log('   network interface, not just this machine. Something else already');
    console.log('   holds it there - a debugger agent or a dev server will do this');
    console.log('   without ever showing up when NAVFLIX was loopback only.');
  }
  console.log('');
  console.log('   Either stop whatever is using it, or run NAVFLIX on another port:');
  console.log('     set PORT=8788 && node server.js        (Windows)');
  console.log('     PORT=8788 node server.js               (macOS, Linux)');
  console.log('');
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = 'http://localhost:' + PORT;
  console.log('');
  console.log('   NAVFLIX is running');
  console.log('   ' + url);
  console.log('');
  console.log('   ' + state.collections.length + ' collection(s) tracked.');
  console.log('   Keep this window open while you watch. Close it to shut the app down.');
  if (state.remote.enabled) {
    console.log('');
    console.log('   Phone remote is ON. On a device on the same network, open:');
    const addrs = lanAddresses();
    if (addrs.length) addrs.forEach((a) => console.log('     http://' + a + ':' + PORT + '/remote'));
    else console.log('     (no network address found - is this machine online?)');
    console.log('   Pairing code: ' + state.remote.pin);
  }
  if (!findVlc()) {
    console.log('');
    console.log('   ! VLC was not found. Install it, or set the path under Settings.');
  }
  if (process.env.NO_OPEN || state.openOnStart === false) {
    console.log('');
    console.log('   Not opening a window (Settings \u2192 Open a window when NAVFLIX starts).');
  } else {
    openBrowser(url);
  }
});

process.on('SIGINT', () => {
  stopSession();
  saveNow();
  process.exit(0);
});
