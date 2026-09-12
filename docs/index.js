((vendetta) => {
  // nitro-bench v2 — vendetta-contract plugin
  // premium + server-boost-tier spoof, soundboard gate unlock,
  // /sb play path mirroring the real picker (local + relay dispatch),
  // /sbprobe prints per-build resolution so the relay can be re-derived.
  const { metro, commands, patcher } = vendetta;
  const byProps = metro.findByProps || (() => null);
  const byName = metro.findByName || (() => null);
  const byStore = metro.findByStoreName || (() => null);
  const common = metro.common || {};
  const FluxDispatcher = common.FluxDispatcher;

  const STRING = 3;
  const state = { spoof: true, gates: [], tierPatched: [], play: null, relaySent: false };
  const teardown = [];

    function except(fn) { try { return fn(); } catch { return undefined; } }

  // ---------------- premium + boost tier spoof (client-side, stable) ------------
  function patchPremium() {
    const UserStore = byStore("UserStore");
    if (!UserStore || typeof UserStore.getCurrentUser !== "function") {
      console.warn("[nitro-bench] UserStore.resolve=false");
      return;
    }
    teardown.push(patcher.after("getCurrentUser", UserStore, (_a, user) => {
      if (user && state.spoof) {
        Object.assign(user, {
          premiumType: 2,
          premium: true,
          premiumSince: user.premiumSince ?? "2020-01-01T00:00:00.000Z",
          flags: (user.flags || 0) | (1 << 9) // PREMIUM_EARLY_SUPPORTER
        });
      }
      return user;
    }));
    console.log("[nitro-bench] premium patched");
  }

  // helper: patch every found gate predicate of a name-set to return true
  const EDGE_MODULES = [
    ["canPlaySound"], ["useCanPlaySound"], ["canUseSoundboard"],
    ["isSoundboardBlocked"], ["isSoundboardPotentiallyUnavailable"],
    ["isSoundboardModeDenied"], ["isSoundboardAvailable"],
    ["hasSoundboardAccess"], ["hasEnhancedSoundsByUser"]
  ];
  const TIER_MODULES = [
    ["getSoundboardTier"], ["getBoostLevel"], ["getGuildPremiumTier"],
    ["getPremiumTier"], ["getPremiumMaxTierCount"]
  ];

  function patchGates() {
    for (const props of EDGE_MODULES) {
      const mod = except(() => byProps(...props));
      if (!mod) continue;
      for (const key of props) {
        const fn = except(() => mod[key]);
        if (typeof fn === "function") {
          // predicates return boolean|null; bool gates -> true, count gates -> 3
          if (/Tier|Count|Level$/.test(key)) {
            teardown.push(patcher.instead(key, mod, () => 3));
            state.tierPatched.push(key);
          } else {
            teardown.push(patcher.instead(key, mod, () => true));
            state.gates.push(key);
          }
        }
      }
    }
    console.log("[nitro-bench] gates unblocked:", state.gates.join(",") || "none");
    console.log("[nitro-bench] tier forced:", state.tierPatched.join(",") || "none");
  }

  // ---------------- play path: mirror the real picker (local + relay) ------------
  function findPlay() {
    const cands = [
      () => byProps("SoundboardActions"),
      () => byProps("playSound", "stopSound"),
      () => byProps("playSound"),
      () => byStore("SoundboardStore"),
      () => byName("playSound"),
    ];
    for (const c of cands) {
      const m = except(c);
      if (!m) continue;
      const host = m.SoundboardActions && typeof m.SoundboardActions.playSound === "function" ? m.SoundboardActions : m;
      const f = host.playSound;
      if (typeof f === "function") return { mod: m, fn: f.bind(host), src: "module" };
    }
    return null;
  }

  function emitRelay(chan, gid, sid) {
    // the picker broadcasts play via flux + gateway voice frame; fire both best-guesses
    const attempts = [];
    if (FluxDispatcher && typeof FluxDispatcher.dispatch === "function") {
      for (const type of ["SOUNDBOARD_PLAY", "SOUNDBOARD_PLAY_AUDIO", "PLAY_SOUNDBOARD_SOUND", "SOUNDBOARD_TOGGLE"]) {
        except(() => {
          FluxDispatcher.dispatch({
            type,
            soundId: sid,
            guildId: gid,
            channelId: chan,
            sound: { id: sid, guild_id: gid }
          });
          attempts.push(type);
        });
      }
    }
    const rtc = except(() => byProps("sendToGateway")) || except(() => byName("sendToGateway"));
    if (rtc && typeof rtc.sendToGateway === "function") {
      except(() => {
        rtc.sendToGateway({ type: "VOICE_CHANNEL_SOUNDBOARD_PLAY", guildId: gid, channelId: chan, soundId: sid });
        attempts.push("gateway");
      });
    }
    if (attempts.length) state.relaySent = true;
    return attempts;
  }

  function playSound(sound, chan, gid) {
    const sid = sound.id;
    const found = findPlay();
    if (!found) return { content: "no soundboard play module found" };
    state.play = found.src;
    const res = [];
    try {
      found.fn(sound, {
        channelId: chan,
        guildId: gid,
        soundId: sid,
        location: "VOICE_CHANNEL_SOUNDBOARD_BUTTON",
        streamType: "SOUNDBOARD",
        emitFx: true
      });
      res.push("play invoked");
    } catch (e) {
      res.push("play threw: " + (e && e.message));
    }
    const relay = emitRelay(chan, gid, sid);
    if (relay.length) res.push("relay events: " + relay.join(","));
    else res.push("no relay dispatch possible");
    return { content: "played " + (sound.name || sid) + " [" + res.join(" | ") + "]" };
  }

  // ---------------- soundboard listing -------------------------------------------
  async function listSounds(ctx) {
    const channelId = common.channels && common.channels.getVoiceChannelId();
    if (!channelId) return { error: "not in a voice channel" };
    const ChannelStore = byStore("ChannelStore");
    const chan = channelId && ChannelStore && ChannelStore.getChannel(channelId);
    const guildId = chan && chan.guild_id;
    if (!guildId) return { error: "not in a guild voice channel" };

    const actions = except(() => byProps("fetchSoundboardSounds"));
    if (actions && typeof actions.fetchSoundboardSounds === "function") {
      await except(() => actions.fetchSoundboardSounds({ channelId, guildId }).then(() => null));
    }
    const SoundboardStore = byStore("SoundboardStore");
    const getter = SoundboardStore && (SoundboardStore.getSounds || SoundboardStore.getSoundboardSounds);
    const map = getter ? except(() => getter.call(SoundboardStore, guildId, channelId)) || {} : {};
    let arr = [];
    if (Array.isArray(map)) arr = map;
    else if (map && typeof map.toArray === "function") arr = map.toArray();
    else if (map && typeof map.values === "function") arr = Array.from(map.values());
    else arr = Object.values(map || {});
    return { sounds: arr.filter((s) => s && typeof s === "object"), channelId, guildId, chan };
  }

  // ---------------- commands ------------------------------------------------------
  const unreg = [];
  function cmd(def) { if (commands && typeof commands.registerCommand === "function") unreg.push(commands.registerCommand(def)); }

  function register() {
    cmd({
      name: "sb", displayName: "sb",
      description: "list or play a soundboard sound",
      displayDescription: "list or play a soundboard sound",
      options: [{ name: "sound", description: "sound name/id or list", displayName: "sound", displayDescription: "sound name/id or list", required: false, type: STRING }],
      execute: async (args, ctx) => {
        const want = ((args || []).find((a) => a.name === "sound") || {}).value || "list";
        const { sounds, error, channelId, guildId } = await listSounds(ctx);
        if (error) return { content: error };
        if (want === "list") {
          const names = sounds.map((s) => s.name || s.id);
          return { content: names.length ? names.slice(0, 40).join(", ") : "no soundboard sounds here" };
        }
        const hit = sounds.find((s) => s.name === want || s.id === want)
          || sounds.find((s) => String(s.name || "").toLowerCase().includes(String(want).toLowerCase()));
        if (!hit) return { content: "no sound named " + want };
        const cid = ctx && ctx.channel ? ctx.channel.id : channelId;
        const gid = ctx && ctx.guild ? ctx.guild.id : guildId;
        return playSound(hit, cid, gid);
      }
    });

    cmd({
      name: "nitro", displayName: "nitro",
      description: "toggle nitro + boost spoof",
      displayDescription: "toggle nitro + boost spoof",
      options: [{ name: "on", description: "1 or 0", displayName: "on", displayDescription: "1 or 0", required: false, type: STRING }],
      execute: (args) => {
        const v = ((args || []).find((a) => a.name === "on") || {}).value;
        state.spoof = !(v === "0" || v === "off");
        try { vendetta.plugin.storage.spoof = state.spoof; } catch { /* vol */ }
        return { content: "spoof " + (state.spoof ? "ON" : "off") + " (client-side)" };
      }
    });

    cmd({
      name: "sbprobe", displayName: "sbprobe",
      description: "print per-build soundboard resolution",
      displayDescription: "print per-build soundboard resolution",
      options: [],
      execute: async (args, ctx) => {
        const res = await listSounds(ctx).catch((e) => ({ error: String(e && e.message) }));
        const lines = [
          "premium:" + (state.spoof ? "on" : "off"),
          "gates:" + (state.gates.length ? state.gates.join(",") : "none"),
          "tier:" + (state.tierPatched.length ? state.tierPatched.join(",") : "none"),
          "play:" + (state.play || "not-found"),
          "relay:" + (state.relaySent ? "sent" : "not-sent"),
          "sounds:" + (res.sounds ? res.sounds.length : res.error || "n/a")
        ];
        return { content: "[sbprobe] " + lines.join(" | ") };
      }
    });
  }

  return {
    name: "nitro-bench",
    description: "nitro + boost-tier spoof, soundboard unlock, /sb play.",
    authors: [{ name: "asdasdafds", id: "258577658" }],
    onLoad() {
      except(() => { state.spoof = vendetta.plugin.storage.spoof ?? true; });
      console.warn("[nitro-bench] starting");
      patchPremium();
      patchGates();
      register();
      console.log("[nitro-bench] loaded");
    },
    onUnload() {
      teardown.forEach((u) => except(() => u()));
      teardown.length = 0;
      unreg.forEach((u) => except(() => u()));
      unreg.length = 0;
      console.log("[nitro-bench] stopped");
    }
  };
})(vendetta);