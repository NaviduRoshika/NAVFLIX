# NAVFLIX

Turns any folder of movies into a series you watch one timed episode at a time.

Point it at a folder. It plays the files in order, in sittings of a fixed length
(60 minutes by default), and remembers the exact second you stopped — so the next
sitting picks up mid-scene.

There is **no daily quota**. An episode is how long one sitting runs, not a
ration: when it stops, press Play again and you get another one. The point is to
break a two-hour film into pieces you can actually fit in, not to police how many
you watch.

It also knows what is on the shelf: [**Details**](#details) reads the real
resolution, codecs and tracks out of each file, and looks up the cast, director
and rating for every title.

## Collections

You can track several marathons at once — MCU in one folder, DC in another. Add a
folder per marathon and switch between them with the tabs at the top.

**Adding several at once.** Every folder in the picker has a tick box, and
**Tick all n here** takes the lot — pointing at a `Tv Series` folder of sixty
shows is one trip through the dialog, not sixty. Ticks survive walking to another
folder, so shows and films can go in together. Clicking a row still walks into it;
only the box selects. A folder with no video files in it is skipped when it was
part of a batch, and the toast says how many were left out and why — adding one
empty folder deliberately, before copying files into it, still works.

Each collection is completely separate: its own queue, its own position in that
queue, its own watch log, and **its own episode length**. MCU can run in hour-long
sittings while a DC marathon runs in 45 minute ones.

Only one thing plays at a time. If you switch tabs mid-episode, a banner keeps the
running one one click away.

The tab row shows the **three collections you played most recently**, newest
first, plus whatever is open or playing — with a dozen folders added it was a wall of names you never
clicked. Everything else lives in the Library.

**Continue watching** sits above the shelves: at most three cards answering *what
was I doing?* — the film you are part-way through, the episode you are part-way
through, and the next episode of whichever show you watched last, with any spare
slot filled from your most recent folders. The same title never appears twice.
Clicking a card opens that folder with the title on the billboard; like clicking
a poster, it does not start playing.

Detection covers `S01E01`, `s02ep1`, `3x01`, `S1 - 01`, a `Season 2` folder with
`05 - Grilled` inside, and a bare run of `01. Title`, `02. Title` with no season
named anywhere — the way most anime is laid out. A film shelf is numbered
identically (`01 Iron Man (2008)`), so a four-digit year in the name rules the
last case out. Measured over 3,147 files here, widening it moved six folders from
films to series and none the other way; the closest film shelf to the threshold
sits at 3% of its files looking like episodes, against 76% for the least
episode-like show.

The Library files each collection as a **film shelf** or a **TV series** based on
what is in its folder, and offers *Everything / Films / TV series* buttons above
the grid, plus **Watched / Not watched** beside them. The two groups ask
different questions and combine, so *TV series* + *Not watched* is the shows you
have yet to start. *Watched* means a folder with nothing left in it and
everything else counts as not watched, so the pair always adds up to the whole
shelf; each button's count is what you would get by pressing it. Pressing the one
already on turns it off.

A **search box** sits beside them and narrows the grid as you type. All the
counts follow the search, and **Esc** clears it.

Beside that, how the grid is ordered:

| Order | What it gives you |
| --- | --- |
| **A–Z** | Alphabetical, and number-aware, so *12 Monkeys* comes before *13 Reasons Why*. The default. |
| **Recently played** | What you last watched, first. Folders you have never opened fall back to A–Z among themselves. |
| **Most left to watch** | Biggest pile of unwatched first — what a marathon still owes you. |
| **As added** | The order the folders went in, which is what the grid always used to do. |

Unlike the filters, this one is remembered between launches: a filter answers a
question you are asking now, but an order is how you prefer to read the shelf.

Underneath, **Inside your folders** lists every title that matches, wherever it
lives. Searching *iron* finds the Iron Man films across two shelves and
*S08E06 · The Iron Throne* in Game of Thrones — episode names are searched, and
so are filenames, which is often where the year and the original title sit.
Clicking a result opens that folder with the title on the billboard; like
clicking a poster, it does not start playing.

This does not walk the disk on every keystroke: it compares names against the
directory listing already cached for the queue, so a library of nine hundred
files answers in well under a tenth of a second. A folder on an unplugged drive
is skipped, because its file list cannot be read.

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
press **QR** in the top bar — beside Settings, and only there once the remote is
on — and scan what comes up. The code travels with the address, so the phone
pairs the moment the page opens. The same code is in Settings under *Phone
remote*, alongside the rest of the controls.

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
pause, seek, stop, skip, switch collection, change the volume and change
subtitles. Everything else is refused over the network **even when paired**:

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

## Details

The **Details** button in the top bar opens a breakdown of the collection you
have open: what each file actually is, and who made it. Press **Scan** and it is
remembered — or leave it to fill itself in, which it now does on its own.

## Filling itself in

Scanning and fetching artwork were both things you pressed a button for, one
folder at a time. With eighty folders that is eighty presses, which is why most
of a library never got either done. Both now also happen quietly in the
background, a little at a time, in **Settings**:

| Switch | What it does | Default |
| --- | --- | --- |
| **Read file details in the background** | Resolution, codecs, tracks and real running time for files not looked at yet. Your own disk only. | On |
| **Fetch artwork in the background** | The posters and episode stills still missing, and the cast, crew and rating for each title. **Uses the network.** | On |

The second is listed separately, and says so plainly, because it is the one that
goes online. Turn it off and NAVFLIX is back to reaching the network only when
you press **Get artwork**.

**The folder you have open is finished first** — headers, artwork and credits —
before anything else is touched. Without that the folder you are actually looking
at could be twentieth in line, and a folder that is quietly twentieth is
indistinguishable from a feature that does not work.

After that it works across the whole library cheapest-first: every folder’s file
headers, then every folder’s artwork, then every folder’s credits. Reading headers
is local and quick, so a shelf of runtimes and resolutions arrives in about half
an hour; the two network passes take hours and would otherwise hold that up
behind them.

### Coverage

At the foot of the Library, three bars: how much of the library has been **read**,
how much is **illustrated**, and how much is **identified**. Underneath, the folders
still holding something back, worst first — click one to open it. Credits are
counted in the unit each folder actually uses: a show is one lookup for the whole
thing, a film shelf is one per film.

Neither is ever allowed to compete with you:

- **Playback stops it dead.** These are the same platters the film is streaming
  off, and a header read in the middle of one is a stutter. A slice checks before
  every single file, so pressing play interrupts it part-way through.
- **A job you started wins.** Pressing Scan, Get artwork or Find subtitles takes
  the disk and the network; the background waits.
- **Slices are small** — twenty-five file reads or six catalogue requests at a
  time, fifteen seconds apart, at the same pace the buttons use.
- **It goes quiet when there is nothing left**, rather than rebuilding every
  folder's queue every fifteen seconds forever. Adding a folder, pointing one at
  a new drive, or changing either switch wakes it again.

Expect roughly **1,400 images an hour** with artwork left on. A large library
that has never been fetched is therefore a couple of hours of trickle, not a
single long stall — and you can watch something while it happens.

A file whose header cannot be read is recorded as attempted, so unattended
scanning does not return to the same broken file forever.

### Read from the file, not from its name

A release called `1080p` quite often is not. NAVFLIX opens the container header
and reads the real picture size, the video and audio codecs, every subtitle
track and the true runtime. No ffmpeg, no ffprobe, no npm — Matroska writes its
stream table as nested EBML elements and MP4 writes it as nested atoms, and
`probe.js` walks both.

Two things fall out of doing it this way:

* **The label is honest.** *1080p* here means the frame really is that size.
  Resolution is bucketed on whichever of width or height is larger at 16:9, so a
  film letterboxed to 1920x800 is 1080p and 4:3 animation at 960x720 is 720p —
  going by either dimension alone gets one of those two wrong.
* **The extension is not trusted.** Files are identified by their first bytes.
  An MP4 named `.mkv` is read correctly and labelled *really MP4*.

Matroska (`.mkv`, `.webm`) and MP4 (`.mp4`, `.m4v`, `.mov`) cover nearly
everything. Anything else falls back to what the filename claims and is marked
**not read**, so a guess never looks like a measurement.

Reading the headers takes roughly a minute for eight hundred files on an
external drive, and is entirely local.

### Cast and crew

The same scan looks each title up on the free Cinemeta catalogue and keeps the
director, writer, cast, genres, IMDb rating, awards and plot. A show is one
lookup for the whole folder. A film shelf is one per film, which is about a
minute for a hundred films. This half is the part that goes online.

Cinemeta returns the top three billed actors per title, not a full cast list.

### Counting the shelf

The boxes across the top tally the whole folder — how much of it is 4K, how much
is H.265, which directors and actors come up most often. Click any line to
filter the list below it; click it again to clear. The search box matches
titles, filenames, actors, directors and genres at once, so *dicaprio* finds his
films wherever they sit in the folder.

### A side effect worth knowing

Runtime used to appear only after VLC had played a title once. The container
knows it already, so a scan fills it in for everything — which brings the part
strip and the "1h 45m" labels along with it, before you have played anything.

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
It sends each film's title and year to a public film catalogue, downloads the
poster and backdrop once, and caches both in `data/art/` — after that you are
fully offline again. The button shows live progress and can be stopped mid-run.

The same work also happens on its own, a little at a time — see
[Filling itself in](#filling-itself-in). Those two, and nothing else, are when
NAVFLIX goes near the network; turning the background switch off puts it back to
only ever going online when you press the button.

Budget roughly **25 KB per poster and 500–650 KB per backdrop**, so a 23-film
marathon costs about 15 MB on disk.

A film the catalogue can't identify is marked as attempted, so the button doesn't
nag you about it forever. Use **Get artwork** again after adding new films.

What counts as *missing* depends on the collection, and matches what the fetch
actually downloads:

- A **film** is missing artwork until it has a poster and a backdrop of its own.
- An **episode** shares the show's poster by design, so the only thing it needs
  of its own is its still.

That distinction matters because the show's images stand in for anything an
episode lacks. Add season 5 to a show whose artwork you fetched at season 2 and
every new episode already resolves to a picture — the show poster and the show
backdrop. Counting those as done made the new season look complete and the
**Get artwork** button never appeared. The count now ignores the stand-ins.

By default it uses **Cinemeta** (`v3-cinemeta.strem.io`), Stremio's public
IMDb-backed catalogue: no key, no signup, no rate-limit registration.

### Remakes

A remake keeps the original title, so a search returns both under the same name
and the title alone cannot separate them. Put the year in the folder name and it
can:

```
Avatar The Last Airbender - [2005]     -> the animated series
Avatar The Last Airbender - [2024]     -> the live action one
```

Square brackets, round brackets or a trailing `- 2005` all work, and the year is
used only for matching — it never becomes part of the search.

If a collection has already settled on the wrong title, **Manage → Re-identify**
searches again and replaces every image. Progress is keyed on filenames, so it
is untouched.

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
declares itself English but there is exactly one untagged track, it offers that
and labels it as a guess.

That guess used to be limited to *text* tracks, on the reasoning that text is
nicer to look at. It is — but that is a reason to prefer text, not to refuse to
guess when the only candidate is a picture, and a picture is exactly what a
Blu-ray rip carries. A release whose only English subtitle was an untagged PGS
track, sitting beside tagged Indonesian and Malay ones, played with no subtitle
at all. Checked across 981 files: four films gained a subtitle and no film's
existing choice changed.

When the gap *grows* as the film runs, that is a frame-rate mismatch rather than
an offset. The **Re-time** button says what is set — *off*, *25 → 23.976* — and
opens the list of states the file can be in, ticked against the current one.
Nearly every rip is 23.976fps, so the first is almost always right; the two 24fps
choices differ by a tenth of a percent, which looks fine for ten minutes and is
eight seconds out by the end of a two-hour film.

Picking a line **replaces** the setting rather than compounding with it. Each one
is computed from an untouched copy of the download kept beside it, so choosing
*as it downloaded* restores the file byte for byte no matter how many you tried
first. The **i** button beside it is the explanation on its own, for when that is
all you wanted.

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
- **✓ Mark as watched** records a title as done and moves the queue on, on the
  billboard and on every card. Pressing it on something already watched puts it
  back. **Restart** rewinds one to zero.
- **✓ Watch season** sits in each season's heading and ticks off the lot — for a
  show you have already seen and only want NAVFLIX to track from here on. Once a
  season is complete the button becomes **↻ Unwatch season**, which puts every
  episode back to not started and clears any resume points inside it. Both ask
  first, and neither touches another season.
- **Play** on any row jumps the queue without losing anyone's position.
- When a sitting ends the button reads *Next 40m* (or whatever you set). Press it
  as many times as you like — nothing stops you at a daily total.

## Why the first load is quick

Drawing the Library means knowing what is in every folder, and it would be easy
to make that cost a fortune on an external drive. Two things keep it cheap.

**One directory listing per folder, not one check per file.** Resolving artwork
by asking the filesystem whether each of six extensions exists, for each of nine
generic names, twice, once cost 68,594 calls and forty seconds. The listing is
read once and answered from memory.

**Subtitle tracks are only read for the folder you have open.** Listing them
means opening the video and reading a megabyte of it — nine, when the track table
sits past the first megabyte. That used to happen for every collection on every
refresh, because the Library grid and the tab counts are built from queues too.
On a 23-folder library that was **1,085 MB read to draw a list of folder names**,
of which 1,084 MB was for folders that were not even on screen: about two minutes
on a USB hard drive. Only the collection actually on screen pays now, and the
answer is written to `state.json`, so it is worked out once per file ever rather
than once per launch.

| first `/api/state`, 23 folders / 1,048 files | before | after |
| --- | --- | --- |
| files opened | 981 | 0 |
| read from disk | 1,085 MB | 0 MB |
| opening a 282-episode show | 279 MB | 0 MB |

## Why it stays quick with eighty folders

Every poll rebuilds a card for each collection, and a card needs to know what the
folder holds. Three answers are worked out once and reused rather than per file,
because per file is how they get asked for:

| Cached | Why it matters |
| --- | --- |
| The directory listing | One walk per folder every 8 seconds instead of one per request |
| **Is this folder a show?** | Deciding it means running the episode test over every filename. The poster lookup, the backdrop lookup and the artwork count each ask per file, so a 356-episode folder was running a 356-file test 356 times — 126,000 regex passes for one card |
| An artwork file’s timestamp | It goes in the image address so the browser notices a new picture. Read per file, that is 6,000 stats a request; most resolve to the same few hundred paths, since a whole show shares one poster |

Measured on a library of 81 folders and 3,092 files, building all the cards went
from **4,755 ms to 142 ms**, and a request from about 930 ms to 95 ms. The shape
cache alone accounted for three seconds of it. All three expire with the
directory listing, so a file you add is still noticed within seconds.

## Where state lives

`data/state.json` — the VLC path, whether to open a window on startup, and for
every collection its progress per file and its watch log. It also remembers the
subtitle tracks found inside each video, so that is worked out once rather than
on every launch, and — once you have run a Details scan — what was read out of
each file and the cast and crew for each title. Together those add roughly two
megabytes for a library of a thousand files.
Settings → **Erase this collection's progress** resets one without touching the
others.

### It is looked after for you

This one file is the only thing here that cannot be rebuilt. The videos are on
the drive, the artwork can be fetched again — but every position, every mark and
every subtitle offset you tuned by hand lives here, and it is rewritten
constantly, on a drive that gets unplugged. Two things guard it.

**Every save is atomic.** The new state is written to `state.json.tmp`, flushed
to the disk itself rather than left in its write cache, and only then renamed
over the real file. Rename is atomic on NTFS and ext4 alike, so the old file
stays whole and readable right up to the instant the new one is complete. Pull
the drive mid-save and you lose that save, not the file.

**A copy is kept once a day.** The first save of each day copies the *existing*
`state.json` to `data/backups/state-YYYY-MM-DD.json` before overwriting it — the
copy is of a file that has already proved it parses, never of the state about to
be written. Ten days are kept and older ones are removed. That covers the
accident a rename cannot: a save that succeeds but stores something wrong.

To go back, close NAVFLIX and rename one of them over `data/state.json`. They
are left as plain uncompressed JSON precisely so that recovery is nothing more
than renaming a file. Ten days of a large library costs around twenty megabytes.

A backup is never allowed to fail a save — if the folder is read-only or the
disk is full, the save still goes through and no backup is taken that day.

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
| `probe.js` | Reads resolution, codecs and tracks out of MKV and MP4 headers; no dependencies |
| `package.json` | Lets you run `npm start`; no dependencies |
| `data/state.json` | Your progress (created on first run) |
| `data/backups/` | Daily copies of it, ten days deep |

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
