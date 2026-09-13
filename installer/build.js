// Builds NAVFLIX-Setup.exe, an installer for someone who has never heard of Node.
//
//   node installer/build.js --vlc <vlc-3.x-win64.zip> [--node <node.exe>]
//                           [--iscc <ISCC.exe>] [--out <folder>] [--no-setup]
//
// Needs Windows, Inno Setup 6, and the portable VLC zip from videolan.org. The C#
// compiler it uses for the launcher ships with Windows.
//
// What goes in:
//   the app          server.js, probe.js, qr.js, package.json, LICENSE, public\
//   runtime\node\    node.exe, so nothing has to be installed first
//   runtime\vlc\     portable VLC, which NAVFLIX already looks for before any other
//   NAVFLIX.exe      the launcher, compiled here from installer\launcher\NAVFLIX.cs
//
// What never goes in: data\ (your library, progress, pairing code and phone
// tokens), .git, and the Linux and macOS runtimes.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const makeIcon = require('./make-icon');

const REPO = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.indexOf('--' + name) > -1;

const NODE = arg('node', path.join(REPO, 'runtime', 'node', 'node.exe'));
const VLC_ZIP = arg('vlc');
// Inno Setup installs either for one user or for everyone; look in both.
const ISCC = arg('iscc', [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
].find((p) => fs.existsSync(p)));
const OUT = path.resolve(arg('out', path.join(os.homedir(), 'Desktop')));
const WORK = path.resolve(arg('work', path.join(os.tmpdir(), 'navflix-installer-build')));
const STAGE = path.join(WORK, 'stage');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function need(file, what) {
  if (!file || !fs.existsSync(file)) {
    console.error('Missing ' + what + ': ' + (file || '(not given)'));
    process.exit(1);
  }
}
need(NODE, 'node.exe (--node)');
need(VLC_ZIP, 'the portable VLC zip (--vlc)');
need(CSC, 'the .NET Framework C# compiler');
if (!flag('no-setup')) need(ISCC, "Inno Setup's ISCC.exe (--iscc)");

const step = (s) => console.log('\n== ' + s);

step('Staging the app');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const f of ['server.js', 'probe.js', 'qr.js', 'package.json', 'LICENSE']) {
  if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), path.join(STAGE, f));
}
fs.cpSync(path.join(REPO, 'public'), path.join(STAGE, 'public'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'THIRD-PARTY-NOTICES.txt'), path.join(STAGE, 'THIRD-PARTY-NOTICES.txt'));
fs.mkdirSync(path.join(STAGE, 'runtime', 'node'), { recursive: true });
fs.copyFileSync(NODE, path.join(STAGE, 'runtime', 'node', 'node.exe'));
console.log('node ' + execFileSync(NODE, ['--version']).toString().trim());

step('Portable VLC');
const vlcTmp = path.join(WORK, 'vlc');
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  'Expand-Archive -LiteralPath $env:NAVFLIX_ZIP -DestinationPath $env:NAVFLIX_DEST -Force'], {
  env: Object.assign({}, process.env, { NAVFLIX_ZIP: VLC_ZIP, NAVFLIX_DEST: vlcTmp }),
  stdio: 'inherit',
});
const inner = fs.readdirSync(vlcTmp).find((n) => fs.existsSync(path.join(vlcTmp, n, 'vlc.exe')));
if (!inner) { console.error('No vlc.exe inside ' + VLC_ZIP); process.exit(1); }
fs.renameSync(path.join(vlcTmp, inner), path.join(STAGE, 'runtime', 'vlc'));
console.log('VLC from ' + inner);

step('Icon and launcher');
const ICON = path.join(WORK, 'navflix.ico');
console.log('icon: ' + makeIcon(path.join(REPO, 'public'), ICON).join(', '));
execFileSync(CSC, ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  '/out:' + path.join(STAGE, 'NAVFLIX.exe'), '/win32icon:' + ICON,
  '/r:System.Management.dll', '/r:System.Windows.Forms.dll',
  path.join(__dirname, 'launcher', 'NAVFLIX.cs')], { stdio: 'inherit' });
console.log('launcher compiled');

if (flag('no-setup')) {
  console.log('\nStaged in ' + STAGE + ' (no setup built)');
  process.exit(0);
}

step('Setup');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const version = /^\d+\.\d+\.\d+$/.test(pkg.version || '') ? pkg.version : '1.0.0';
fs.mkdirSync(OUT, { recursive: true });
execFileSync(ISCC, ['/Q', '/DStage=' + STAGE, '/DOutDir=' + OUT, '/DIcon=' + ICON, '/DAppVersion=' + version,
  path.join(__dirname, 'NAVFLIX.iss')], { stdio: 'inherit' });
const setup = path.join(OUT, 'NAVFLIX-Setup.exe');
console.log('\nBuilt ' + setup + ' (' + (fs.statSync(setup).size / 1048576).toFixed(1) + ' MB), version ' + version);
