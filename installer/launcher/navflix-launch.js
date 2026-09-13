// The Linux launcher: what the menu entry runs.
//
// It does for Linux what NAVFLIX.exe does for Windows, because NAVFLIX is a small
// web server plus a page, and a page in a browser tab has no way of stopping the
// server behind it:
//
//   1. Start the server in the background, or find the one already running.
//   2. Open NAVFLIX in a window of its own: Chrome or Chromium in app mode, with a
//      profile of its own so it is not mixed in with everyday browsing.
//   3. When that window closes, ask the server to stop. A film still playing in
//      VLC is allowed to finish first, so its position is saved.
//
// Written in Node because Node is already here: it is what runs NAVFLIX.
//
//   node navflix-launch.js          open NAVFLIX
//   node navflix-launch.js --quit   stop a running NAVFLIX now
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

// Every NAVFLIX window carries this in its command line, which is how its
// processes are told apart from anything else the browser has open.
const WINDOW_MARK = 'navflix-app-window';

// Walk up from wherever this file was installed until server.js turns up, so it
// works both from the repository and from an installed copy.
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'server.js'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

const ROOT = findRoot(__dirname);
const DATA = path.join(ROOT, 'data');
const RUNNING = path.join(DATA, 'running.json');
const LOG = path.join(DATA, 'navflix.log');
const PROFILE = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'navflix', WINDOW_MARK);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOG, new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + line + '\n');
  } catch (e) { /* nowhere to say it */ }
}

function request(method, port, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { Host: '127.0.0.1:' + port };
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: headers, timeout: 3000 },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (e) { /* not JSON */ } resolve(j); });
      });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (body) req.write(data);
    req.end();
  });
}

// The server writes data/running.json once it is listening. A file left behind by
// a crash is not trusted: the port has to answer, and answer as that same run.
async function findRunning() {
  let note;
  try { note = JSON.parse(fs.readFileSync(RUNNING, 'utf8')); } catch (e) { return null; }
  if (!note || !note.port || !note.instance) return null;
  const who = await request('GET', note.port, '/api/whoami');
  if (!who || who.instance !== note.instance) return null;
  return note;
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    detached: true,              // it has to outlive this launcher: see the quit below
    stdio: 'ignore',
    env: Object.assign({}, process.env, {
      NAVFLIX_LAUNCHER: '1',     // turns on the "nobody is using it" safety net
      NAVFLIX_LOG: LOG,          // no console to print to
      NO_OPEN: '1',              // the window is opened here, not by the server
    }),
  });
  child.unref();
  return child;
}

async function waitForServer(seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    const note = await findRunning();
    if (note) return note;
    await sleep(250);
  }
  return null;
}

function onPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch (e) { /* keep looking */ }
  }
  return null;
}

// Only browsers that can open a plain window with no address bar and no tabs.
// Firefox has no such mode, which is why it is not here.
function findBrowser() {
  const chosen = process.env.NAVFLIX_BROWSER;
  if (chosen && fs.existsSync(chosen)) return chosen;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'brave-browser', 'microsoft-edge', 'microsoft-edge-stable', 'vivaldi-stable'];
  for (const name of names) {
    const found = onPath(name);
    if (found) return found;
  }
  return null;
}

function openWindow(browser, url) {
  const args = ['--app=' + url, '--user-data-dir=' + PROFILE, '--no-first-run',
    '--no-default-browser-check', '--window-size=1440,900',
    // So the desktop matches the window to NAVFLIX's own icon and name rather
    // than to the browser's (StartupWMClass in navflix.desktop).
    '--class=NAVFLIX'];
  try {
    const child = spawn(browser, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return child;
  } catch (e) {
    log('could not open a window with ' + browser + ': ' + e.message);
    return null;
  }
}

// How many browser processes are carrying our window profile. Watching only the
// process that was started is not enough: with a window already open the browser
// hands the new one over and the process started here exits at once.
function countWindows() {
  if (process.platform !== 'linux') return -1;     // /proc is a Linux thing
  let pids;
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (e) { return -1; }
  let n = 0;
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      if (cmd.indexOf(WINDOW_MARK) !== -1) n++;
    } catch (e) { /* it ended while we looked, or is not ours to read */ }
  }
  return n;
}

// True once every NAVFLIX window has closed; false if none ever opened.
async function waitForWindows(child) {
  const byProc = countWindows() >= 0;
  if (!byProc) {
    // Not Linux, or /proc unreadable: the process that was started is all there
    // is to watch. Watched by asking rather than by waiting on its "exit" event:
    // the browser is let go of on purpose (unref) so a stuck one cannot hold
    // NAVFLIX open, and with nothing left holding the loop, waiting for that
    // event ended this launcher on the spot instead — without ever asking the
    // server to stop.
    if (!child) return false;
    while (child.exitCode === null && child.signalCode === null) await sleep(500);
    return true;
  }

  let appeared = false;
  for (let i = 0; i < 60 && !appeared; i++) {
    appeared = countWindows() > 0;
    if (!appeared) await sleep(500);
  }
  if (!appeared) return false;

  let emptyPolls = 0;
  while (emptyPolls < 2) {
    await sleep(1500);
    emptyPolls = countWindows() === 0 ? emptyPolls + 1 : 0;
  }
  return true;
}

async function quitRunning(force) {
  const note = await findRunning();
  if (!note) return 0;
  await request('POST', note.port, '/api/quit', force ? { force: true } : {});
  return 0;
}

async function main() {
  if (process.argv.indexOf('--quit') !== -1) return quitRunning(true);

  let note = await findRunning();
  let started = null;
  if (note) {
    // Opened again while it was waiting for a film to end before stopping: it is
    // wanted after all, so it stays.
    await request('POST', note.port, '/api/quit', { cancel: true });
  } else {
    log('opened from the menu');
    started = startServer();
    note = await waitForServer(90);
    if (!note) {
      log('the server did not start; see the lines above');
      console.error('NAVFLIX did not start. See ' + LOG);
      return 1;
    }
  }

  const url = note.url || ('http://localhost:' + note.port);
  const browser = findBrowser();
  if (!browser) {
    // No Chrome or Chromium, so an ordinary browser window it is. There is no
    // telling when a tab closes; the server stops itself once nothing has used
    // it for a while.
    log('no Chrome or Chromium found, opening ' + url + ' in the default browser');
    const opener = onPath('xdg-open');
    if (opener) spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
    else console.log('Open ' + url + ' in your browser.');
    return 0;
  }

  const child = openWindow(browser, url);
  if (!(await waitForWindows(child))) {
    log('the window never appeared; leaving NAVFLIX running');
    return 0;
  }

  const answer = await request('POST', note.port, '/api/quit', {});
  if (answer && answer.waitingForPlayback) {
    log('window closed while a film is playing; NAVFLIX will stop when VLC does');
    return 0;
  }
  // Give it a moment to save and go.
  for (let i = 0; i < 30; i++) {
    if (!(await findRunning())) break;
    await sleep(500);
  }
  if (started && started.pid) {
    try { process.kill(started.pid, 0); process.kill(started.pid, 'SIGTERM'); } catch (e) { /* already gone */ }
  }
  return 0;
}

main().then((code) => process.exit(code || 0)).catch((e) => {
  log('launcher failed: ' + (e && e.stack ? e.stack : e));
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
