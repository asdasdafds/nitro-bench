((vendetta) => {
  // nitro-bench v5 — autopilot broadcast
  // premium + boost spoof, then WRAP every playSound-like module the client
  // actually uses (triggered by dj tapping sounds in the real picker) to also
  // fire relay/voice-stream transmit. Slash commands are diagnostic only.
  const { metro, commands, patcher } = vendetta;
  const byProps = metro.findByProps || (() => null);
  const byName = metro.findByName || (() => null);
  const byStore = metro.findByStoreName || (() => null);
  const findAll = metro.findAll || (() => []);
  const common = metro.common || {};
  const FluxDispatcher = common.FluxDispatcher;

  const STRING = 3;
  const state = { spoof: true, guard: true, wraps: 0, relaySent: false };
  const teardown = [];

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

  // ---------------- premium spoof ------------------------------------------------
  function patchPremium() {
    const UserStore = byStore("UserStore");
    if (!UserStore || typeof UserStore.getCurrentUser !== "function") {
      console.warn("[nitro-bench] UserStore.resolve=false");
      return;
    }
    teardown.push(patcher.after("getCurrentUser", UserStore, (_a, user) => {
      if (user && state.spoof) {
        Object.assign(user, {
          premiumType: 2, premium: true,
          premiumSince: user.premiumSince ?? "2020-01-01T00:00:00.000Z",
          flags: (user.flags || 0) | (1 << 9)
        });
      }
      return user;
    }));
  }

  // ---------------- boost-tier bypass ---------------------------------------------
  function patchBoost() {
    const GuildStore = byStore("GuildStore");
    if (GuildStore && typeof GuildStore.getGuild === "function") {
      teardown.push(patcher.after("getGuild", GuildStore, (_a, guild) => {
        if (guild && state.guard) {
          guild.premiumTier = 3; guild.boostCount = 100; guild.boostProgressBarEnabled = true;
        }
        return guild;
      }));
    }
    if (GuildStore && typeof GuildStore.getGuilds === "function") {
      teardown.push(patcher.after("getGuilds", GuildStore, (_a, map) => {
        if (map && state.guard) {
          const list = map && typeof map.values === "function" ? Array.from(map.values()) : Object.values(map);
          for (const g of list) { if (g) { g.premiumTier = 3; g.boostCount = 100; } }
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
  }

  // ---------------- relay/transmit best-effort -----------------------------------
  function pullIds(args) {
    // args look like (sound, {channelId,guildId}) or ({id,guild_id}, channelId, guildId)
    let sound; let channelId; let guildId;
    const walk = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 2) return;
      if (channelId === undefined && o.channelId) channelId = o.channelId;
      if (channelId === undefined && o.channel_id) channelId = o.channel_id;
      if (guildId === undefined && o.guildId) guildId = o.guildId;
      if (guildId === undefined && o.guild_id) guildId = o.guild_id;
      if (!sound && (o.id !== undefined) && (o.guild_id !== undefined || o.name !== undefined)) sound = o;
    };
    for (const a of args) { if (Array.isArray(a)) a.forEach((x) => walk(x, 0)); else walk(a, 0); }
    return { sound, channelId, guildId };
  }

  function emitRelay(chan, gid, sid) {
    if (!chan || !gid || !sid) return [];
    const attempts = [];
    if (FluxDispatcher && typeof FluxDispatcher.dispatch === "function") {
      for (const type of ["SOUNDBOARD_PLAY", "SOUNDBOARD_PLAY_AUDIO", "PLAY_SOUNDBOARD_SOUND", "SOUNDBOARD_TOGGLE", "SOUNDBOARD_PLAY_SOUND"]) {
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

  // ---------------- autopilot: wrap real play modules ----------------------------
  const HAY = /playSound|playSoundboard|soundboard|soundshare|SOUNDSHARE|emitSoundboardFx|binAudio/i;
  const PLAY_KEY = /^play(Sound|Soundboard)?$/i;

  function wrapPlayModules() {
    let swept = 0;
    try {
      findAll((m) => {
        if (!m || (typeof m !== "object" && typeof m !== "function")) return false;
        let keys;
        try { keys = typeof m === "function" ? [""] : Object.keys(m); } catch { return false; }
        if (keys.length > 300) keys = keys.slice(0, 300);
        for (const k of keys) {
          let v;
          try { v = k === "" ? m : m[k]; } catch { continue; }
          if (typeof v !== "function") continue;
          let s;
          try { s = Function.prototype.toString.call(v); } catch { continue; }
          const isPlay = PLAY_KEY.test(k) || /playSound|soundboard/i.test(k);
          if (!isPlay || !HAY.test(s)) continue;
          if (k === "") continue;
          swept++;
          const candArgs = [m, v];
          try {
            teardown.push(patcher.after(k === "" ? undefined : k, m, (args, ret) => {
              try {
                const { channelId, guildId, sound } = pullIds(args || []);
                if (!channelId || !guildId || !sound) return;
                const sid = sound.id || sound.sound_id;
                if (sid) emitRelay(channelId, guildId, sid);
              } catch { /* vol */ }
              return ret;
            }));
            state.wraps++;
          } catch { /* vol */ }
        }
        return false;
      });
    } catch (e) {
      console.error("[nitro-bench] sweep failed", e);
    }
    console.log("[nitro-bench] autopilot wraps:", state.wraps, "swept:", swept);
    toast("[nitro-bench] wraps=" + state.wraps);
  }

  // ---------------- listing (diagnostics) -----------------------------------------
  async function listSounds() {
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

  // ---------------- commands (diagnostic only) ------------------------------------
  const unreg = [];
  function cmd(def) { if (commands && typeof commands.registerCommand === "function") unreg.push(commands.registerCommand(tryExec(def))); }

  function register() {
    cmd({
      name: "sbping", displayName: "sbping",
      description: "version + load check", displayDescription: "version + load check",
      options: [],
      execute: () => ({ content: "nitro-bench v5 ok | wraps=" + state.wraps + " | relay=" + (state.relaySent ? "sent" : "no-yet") })
    });
    cmd({
      name: "sb", displayName: "sb",
      description: "list or play a soundboard sound", displayDescription: "list or play a soundboard sound",
      options: [{ name: "sound", description: "sound name/id or list", displayName: "sound", displayDescription: "sound name/id or list", required: false, type: STRING }],
      execute: async (args) => {
        const want = ((args || []).find((a) => a.name === "sound") || {}).value || "list";
        const { sounds, error } = await listSounds();
        if (error) return { content: error };
        if (want === "list") {
          const names = sounds.map((s) => s.name || s.id);
          return { content: names.length ? names.slice(0, 40).join(", ") : "no soundboard sounds here" };
        }
        const hit = sounds.find((s) => s.name === want || s.id === want)
          || sounds.find((s) => String(s.name || "").toLowerCase().includes(String(want).toLowerCase()));
        if (!hit) return { content: "no sound named " + want };
        return { content: "hit picker with " + hit.name + " — tap it in the soundboard UI to broadcast" };
      }
    });
    cmd({
      name: "nitro", displayName: "nitro",
      description: "toggle premium + boost spoof", displayDescription: "toggle premium + boost spoof",
      options: [{ name: "on", description: "1 or 0", displayName: "on", displayDescription: "1 or 0", required: false, type: STRING }],
      execute: (args) => {
        const v = ((args || []).find((a) => a.name === "on") || {}).value;
        state.spoof = !(v === "0" || v === "off");
        state.guard = state.spoof;
        except(() => { vendetta.plugin.storage.spoof = state.spoof; });
        return { content: "spoof " + (state.spoof ? "ON" : "off") + " (client-side)" };
      }
    });
  }

  return {
    name: "nitro-bench",
    description: "nitro + boost-tier spoof, soundboard broadcast on tap (autopilot).",
    authors: [{ name: "asdasdafds", id: "258577658" }],
    onLoad() {
      try {
        except(() => { state.spoof = vendetta.plugin.storage.spoof ?? true; });
        state.guard = state.spoof;
        console.warn("[nitro-bench] starting");
        patchPremium();
        patchBoost();
        wrapPlayModules();
        register();
        console.log("[nitro-bench] loaded");
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