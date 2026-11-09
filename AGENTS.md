# AGENTS.md — yt-core-lib

This repo is a **library**, not a script. It is never installed on its own; consumers pull it in:

```js
// @require https://raw.githubusercontent.com/chirag127/yt-core-lib/main/yt-core-lib-1.3.0.js
```

## Why it exists

The collection deliberately has many small repos, one per job. That only works without
duplication if everything shared lives in exactly one place. This is that place. When two scripts
need the same function, the function moves here — it is never copied.

## The versioned-filename rule (learned the hard way)

**ScriptCat caches `@require` by URL and ignores a `?v=` query.** A consumer asking for
`...js?v=1.2.0` received core **1.1.1**, called a function that did not exist, and died *before*
attaching its listener — no page error, the feature simply did nothing.

So every core release ships as a **new filename**:

```
yt-core-lib.js            ← always the latest (for humans and for reading)
yt-core-lib-1.2.0.js      ← frozen snapshot
yt-core-lib-1.3.0.js      ← current snapshot that consumers require
```

Releasing a change means: bump `@version`, write the versioned copy, repoint every consumer at the
new filename. Bumping only the query string does nothing.

## What belongs here

| Area | Notes |
|---|---|
| Storage | `storeGet/storeSet/storeDel` on the `ytk.` namespace via `GM_setValue` — ScriptCat's cloud sync replicates it |
| Settings | `settings()`, `saveSettings()`, `featureOn()` |
| AI | one key for the whole collection; `aiChat` never throws, always resolves `{ok, text or error}` |
| InnerTube | `itPost` surfaces the response body, `enumeratePlaylist` reads **both** row shapes |
| Writes | `createPlaylist`, `addVideos`, `removeVideos`, all behind `requireAuth` |
| The settings popup | `openSettings()` — the one UI every script's `Settings…` entry opens |
| Shared chrome | `mountToolbar`, `panel`, `kv`, `note`, `toast`, `h` |

Nothing feature-specific belongs here. If only one script uses it, it lives in that script.

## Measured facts encoded here (do not "simplify" these away)

1. **`browse` without `SAPISIDHASH` returns alerts and no content** for private lists like LL/WL.
2. **With auth the same response carries `lockupViewModel`, not `playlistVideoRenderer`.** Reading
   only the legacy key yields zero videos and looks like the feature is broken.
3. **`window.ytcfg` is not always present** when a script runs; without a fallback, writes go out as
   `?key=undefined` and fail with an opaque 400.
4. **InnerTube answers 400 for three different mistakes** — bogus video id, nonexistent playlist,
   playlist owned by another account — all saying "Sorry, something went wrong".
5. **Each userscript runs in its own sandbox.** Module-level state is *not* shared between scripts,
   so `mountToolbar` must reuse `document.querySelector('.ytk2-bar')` rather than a variable.
   Without that, four scripts drew four stacked toolbars.

## Testing

There is no test suite for the core; it is exercised by every consumer. When changing it, verify at
least one consumer live: reload a YouTube page and confirm its bootstrap marker reports the new
`core` version.

## License

MIT
