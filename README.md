# nitro-bench

A [Revenge](https://github.com/revenge-mod/revenge) plugin (bunny plugin API).

- **nitro boost spoof** — force `premiumType` so premium-gated UI unlocks, client-side only
- **soundboard unlock** — force-flips the soundboard gate predicates at runtime
- **`/sb <sound|list>`** — list the current server's soundboard sounds and play one through Discord's own playback path (routes to everyone in the voice channel)
- **`/nitro [1|0]`** — toggle the spoof

## Install

1. Install Revenge (Android: Revenge Manager / RevengeXposed, iOS: RevengeTweak).
2. Settings → Plugins → **+** → paste the raw URL to [`nitro-bench.js`](nitro-bench.js).
3. Toggle the plugin on.

## Notes

`UserStore.getCurrentUser` + `premiumType` are stable across builds. The soundboard gate props and the `playSound` module shift per Discord client build — the plugin discovers them at runtime and logs what it found. Run `/sb list`; the console line it leaves is the debug feed for the per-build re-derive.

Client-side spoof only. No account data leaves the device.