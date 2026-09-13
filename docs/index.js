((vendetta) => {
  // nitro-bench v3 — vendetta-contract plugin
  // - guild premiumTier stamping (real boost-tier bypass)
  // - USE_SOUNDBOARD permission force
  // - premium spoof
  // - /sb play (picker-mirror payload)
  // - /sbdump: runtime sweep of the client for real soundshare/soundboard
  //   modules so the transmit path can be re-derived from dj's build
  const { metro, commands, patcher } = vendetta;
  const byProps = metro.findByProps || (() => null);
  const byName = metro.findByName || (() => null);
  const byStore = metro.findByStoreName || (() => null);
  const findAll = metro.findAll || (() => []);
  const common = metro.common || {};
  const FluxDispatcher = common.FluxDispatcher;

  const STRING = 3;
  const state = { spoof: true, guard: true, play: null, relaySent: false, permTried: false };
  const teardown = [];
  let candidates = null;

  function except(fn) { try { return fn(); } catch { return undefined; } }
  function toast(msg) {
    try { if (vendetta.ui && vendetta.ui.toasts && vendetta.ui.toasts.showToast) vendetta.ui.toasts.showToast(msg); } catch { /* vol */ }
    try { if (common.toasts && common.toasts.showToast) common.toasts.showToast(msg); } catch { /* vol */ }
  }
  function tryExec(def) {
    const real = def.execute;
    def.execute = (args, ctx) => {
      try { return real(args, ctx); } catch (e) { return { content: "[nitro-bench error] " + String(e && e.message || e) }; }
    };
    return def;
  }

  // ---------------- premium spoof (client-side) -----------------------------------
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
          flags: (user.flags || 0) | (1 << 9)
        });
      }
      return user;
    }));
    console.log("[nitro-bench] premium patched");
  }

  // ---------------- boost-tier bypass: stamp the guild, force the permission -----
  function patchBoost() {
    const GuildStore = byStore("GuildStore");
    if (GuildStore && typeof GuildStore.getGuild === "function") {
      teardown.push(patcher.after("getGuild", GuildStore, (_a, guild) => {
        if (guild && state.guard) {
          guild.premiumTier = 3;
          guild.boostCount = 100;
          guild.boostProgressBarEnabled = true;
        }
        return guild;
      }));
    }
    if (GuildStore && typeof GuildStore.getGuilds === "function") {
      teardown.push(patcher.after("getGuilds", GuildStore, (_a, map) => {
        if (map && state.guard) {
          const list = map && typeof map.values === "function" ? Array.from(map.values()) : Object.values(map);
          for (const g of list) {
            if (g) { g.premiumTier = 3; g.boostCount = 100; }
          }
        }
        return map;
      }));
    }
    const PermStore = byStore("PermissionStore");
    if (PermStore && typeof PermStore.can === "function") {
      teardown.push(patcher.instead("can", PermStore, (args, orig) => {
        if (state.guard && args && (args[0] === "USE_SOUNDBOARD" || args[1] === "USE_SOUNDBOARD")) return true;
        return orig(...args);
      }));
    }
    console.log("[nitro-bench] boost stamp installed");
  }

  // ---------------- runtime sweep: find the real transmit modules ----------------
  const HAYSTACK_KEYS = /soundboard|soundshare|SOUNDSHARE|bin.?audio|SOUNDBOARD/i;
  function scan() {
    if (candidates) return candidates;
    candidates = [];
    const seen = new Set();
    findAll((m) => {
      if (!m || (!(typeof m === "object") && typeof m !== "function")) return false;
      let keys = [];
      try {
        if (typeof m === "function") keys = [""];
        else keys = Object.keys(m);
      } catch { return false; }
      if (keys.length > 300) keys = keys.slice(0, 300);
      let hitKey = null;
      let hitSrc = null;
      for (const k of keys) {
        let v;
        try { v = k === "" ? m : m[k]; } catch { continue; }
        if (typeof v !== "function") continue;
        let s;
        try { s = Function.prototype.toString.call(v); } catch { continue; }
        if (HAYSTACK_KEYS.test(s)) { hitKey = k; hitSrc = s; break; }
      }
      if (hitKey !== null) {
        if (seen.has(m)) return false;
        seen.add(m);
        try {
          candidates.push({ keys, key: hitKey, src: hitSrc });
        } catch { /* vol */ }
        return m;
      }
      return false;
    });
    return candidates;
  }

  // ---------------- play path ------------------------------------------------------
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
    const attempts = [];
    if (FluxDispatcher && typeof FluxDispatcher.dispatch === "function") {
      for (const type of ["SOUNDBOARD_PLAY", "SOUNDBOARD_PLAY_AUDIO", "PLAY_SOUNDBOARD_SOUND", "SOUNDBOARD_TOGGLE"]) {
        except(() => {
          FluxDispatcher.dispatch({
            type, soundId: sid, guildId: gid, channelId: chan,
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
        channelId: chan, guildId: gid, soundId: sid,
        location: "VOICE_CHANNEL_SOUNDBOARD_BUTTON",
        streamType: "SOUNDBOARD", emitFx: true
      });
      res.push("play invoked");
    } catch (e) { res.push("play threw: " + (e && e.message)); }
    const relay = emitRelay(chan, gid, sid);
    res.push(relay.length ? "relay:" + relay.join(",") : "no relay");
    return { content: "played " + (sound.name || sid) + " [" + res.join(" | ") + "]" };
  }

  // ---------------- listing ---------------------------------------------------------
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

  function permCheck(channelId) {
    const PermStore = byStore("PermissionStore");
    if (!PermStore) return "n/a";
    try { return PermStore.can("USE_SOUNDBOARD", channelId) ? "ok" : "blocked"; } catch { return "err"; }
  }

  // ---------------- commands --------------------------------------------------------
  const unreg = [];
  function cmd(def) { if (commands && typeof commands.registerCommand === "function") unreg.push(commands.registerCommand(tryExec(def))); }

  function register() {
    cmd({
      name: "sbping", displayName: "sbping",
      description: "version + load check",
      displayDescription: "version + load check",
      options: [],
      execute: () => ({ content: "nitro-bench v4 ok | play=" + (state.play || "none") })
    });

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
      description: "toggle premium + boost spoof",
      displayDescription: "toggle premium + boost spoof",
      options: [{ name: "on", description: "1 or 0", displayName: "on", displayDescription: "1 or 0", required: false, type: STRING }],
      execute: (args) => {
        const v = ((args || []).find((a) => a.name === "on") || {}).value;
        state.spoof = !(v === "0" || v === "off");
        state.guard = state.spoof;
        try { vendetta.plugin.storage.spoof = state.spoof; } catch { /* vol */ }
        return { content: "spoof " + (state.spoof ? "ON" : "off") + " (client-side)" };
      }
    });

    cmd({
      name: "sbprobe", displayName: "sbprobe",
      description: "resolution report",
      displayDescription: "resolution report",
      options: [],
      execute: async (args, ctx) => {
        const res = await listSounds(ctx).catch((e) => ({ error: String(e && e.message) }));
        const cid = res.channelId || (ctx.channel && ctx.channel.id);
        const lines = [
          "premium:" + (state.spoof ? "on" : "off"),
          "boostStamp:" + (state.guard ? "on" : "off"),
          "perm:" + (cid ? permCheck(cid) : "n/a"),
          "play:" + (state.play || "not-found"),
          "relay:" + (state.relaySent ? "sent" : "not-sent"),
          "cands:" + (candidates ? candidates.length : "unscanned"),
          "sounds:" + (res.sounds ? res.sounds.length : res.error || "n/a")
        ];
        return { content: "[sbprobe] " + lines.join(" | ") };
      }
    });

    cmd({
      name: "sbdump", displayName: "sbdump",
      description: "dump soundshare/soundboard modules from this build",
      displayDescription: "dump soundshare/soundboard modules from this build",
      options: [],
      execute: async () => {
        let c;
        try { c = scan(); } catch (e) { return { content: "scan failed: " + String(e && e.message) }; }
        const out = [];
        for (let i = 0; i < c.length; i++) {
          const m = c[i];
          const src = (m.src || "").replace(/\s+/g, " ");
          out.push((i + 1) + ". key=[" + m.key + "] keys=" + m.keys.length + " src=" + src.slice(0, 150));
        }
        if (!out.length) return { content: "[sbdump] no soundshare/soundboard module matched this build" };
        return { content: "[sbdump] " + out.length + " hit\n" + out.join("\n").slice(0, 1900) };
      }
    });
  }

  return {
    name: "nitro-bench",
    description: "nitro + boost-tier spoof, soundboard unlock, /sb play, /sbdump.",
    authors: [{ name: "asdasdafds", id: "258577658" }],
    onLoad() {
      try {
        except(() => { state.spoof = vendetta.plugin.storage.spoof ?? true; });
        state.guard = state.spoof;
        console.warn("[nitro-bench] starting");
        patchPremium();
        patchBoost();
        register();
        console.log("[nitro-bench] loaded");
        toast("[nitro-bench] loaded OK");
      } catch (e) {
        console.error("[nitro-bench] LOAD FAIL", e);
        toast("[nitro-bench] LOAD FAIL: " + String(e && e.message || e));
      }
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