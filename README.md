# NAVFLIX

Turns any folder of movies into a series you watch one timed episode at a time.

Point it at a folder. It plays the files in order, in sittings of a fixed length
(60 minutes by default), and remembers the exact second you stopped — so the next
sitting picks up mid-scene.

There is **no daily quota**. An episode is how long one sitting runs, not a
ration: when it stops, press Play again and you get another one. The point is to
break a two-hour film into pieces you can actually fit in, not to police how many
you watch.

## Collections

You can track several marathons at once — MCU in one folder, DC in another. Add a
folder per marathon and switch between them with the tabs at the top.

Each collection is completely separate: its own queue, its own position in that
queue, its own watch log, and **its own episode length**. MCU can run in hour-long
sittings while a DC marathon runs in 45 minute ones.

Only one thing plays at a time. If you switch tabs mid-episode, a banner keeps the
running one one click away.

The tab row shows the **three collections you played most recently**, plus whatever
is open or playing — with a dozen folders added it was a wall of names you never
clicked. The rest sit behind **+n more**, which opens the Library.

The Library files each collection as a **film shelf** or a **TV series** based on
what is in its folder, and offers *Everything / Films / TV series* buttons above
the grid.

This keeps working with the folder offline. Every filename the app has scanned is
recorded in `data/state.json`, and re-running the episode test over those names
separates the two cleanly — on a real library, 99-100% of a show's filenames read
as episodes against 0% of a film folder's. So a series on an unplugged external
drive is still filed as a series, with its season count intact.

Under **Manage** you can rename a collection, repoint it at a moved folder
(progress is keyed on filenames, so it survives the move), or remove it — removing
forgets its progress and never touches your video files.

## The phone remote

A small page at `/remote`, built for a phone on the same network: what is
playing, play, pause, seek 30 seconds either way, stop, and skip. VLC still
plays on the PC — the phone is only the handset.

**Browse** opens your collections, and tapping one lists its films or episodes,
grouped by season for a show. Tapping a title *selects* it and drops you back on
the handset screen — the big red button is still what starts playback, so you
cannot launch a film with a stray thumb. Picking a collection switches the PC to
it as well, so the two never disagree.

It is **off by default**, because switching it on changes who the server will
talk to. While it is off, NAVFLIX binds `127.0.0.1` and only this machine can
reach it. Turn it on under Settings → **Phone remote** and restart; it then
binds `0.0.0.0` and prints an address and a six digit pairing code:

```
   Phone remote is ON. On a device on the same network, open:
     http://192.168.1.24:8787/remote
   Pairing code: 610337
```

Open that on the phone, type the code once, and it stays paired. Easier still,
scan the **QR code** shown in Settings: it carries the address and the pairing
code together, so the phone pairs the moment the page opens.

The code rides in the URL fragment (`/remote#123456`), which browsers never send
to a server — so it stays out of request logs on the way. The remote page pairs
with it, then strips it from the address bar so it is not left sitting in the
phone's history.

The QR itself is only ever served to the machine running NAVFLIX. A phone that
is already paired gets `403` for it, since it contains the credential and a
device holding that credential has no use for a picture of it.

Settings → **Phone remote** shows the same address and code side by side with a
**Copy address** button. The address is recomputed each time you open Settings,
because it is this PC on your network — it changes when the machine moves
between home Wi-Fi, a phone hotspot, or the office. The pairing code does not
change with it, and a paired phone stays paired.

### What the phone is allowed to do

Deliberately less than the desktop. A paired phone may read the state, play,
pause, seek, stop, skip, switch collection and change subtitles. Everything
else is refused over the network **even when paired**:

| Refused remotely | Why |
| --- | --- |
| `/api/settings` | It sets the VLC path, which is later handed to `spawn()`. Remotely settable, that is arbitrary code execution. |
| `/api/browse` | Lists any directory on the machine. |
| `/api/collections/*` (except select) | Adds, removes and repoints folders. |
| `/api/reset-all`, `/api/reset-day` | Destroys progress. |
| `/api/art/fetch` | Makes the PC issue outbound requests. |

Other protections: the pairing code and the LAN addresses are only ever sent to
the machine itself, never to a paired phone; tokens are compared in constant
time; and five wrong codes locks pairing from that address for five minutes.

**Unpair this phone** on the handset revokes the token on the server, not just
on the phone. **New pairing code** in Settings drops every paired device at
once — use that if a phone goes missing. Turning the remote off also clears
them all.

This is a home network feature, not an internet one. There is no TLS, so do not
port-forward it.

### If it will not start after turning the remote on

Switching the remote on widens the bind from `127.0.0.1` to `0.0.0.0`, so the
port now has to be free on **every** interface rather than just this machine.
Something already holding it there — a debugger agent, a dev server — was
invisible while NAVFLIX was loopback-only and suddenly is not. NAVFLIX says so
and exits rather than dumping a stack trace. Free the port, or pick another:

```sh
set PORT=8788 && node server.js        # Windows
PORT=8788 node server.js               # macOS, Linux
```

## Installing it as an app

While NAVFLIX is open in Chrome or Edge, the address bar shows an install icon.
Installing gives it a Start menu entry, a taskbar icon, and **its own window with
no address bar and no browser buttons** — which is the tidiest way to run it.

This is a deliberately partial PWA: a manifest and icons, and **no service
worker**. Offline caching would be worse than useless here. The page is a control
panel for the local server, so a cached copy with the server down would look alive
while every button failed, and a stale cache of `index.html` would hide updates to
the app itself.

So the installed app still needs the server running. Start it the usual way
(`NAVFLIX.bat`, `start.sh`, or `npm start`), then use the icon.

Once you are launching from the icon, the browser window the server opens by
itself is redundant. Turn off **Open a window when NAVFLIX starts** in Settings
and it will not. The console still prints the address either way.

You can get the same chrome-less window without installing anything:

```sh
chrome --app=http://localhost:8787
```

Installing is only offered over `http://localhost`, which browsers treat as a
secure context. Reaching the server by LAN address would not qualify.

## Moving around

It is one page, but the browser **Back** button works the way you would expect:
it steps back through the collections, the Library and the Guide you have been
through, and closes an open dialog rather than navigating.

When it runs out of places to go it **settles on the Library** rather than
leaving the page. Back walking out of a dashboard you keep open all evening
reads as the app quitting, so there is a permanent floor entry underneath the
session that Back can never step off. Close the tab to actually leave.

## Artwork

Posters and the billboard backdrop come from images already sitting next to your
video files — nothing is downloaded, and no internet is needed.

For a film at `Iron Man (2008).mkv`, it looks for:

1. **`Iron Man (2008).jpg`** (or `.jpeg` `.png` `.webp` `.avif` `.gif`) — an image
   named after the file. This always wins.
2. **`poster.jpg`**, `folder.jpg`, `cover.jpg`, `fanart.jpg`, `backdrop.jpg`,
   `thumb.jpg`, `banner.jpg`, `movie.jpg`, `default.jpg` — but **only when the film
   sits in its own subfolder**. In a flat folder holding twenty films, one stray
   `poster.jpg` would otherwise become the artwork for all twenty.
3. Artwork you fetched with **Get artwork** (see below), cached under `data/art/`.
4. Nothing found — a generated poster, its colour derived from the title, so the
   shelf still looks deliberate rather than broken.

Files you supply always beat anything downloaded, so dropping your own `poster.jpg`
in overrides a fetched one.

### Episodes

A show has exactly one poster, so a season of episodes all looked the same.
Episodes instead use the still from that episode, which the catalogue supplies
per episode and NAVFLIX already caches alongside everything else.

Those stills are 16:9 rather than the 2:3 of a poster, so shows get wider cards.
Cropping a widescreen frame into a tall slot throws away most of the picture,
which is the whole point of using it. Film collections keep tall posters.

### Two kinds of artwork

- **Poster** — portrait, 2:3, used on the rail cards.
- **Backdrop** — landscape, 1920×1080, used behind the billboard.

They are not interchangeable. A poster stretched across the billboard crops to
somebody's chin. When a film has a poster but no backdrop, the billboard blurs and
scales the poster into a soft wash instead of showing that bad crop.

Local backdrops are read from `<film>-fanart.jpg` / `-backdrop.jpg`, or from
`fanart.jpg` / `backdrop.jpg` when the film has its own subfolder.

### Get artwork

The billboard has a **Get artwork (n)** button whenever films are missing images.
Pressing it is the *only* time NAVFLIX touches the network. It sends each film's
title and year to a public film catalogue, downloads the poster and backdrop once,
and caches both in `data/art/` — after that you are fully offline again. The button
shows live progress and can be stopped mid-run.

Budget roughly **25 KB per poster and 500–650 KB per backdrop**, so a 23-film
marathon costs about 15 MB on disk.

A film the catalogue can't identify is marked as attempted, so the button doesn't
nag you about it forever. Use **Get artwork** again after adding new films.

By default it uses **Cinemeta** (`v3-cinemeta.strem.io`), Stremio's public
IMDb-backed catalogue: no key, no signup, no rate-limit registration.

A search always returns *something*, so a match is only accepted when the title
matches exactly, or the year matches and the title is a clear prefix. A film it
can't confidently identify keeps its generated poster rather than being given a
stranger's artwork.

**Optional:** paste a free [TMDB](https://www.themoviedb.org/settings/api) API key
into Settings and it uses TMDB instead, which has better coverage for obscure and
non-English films.

Note: the **iTunes Search API is not usable for this** — it still answers for music
and apps, but `media=movie` returns zero results in every country. Don't waste time
on it.

## Subtitles

An `.mkv` carries its subtitles as separate tracks inside the container, already
on your disk. VLC shows none of them unless told which, so NAVFLIX reads the track
table out of the file header and picks one for you.

Picking well is not trivial. Alongside the plain English track sit **Forced**
(only translates foreign dialogue, so it stays blank through an English film),
**SDH** (adds `[explosion]` cues), and **Commentary** (matches the director's
audio, not the film). Worse, many releases leave the language code as `und` and
put "English" in the track *name* instead — so selecting by language alone misses
them entirely.

The picker scores every track: English by language code *or* by name, with Forced,
SDH, Signs and Commentary pushed down, and text preferred over bitmap. If nothing
declares itself English but there is exactly one untagged text track, it offers
that and labels it as a guess.

A **Subtitles** dropdown sits under the billboard buttons: `Auto`, `Off`, or any
track by name. The choice is remembered per film in `data/state.json`.

Two flavours exist and they behave differently:

- **Text** (`S_TEXT/UTF8`) — ordinary SRT. Crisp, scales, can be restyled.
- **Bitmap** (`S_HDMV/PGS`) — Blu-ray *images*, marked `[image]` in the dropdown.
  They display fine but cannot be resized or recoloured.

Only Matroska is parsed. A `.mp4` reports no tracks — but dropping a matching
`.srt` beside any video still works, because VLC loads those by itself.


## Running it

However you start it, a console window opens and your browser lands on the
dashboard at <http://localhost:8787>. Keep that console window open while you
watch — it *is* the app. Closing it shuts everything down.

### Windows

Double-click **`NAVFLIX.bat`**.

For a Desktop icon: right-click it → **Show more options** → **Send to** →
**Desktop (create shortcut)**.

### Linux

```sh
chmod +x start.sh        # first time only
./start.sh
```

To add it to your application menu: `bash install-linux-shortcut.sh`.
That writes `~/.local/share/applications/navflix.desktop`; delete that
file to undo it.

### macOS

```sh
chmod +x start.sh "NAVFLIX.command"    # first time only
./start.sh
```

After the `chmod`, you can just double-click **`NAVFLIX.command`** in
Finder and it opens in Terminal. Gatekeeper may block the first double-click on a
downloaded file — right-click it → **Open** → **Open** clears that permanently.

Or on any platform: `npm start`.

## Requirements

- **Node.js 18+** — runs the app itself.
- **VLC** — does the actual playing.

No npm packages, nothing to build.

VLC is auto-detected in the usual places for your OS:

| OS | Looked for |
| --- | --- |
| Windows | `C:\Program Files\VideoLAN\VLC\vlc.exe`, the x86 path, Scoop |
| macOS | `/Applications/VLC.app/Contents/MacOS/VLC`, `~/Applications/...`, Homebrew |
| Linux | `/usr/bin/vlc`, `/usr/local/bin/vlc`, Snap, Flatpak, then `vlc` on `PATH` |

If yours lives somewhere else, set the path under **Settings** — on macOS point it
at the binary *inside* the bundle (`VLC.app/Contents/MacOS/VLC`), not at
`VLC.app` itself.

Installing VLC:

```sh
sudo apt install vlc          # Debian / Ubuntu
sudo dnf install vlc          # Fedora
sudo pacman -S vlc            # Arch
brew install --cask vlc       # macOS
```

## How it works

Playback is VLC, launched with `--start-time` and `--stop-time` so it opens at
your saved position and stops itself when the sitting is up. While it plays, the app
talks to VLC's local HTTP interface every two seconds to read the true playhead —
so seeking, pausing, or quitting VLC early all get recorded accurately.

Only time VLC spends actually *playing* counts towards the sitting. Pausing to
make tea is free.

A film is marked finished when the playhead reaches within 30 seconds of the end.
Runtimes show as unknown until the first time a file is played — VLC is what
reports them.

## Things worth knowing

- **Order** is natural-sorted by filename. Zero-pad your numbers (`01`, `02`, …
  `10`) and the order is exactly what you'd expect. Rename files to reorder.
- Subfolders are scanned up to 4 levels deep.
- Files under 20 MB are skipped, so `sample.mkv` and featurettes don't join the queue.
- On the billboard, **Skip** drops a film from the run. On a card the same
  action is spelled **✓ Mark as watched**, since that is what it does.
  **Restart** rewinds one to zero.
- **Play** on any row jumps the queue without losing anyone's position.
- When a sitting ends the button reads *Next 40m* (or whatever you set). Press it
  as many times as you like — nothing stops you at a daily total.

## Where state lives

`data/state.json` — the VLC path, whether to open a window on startup, and for
every collection its progress per file and its watch log. Back it up and your marathons survive a reinstall.
Settings → **Erase this collection's progress** resets one without touching the
others.

A state file written by the single-folder version is upgraded automatically on
first start: the old library becomes your first collection, keeping its episode
length, positions, and history. Nothing is lost and no action is needed.

## Files

| File | Purpose |
| --- | --- |
| `NAVFLIX.bat` | Launcher — Windows |
| `start.sh` | Launcher — Linux and macOS |
| `NAVFLIX.command` | Double-clickable Finder launcher — macOS |
| `install-linux-shortcut.sh` | Adds an application-menu entry — Linux |
| `server.js` | Local server, library scanning, VLC control, progress tracking |
| `public/index.html` | The dashboard |
| `public/remote.html` | The phone remote |
| `public/manifest.webmanifest` | Makes it installable as an app window |
| `public/icon-*.png` | App and tab icons |
| `check.js` | `npm run check` — syntax-checks the pages before you start |
| `qr.js` | QR encoder for the pairing code; no dependencies |
| `package.json` | Lets you run `npm start`; no dependencies |
| `data/state.json` | Your progress (created on first run) |

## Running it from a portable drive

NAVFLIX is built to live on an external disk and be used from more than one
machine — a Windows laptop and a Linux one, say. Three things would normally
break on that trip, and all three are handled.

**Drive letters.** The same disk is `E:\` on one machine and
`/media/you/Films` on another, so any collection sitting on the same volume as
the app is stored *relative to the app folder* and resolved on load. Put the app
at `E:\NAVFLIX` and your films at `E:\Films` and the state records `../Films`,
which is correct everywhere.

Folders more than two levels away are kept absolute on purpose. Something five
levels up merely shares a drive letter today; making it relative would quietly
repoint it at the wrong disk the moment the app moved on its own.

**Path separators.** Windows writes `Season 1\ep01.mkv`, Linux writes
`Season 1/ep01.mkv`. Progress is keyed on those strings, so a mismatch would make
a fully watched show look untouched. Everything is stored with `/`, which Windows
accepts too.

**VLC.** Remembered per platform, so the two laptops stop overwriting each
other's path every time the disk moves.

### Making the move

1. **Run it once where it is now.** On first start it converts the state file to
   the portable format and writes a one-off backup beside it
   (`data/state.json.before-portable-*.bak`). Cached artwork is renamed to match
   the new keys rather than being orphaned, so nothing needs re-fetching.
2. **Copy the whole folder** to the drive.
3. **Move your media onto the same drive** if you want true portability, then
   repoint each collection once under **Manage → Folder**. From then on it
   follows the disk.
4. **On Linux:** `chmod +x start.sh` the first time.

Media left on an internal drive keeps an absolute path, which is right: it is not
coming with you.

### Carrying the runtimes too

NAVFLIX will use a Node and a VLC found inside its own folder in preference to
anything installed on the machine, so the drive can run on a PC with neither:

```
NAVFLIX/
  runtime/
    node/node.exe          Windows: used by NAVFLIX.bat
    node-linux/bin/node    Linux:   copy to runtime/node/bin/node on that machine
    vlc/vlc.exe            Windows: used in preference to an installed VLC
```

Roughly 300 MB extracted. Get them from the official upstreams:

- Node — <https://nodejs.org/dist/> (`node-vXX-win-x64.zip`, `node-vXX-linux-x64.tar.xz`)
- VLC — <https://get.videolan.org/vlc/> (`win64/vlc-X.Y.Z-win64.zip`)

**Linux VLC cannot be bundled.** VideoLAN publish builds for Windows, macOS and
OS/2 only; on Linux VLC is compiled against your distribution's own libraries and
comes from the package manager. So on the Linux laptop you still need:

```sh
sudo apt install vlc          # or dnf / pacman
```

Node *is* bundleable on both. The upshot: the Windows machine needs nothing
installed at all, and the Linux machine needs only VLC.

If the shell scripts refuse to run on Linux with `bad interpreter: ... ^M`, a
Windows tool mangled the line endings — fix with `sed -i 's/\r$//' start.sh`.
