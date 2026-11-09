# yt-core-lib

The shared core for my YouTube userscripts. **Not installed on its own** — other scripts pull it in:

```js
// @require https://raw.githubusercontent.com/chirag127/yt-core-lib/main/yt-core-lib.js
```

It exposes one global, `Ytk`.

## Why this exists

I want many small, discoverable repos **and** zero duplicated code. Those only coexist with a
shared core. Without it, every script copies the same ~350 lines of InnerTube plumbing, and the
`HTTP 400` bug had to be fixed in two places at once.

## What is shared

| Area | Why shared |
|---|---|
| Storage (`ytk.` namespace, `GM_setValue`) | ScriptCat's cloud sync replicates it, so settings follow you across browsers |
| Settings object | **One AI key, set once**, used by every script |
| AI client (`aiChat`, `aiJson`) | Same endpoint, same error handling, one place to fix |
| InnerTube (`itPost`, `searchVideos`, `enumeratePlaylist/Channel`, `createPlaylist`, `addVideos`) | Reads both the legacy `playlistVideoRenderer` and the live `lockupViewModel` shape |
| Auth (`authHeaders`, `requireAuth`) | `SAPISIDHASH` built once; fails loudly when signed out |
| Parsing (`parseCount`, `parseDuration`, `parseEpisode`) | One definition of "what is episode 7" |
| Small UI helpers (`h`, `sleep`, `notify`) | No `innerHTML` anywhere (Trusted Types) |

## Historical dead ends this core encodes

These are measured facts, not preferences:

- `browse` **without** `SAPISIDHASH` returns alerts and no content for private lists.
- With auth, the same response carries **`lockupViewModel`, not `playlistVideoRenderer`**. Reading
  only the legacy key returns zero videos and looks like "the feature does nothing".
- `window.ytcfg` is not always present when a script runs. Without a fallback, writes go out as
  `?key=undefined` and fail with an opaque 400.
- InnerTube answers 400 for a bogus video id, a nonexistent playlist, and a playlist owned by
  another account — all with the same "Sorry, something went wrong".

## Versioning

Consumers pin a URL. After changing this file, bump `@version` **and** the `?v=` query in every
consumer's `@require`, or managers keep the cached copy.

## License

MIT. TVMaze attribution lives in the consumers that use it, not here.
