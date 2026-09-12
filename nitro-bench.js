// language: javascript, file: nitro-bench.js, runtime: Revenge (bunny global plugin API)
// nitro spoof + soundboard unlock + /sb command. live-target keys re-derived per client build.
(function () {
  const LOG = (...a) => console.log("[nitro-bench]", ...a);
  const WARN = (...a) => console.warn("[nitro-bench]", ...a);

  const state = { spoof: true, unlocked: [] };

  // option types — numeric literals per bunny ApplicationCommandOptionType (STRING=3, INTEGER=4)
  const OPT_STRING = 3;

  // ---- live module discovery (per-build derivation table at bottom) -------------
  const find = {};
  function resolve() {
    const M = (globalThis.bunny && bunny.metro) || {};
    find.byProps = M.findByProps || ((...p) => null);
    find.byName = M.findByName || (() => null);
    find.byStore = M.findByStoreName || (() => null);
    find.common = M.common || {};
  }

  // ---- layer 1: booster spoof (stable, low-risk) ---------------------------------
  function patchPremium() {
    const UserStore = find.byStore("UserStore");
    if (!UserStore || typeof UserStore.getCurrentUser !== "function") {
      WARN("UserStore.resolve=false");
      return () => {};
    }
    const unpatch = bunny.api.patcher.after(
      "getCurrentUser", UserStore,
      (_args, user) => {
        if (!user) return user;
        if (state.spoof) Object.assign(user, { premiumType: 2, premium: true });
        return user; // keep same ref — preserves store emitter identity checks
      }
    );
    LOG("UserStore.patched");
    return unpatch;
  }

  // ---- layer 2: soundboard gate unlock (live keys, fail-soft) --------------------
  const GATE_MODULES = [
    ["canPlaySound"], ["useCanPlaySound"], ["canUseSoundboard"],
    ["isSoundboardBlocked"], ["isSoundboardPotentiallyUnavailable"],
    ["isSoundboardModeDenied"], ["getSoundboardTier"]
  ];
  function collectGates() {
    const out = [];
    for (const props of GATE_MODULES) {
      try {
        const mod = find.byProps(...props);
        if (!mod) continue;
        for (const key of props) {
          if (typeof mod[key] === "function" && /^(use)?can|isSound|isPremium|getSound.*Tier/.test(key)) {
            out.push([mod, key]);
          }
        }
      } catch { /* next */ }
    }
    return out;
  }
  function patchGates() {
    const gates = collectGates();
    const ups = gates.map(([mod, key]) => {
      return bunny.api.patcher.instead(key, mod, () => true);
    });
    state.unlocked = gates.map(([, key]) => key);
    return () => ups.forEach(u => { try { u(); } catch { /* torn down */ } });
  }

  // ---- layer 3: drive the soundboard playback path -------------------------------
  function findPlay() {
    const cands = [
      () => find.byProps("playSound", "stopSound"),
      () => find.byProps("playSound"),
      () => find.byName("playSound"),
    ];
    for (const c of cands) { try { const m = c(); if (m && typeof m.playSound === "function") return m; } catch { /* next */ } }
    return null;
  }
  function playSound(soundLike, channelId, guildId) {
    const mod = findPlay();
    if (!mod) return "no playSound module found";
    try {
      mod.playSound(soundLike, { channelId, guildId, location: "SOUNDBOARD" });
      return "played " + (soundLike.name || soundLike.id || soundLike);
    } catch (e) { return "play failed: " + (e && e.message); }
  }

  async function listSounds(ctx) {
    const channelId = find.common.channels && find.common.channels.getVoiceChannelId();
    if (!channelId) return [{ content: "you're not in a voice channel" }];
    const chan = find.byStore("ChannelStore") && find.byStore("ChannelStore").getChannel(channelId);
    const guildId = chan && chan.guild_id;
    if (!guildId) return [{ content: "not in a guild voice channel" }];

    const actions = find.byProps("fetchSoundboardSounds") || (find.common && find.common.soundboardActions);
    if (actions && typeof actions.fetchSoundboardSounds === "function") {
      try { await actions.fetchSoundboardSounds({ channelId, guildId }); } catch (e) { WARN("fetch", e); }
    }
    const sbStore = find.byStore("SoundboardStore");
    const getSounds = sbStore && (sbStore.getSounds || sbStore.getSoundboardSounds);
    const map = getSounds ? (getSounds.call(sbStore, guildId, channelId) || {}) : {};
    const sounds = map && typeof map.toArray === "function" ? map.toArray() : Object.values(map);
    return sounds; // [{ id, name, ... }]
  }

  // ---- commands ------------------------------------------------------------------
  let unreg = [];
  function registerCommands() {
    const reg = bunny.api.commands.registerCommand;
    if (!reg) return;

    unreg.push(reg({
      name: "sb",
      description: "list or play a soundboard sound",
      options: [{
        name: "sound", description: "sound name or id, or \"list\"", required: false, type: OPT_STRING
      }],
      execute: async (args, ctx) => {
        const want = (args.find(a => a.name === "sound") || {}).value || "list";
        if (want === "list") {
          try {
            const sounds = await listSounds(ctx);
            if (!sounds.length) return { content: "no soundboard sounds in this server" };
            return { content: sounds.map(s => s.name || s.id).slice(0, 40).join(", ") };
          } catch (e) { return { content: "list failed: " + (e && e.message) }; }
        }
        const sounds = (await listSounds(ctx).catch(() => []));
        const hit = sounds.find(s => s.name === want || s.id === want) ||
                    sounds.find(s => (s.name || "").toLowerCase().includes((want || "").toLowerCase()));
        if (!hit) return { content: "no sound named " + want };
        return { content: playSound(hit, ctx.channel ? ctx.channel.id : hit.channel_id, ctx.guild && ctx.guild.id) };
      }
    }));

    unreg.push(reg({
      name: "nitro",
      description: "toggle nitro spoof on/off",
      options: [{
        name: "on", description: "1 or 0", required: false, type: OPT_STRING
      }],
      execute: (args, _ctx) => {
        const v = (args.find(a => a.name === "on") || {}).value;
        if (v === "0" || v === "off") state.spoof = false;
        else state.spoof = true;
        return { content: "nitro spoof " + (state.spoof ? "ON" : "off") + " (client-side only)" };
      }
    }));
  }

  // ---- lifecycle -----------------------------------------------------------------
  definePlugin({
    name: "nitro-bench",
    description: "nitro booster spoof, soundboard unlock, and /sb soundboard playback command.",
    authors: [{ name: "VANTA", id: "0" }],
    start() {
      resolve();
      const ups = [patchPremium(), patchGates()];
      registerCommands();
      bunny.plugins && bunny.plugins.plugin && (globalThis.__nitrobenchStop = () => {
        ups.forEach(u => u()); unreg.forEach(u => u()); unreg = [];
      });
      LOG("loaded. unlocked gates:", state.unlocked.length);
    },
    stop() {
      if (globalThis.__nitrobenchStop) { globalThis.__nitrobenchStop(); delete globalThis.__nitrobenchStop; }
      LOG("stopped");
    }
  });
})();