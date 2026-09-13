// Builds the Windows installer: an ordinary setup program for someone who has
// never heard of Node.
//
//   node installer\build.js
//   node installer\build.js --vlc <vlc zip or folder> --node <node.exe> --out <folder>
//
// Everything has a sensible default, so the bare command works. Needs Windows,
// Inno Setup 6, a node.exe to bundle and a portable VLC. The C# compiler used for
// the launcher ships with Windows.
//
// The version comes from package.json and is stamped everywhere it can be seen:
// the setup file's name, the wizard, Settings > Apps, the file's own properties,
// NAVFLIX.exe, and the bar at the foot of the app itself.
//
// What goes in:
//   the app          server.js, probe.js, qr.js, package.json, LICENSE, public\
//   runtime\node\    node.exe, so nothing has to be installed first
//   runtime\vlc\     portable VLC, which NAVFLIX looks for before any other
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
const LOCAL = process.env.LOCALAPPDATA || '';
const INSTALLED = path.join(LOCAL, 'Programs', 'NAVFLIX');      // a NAVFLIX already installed here

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  const next = process.argv[i + 1];
  return i > -1 && next && !next.startsWith('--') ? next : fallback;
}
const flag = (name) => process.argv.indexOf('--' + name) > -1;
const firstThere = (list) => list.find((p) => p && fs.existsSync(p));

// A node.exe to bundle: the one in this folder, else the one inside a NAVFLIX
// that is already installed, else whichever is running this script.
const NODE = arg('node', firstThere([
  path.join(REPO, 'runtime', 'node', 'node.exe'),
  path.join(INSTALLED, 'runtime', 'node', 'node.exe'),
  process.execPath,
]));

// VLC: either the zip from videolan.org or a folder already unpacked, including
// the one inside an installed NAVFLIX.
const VLC = arg('vlc', firstThere([
  path.join(REPO, 'runtime', 'vlc'),
  path.join(INSTALLED, 'runtime', 'vlc'),
]));

// Inno Setup installs either for one user or for everyone; look in both.
const ISCC = arg('iscc', firstThere([
  path.join(LOCAL, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
]));

const OUT = path.resolve(arg('out', path.join(REPO, 'installer', 'dist')));
const WORK = path.resolve(arg('work', path.join(os.tmpdir(), 'navflix-installer-build')));
const STAGE = path.join(WORK, 'stage');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const VERSION = /^\d+\.\d+\.\d+$/.test(pkg.version || '') ? pkg.version : '0.0.0';
const SETUP_NAME = 'NAVFLIX-Setup-' + VERSION;

function need(file, what) {
  if (!file || !fs.existsSync(file)) {
    console.error('Missing ' + what + ': ' + (file || '(not found, and no default worked)'));
    process.exit(1);
  }
}
need(NODE, 'node.exe (--node)');
need(VLC, 'portable VLC, a zip or a folder (--vlc)');
need(CSC, 'the .NET Framework C# compiler');
if (!flag('no-setup')) need(ISCC, "Inno Setup's ISCC.exe (--iscc)");

const step = (s) => console.log('\n== ' + s);
console.log('NAVFLIX ' + VERSION + '  ->  ' + path.join(OUT, SETUP_NAME + '.exe'));

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
console.log('node ' + execFileSync(NODE, ['--version']).toString().trim() + ' from ' + NODE);

step('Portable VLC');
if (fs.statSync(VLC).isDirectory()) {
  need(path.join(VLC, 'vlc.exe'), 'vlc.exe inside ' + VLC);
  fs.cpSync(VLC, path.join(STAGE, 'runtime', 'vlc'), { recursive: true });
  console.log('copied from ' + VLC);
} else {
  const unpacked = path.join(WORK, 'vlc');
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Expand-Archive -LiteralPath $env:NAVFLIX_ZIP -DestinationPath $env:NAVFLIX_DEST -Force'], {
    env: Object.assign({}, process.env, { NAVFLIX_ZIP: VLC, NAVFLIX_DEST: unpacked }),
    stdio: 'inherit',
  });
  const inner = fs.readdirSync(unpacked).find((n) => fs.existsSync(path.join(unpacked, n, 'vlc.exe')));
  if (!inner) { console.error('No vlc.exe inside ' + VLC); process.exit(1); }
  fs.renameSync(path.join(unpacked, inner), path.join(STAGE, 'runtime', 'vlc'));
  console.log('unpacked ' + inner);
}

step('Icon and launcher');
const ICON = path.join(WORK, 'navflix.ico');
console.log('icon: ' + makeIcon(path.join(REPO, 'public'), ICON).join(', '));

// The launcher carries the same version, so Task Manager and the file's
// properties agree with everything else. Generated rather than written by hand:
// one version number, in package.json, and nothing to forget to update.
const parts = VERSION.split('.').concat(['0']).join('.');
const info = path.join(WORK, 'AssemblyInfo.cs');
fs.writeFileSync(info, [
  '// Generated by installer\\build.js from package.json. Do not edit.',
  'using System.Reflection;',
  '[assembly: AssemblyTitle("NAVFLIX")]',
  '[assembly: AssemblyProduct("NAVFLIX")]',
  '[assembly: AssemblyDescription("Opens NAVFLIX, and stops it when its window is closed")]',
  '[assembly: AssemblyVersion("' + parts + '")]',
  '[assembly: AssemblyFileVersion("' + parts + '")]',
  '[assembly: AssemblyInformationalVersion("' + VERSION + '")]',
  '',
].join('\n'));

execFileSync(CSC, ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  '/out:' + path.join(STAGE, 'NAVFLIX.exe'), '/win32icon:' + ICON,
  '/r:System.Management.dll', '/r:System.Windows.Forms.dll',
  path.join(__dirname, 'launcher', 'NAVFLIX.cs'), info], { stdio: 'inherit' });
console.log('launcher compiled, version ' + parts);

if (flag('no-setup')) {
  console.log('\nStaged in ' + STAGE + ' (no setup built)');
  process.exit(0);
}

step('Setup');
fs.mkdirSync(OUT, { recursive: true });
execFileSync(ISCC, ['/Q', '/DStage=' + STAGE, '/DOutDir=' + OUT, '/DIcon=' + ICON,
  '/DAppVersion=' + VERSION, '/DOutputBase=' + SETUP_NAME,
  path.join(__dirname, 'NAVFLIX.iss')], { stdio: 'inherit' });

const setup = path.join(OUT, SETUP_NAME + '.exe');
const staged = fs.readdirSync(STAGE).length;
console.log('\nBuilt ' + setup);
console.log((fs.statSync(setup).size / 1048576).toFixed(1) + ' MB, version ' + VERSION + ', ' + staged + ' items staged');
