((vendetta) => {
  // nitro-bench v6 — full booster-perk unlock (multi-layer)
  // layers: guild object stamp + MemberStore.premiumSince + PermissionStore.can
  // + runtime auto-calibrated perk-gate override (type-sniffed per function)
  // + broadcast autopilot on real playSound modules.
  const { metro, commands, patcher } = vendetta;
  const byProps = metro.findByProps || (() => null);
  const byName = metro.findByName || (() => null);
  const byStore = metro.findByStoreName || (() => null);
  const findAll = metro.findAll || (() => []);
  const common = metro.common || {};
  const FluxDispatcher = common.FluxDispatcher;

  const STRING = 3;
  const state = { spoof: true, guard: true, wraps: 0, perks: 0, relaySent: false };
  const teardown = [];
  const sweeps = [];

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

  function myGuildId() {
    try {
      const v = common.channels && common.channels.getVoiceChannelId();
      const chan = v && byStore("ChannelStore") && byStore("ChannelStore").getChannel(v);
      if (chan && chan.guild_id) return chan.guild_id;
    } catch { /* vol */ }
    return "0";
  }

  // ---------------- premium spoof --------------------------------------------------
  function patchPremium() {
    const UserStore = byStore("UserStore");
    if (UserStore && typeof UserStore.getCurrentUser === "function") {
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
    const MemberStore = byStore("MemberStore");
    if (MemberStore && typeof MemberStore.getMember === "function") {
      teardown.push(patcher.after("getMember", MemberStore, (args, member) => {
        if (member && typeof member === "object" && state.spoof) {
          member.premiumSince = member.premiumSince || new Date("2020-01-01").toISOString();
        }
        return member;
      }));
    }
  }

  // ---------------- layer 1 + 2 + 3 ------------------------------------------------
  function patchBoost() {
    const GuildStore = byStore("GuildStore");
    if (GuildStore && typeof GuildStore.getGuild === "function") {
      teardown.push(patcher.after("getGuild", GuildStore, (_a, guild) => {
        if (guild && state.guard) {
          guild.premiumTier = 3; guild.boostCount = 100;
          guild.premiumSubscriptionCount = 100;
          guild.boostProgressBarEnabled = true;
        }
        return guild;
      }));
    }
    if (GuildStore && typeof GuildStore.getGuilds === "function") {
      teardown.push(patcher.after("getGuilds", GuildStore, (_a, map) => {
        if (map && state.guard) {
          const list = map && typeof map.values === "function" ? Array.from(map.values()) : Object.values(map);
          for (const g of list) { if (g) { g.premiumTier = 3; g.boostCount = 100; g.premiumSubscriptionCount = 100; } }
        }
        return map;
      }));
    }
    const PermStore = byStore("PermissionStore");
    if (PermStore && typeof PermStore.can === "function") {
      teardown.push(patcher.instead("can", PermStore, (args, orig) => {
        if (state.guard && args) {
          const key = String(args[0] ?? "");
          if (key === "USE_SOUNDBOARD") return true;
        }
        return orig(...args);
      }));
    }
  }

  // KNOWN gate predicate modules from the picker surfaces (build-stable-ish)
  const KNOWN_BOOL = [
    "canPlaySound", "useCanPlaySound", "canUseSoundboard", "canUseEmojis",
    "canUseAnimatedEmojis", "canUseCustomStickers", "canUseStickers", "canUseSoundboardByGuild",
    "isSoundboardBlocked", "isSoundboardPotentiallyUnavailable", "isSoundboardModeDenied",
    "isSoundboardAvailable", "hasSoundboardAccess", "hasEnhancedSoundsByUser",
    "canUseAnimatedEmoji", "canUseExternalEmoji", "canUseExternalStickers",
    "hasGuildPremium", "isPremium", "hasPremium", "isGuildPremium",
    "hasBoosterPerks", "isBooster", "hasBoost", "isPremiumMember"
  ];
  const KNOWN_TIER = [
    "getGuildPremiumTier", "getPremiumTier", "getGuildPremiumMaxTier",
    "getSoundboardTier", "getBoostLevel", "getGuildBoostLevel", "getBoostTier"
  ];
  const KNOWN_MAX = [
    "getMaxGuildEmojis", "getMaxGuildStickers", "getMaxSoundboardSounds",
    "getMaxSoundboardSlots", "getMaxEmojiSlots", "getMaxStickerSlots"
  ];
  // CONFIRMED identifiers from the actual client bundle (index.android.bundle string table)
  const EXACT_BOOL = [
    "canChannelUseSoundboard", "useCanChannelUseSoundboardPickerType",
    "hasPermissionToPlaySoundboard", "useSoundboardSoundPreviewEnabled",
    "shouldSkipMuteUnmuteSoundboard", "canMakeSoundboardPickerStore"
  ];
  const EXACT_LOCK_MUTE = [
    "useSoundboardSoundLock", "handleSpeakingWhileMuted"
  ];
  const EXACT_MAX = ["getMaxSoundboardSlots"];
  const BOOST_AGED = new Date("2018-01-01").getTime();

  function overflow(key, mod, value) {
    teardown.push(patcher.instead(key, mod, (args, orig) => {
      if (state.guard) return value;
      return orig(...args);
    }));
  }
  const patchNamed = (names, value) => {
    for (const key of names) {
      const mod = except(() => byProps(key)) || except(() => byName(key));
      if (mod && typeof mod[key] === "function") {
        overflow(key, mod, value);
        state.perks++;
      }
    }
  };

  // ---------------- layer 4: auto-calibrated sweep ---------------------------------
  const PERK_RE = /premiumTier|GuildPremiumTier|boostCount|premiumSubscriptionCount|premiumSince|canUseAnimated|canUseCustom|canUseSticker|canUseEmoji|canUseSoundboard|getMaxGuild|isSoundboard|hasSoundboard|Soundboard/;
  const KEY_BOOL = /^(can|should|is|has|use|allow)[A-Z]|Blocked|Unavailable|Denied|Available|Access|Premium$/;
  const KEY_TIER = /Tier|BoostLevel|Level$/;
  const KEY_MAX = /Max|Limit|Slot|Count$/;
  const KEY_AGED = /Since|Timestamp|Date$/;

  function patchPerksSweep() {
    const gid = myGuildId();
    let seen = 0;
    let scanned = 0;
    try {
      findAll((m) => {
        if (!m || (typeof m !== "object" && typeof m !== "function")) return false;
        let keys;
        try { keys = typeof m === "function" ? [] : Object.keys(m); } catch { return false; }
        if (keys.length > 400) keys = keys.slice(0, 400);
        for (const k of keys) {
          let v;
          try { v = m[k]; } catch { continue; }
          if (typeof v !== "function") continue;
          if (/^(play|stop|pause|seek)/i.test(k)) continue; // never hijack playback
          let s;
          try { s = Function.prototype.toString.call(v); } catch { continue; }
          scanned++;
          if (!PERK_RE.test(s)) continue;

          // decide value by name heuristic, else by probing the live function
          let value;
          if (KEY_BOOL.test(k)) value = true;
          else if (KEY_AGED.test(k)) value = BOOST_AGED;
          else if (KEY_TIER.test(k)) value = 3;
          else if (KEY_MAX.test(k)) value = 100;
          else {
            // type-sniff: call with a fake guild id, read what it returns
            let probe;
            try { probe = v.call(m, gid); } catch { probe = undefined; }
            if (typeof probe === "boolean") value = true;
            else if (typeof probe === "number") {
              value = probe > 10000 ? BOOST_AGED : 3; // timestamps vs small enums
            }
          }
          if (value !== undefined && !sweeps.some((x) => x.key === k)) {
            try {
              overflow(k, m, value);
              sweeps.push({ key: k, value });
              state.perks++;
            } catch { /* vol */ }
          }
          seen++;
        }
        return false;
      });
    } catch (e) {
      console.error("[nitro-bench] perk sweep failed", e);
    }
    console.log("[nitro-bench] wrap scanned:", scanned, "perk overrides:", state.perks);
    toast("[nitro-bench] perks=" + state.perks);
  }

  // confirmed exact-shape patches
  function patchExact() {
    for (const key of EXACT_BOOL) {
      const mod = except(() => byName(key));
      if (mod && typeof mod[key] === "function") {
        try { overflow(key, mod, true); state.perks++; console.log("[nitro-bench] exactPoke:", key); } catch { /* vol */ }
      }
    }
    for (const key of EXACT_MAX) {
      const mod = except(() => byName(key)) || except(() => byProps(key));
      if (mod && typeof mod[key] === "function") {
        try { overflow(key, mod, 100); state.perks++; console.log("[nitro-bench] exactMax:", key); } catch { /* vol */ }
      }
    }
    // lock hook returns a state object; return a fully-unlocked blob (truthy object covers
    // both .canUse/.canPlay usage and truthy-boolean usage)
    const lock = except(() => byName("useSoundboardSoundLock"));
    if (lock && typeof lock.useSoundboardSoundLock === "function") {
      try {
        teardown.push(patcher.instead("useSoundboardSoundLock", lock, (args, orig) => {
          if (state.guard) return { locked: false, isLocked: false, canUse: true, canPlay: true, canUseSoundboard: true, reason: null, tier: 3, result: true };
          return orig(...args);
        }));
        state.perks++;
        console.log("[nitro-bench] soundboard lock force-disabled");
      } catch { /* vol */ }
    }
    const mute = except(() => byName("handleSpeakingWhileMuted"));
    if (mute && typeof mute.handleSpeakingWhileMuted === "function") {
      try {
        teardown.push(patcher.instead("handleSpeakingWhileMuted", mute, (args, orig) => {
          if (state.guard) return undefined; // swallow mute-gated speaking suppression
          return orig(...args);
        }));
        state.perks++;
        console.log("[nitro-bench] muted-speak suppression disabled");
      } catch { /* vol */ }
    }
  }

  // command leftover state helpers
  function nativeSurface() {
    const out = [];
    try {
      const nmods = common.ReactNative && common.ReactNative.NativeModules;
      if (nmods) {
        for (const k of Object.keys(nmods)) {
          if (/voice|audio|media|engine|sound|rtc|record|opus/i.test(k)) out.push(k);
        }
      }
    } catch { /* vol */ }
    return out;
  }

  // ---------------- broadcast autopilot --------------------------------------------
  const HAY = /playSound|playSoundboard|soundboard|soundshare|SOUNDSHARE|emitSoundboardFx|binAudio/i;
  const PLAY_KEY = /^play(Sound|Soundboard)?$/i;

  function pullIds(args) {
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
          FluxDispatcher.dispatch({ type, soundId: sid, guildId: gid, channelId: chan, sound: { id: sid, guild_id: gid } });
          attempts.push(type);
        });
      }
    }
    const rtc = except(() => byProps("sendToGateway")) || except(() => byName("sendToGateway"));
    if (rtc && typeof rtc.sendToGateway === "function") {
      except(() => { rtc.sendToGateway({ type: "VOICE_CHANNEL_SOUNDBOARD_PLAY", guildId: gid, channelId: chan, soundId: sid }); attempts.push("gateway"); });
    }
    if (attempts.length) state.relaySent = true;
    return attempts;
  }

  function wrapPlayModules() {
    try {
      findAll((m) => {
        if (!m || (typeof m !== "object" && typeof m !== "function")) return false;
        let keys;
        try { keys = typeof m === "function" ? [""] : Object.keys(m); } catch { return false; }
        if (keys.length > 300) keys = keys.slice(0, 300);
        for (const k of keys) {
          let v;
          try { v = k === "" ? m : m[k]; } catch { continue; }
          if (typeof v !== "function" || k === "") continue;
          let s;
          try { s = Function.prototype.toString.call(v); } catch { continue; }
          if (!(PLAY_KEY.test(k) || /playSound|soundboard/i.test(k)) || !HAY.test(s)) continue;
          try {
            teardown.push(patcher.after(k, m, (args, ret) => {
              try {
                const { channelId, guildId, sound } = pullIds(args || []);
                const sid = sound && (sound.id || sound.sound_id);
                if (channelId && guildId && sid) emitRelay(channelId, guildId, sid);
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
    console.log("[nitro-bench] autopilot wraps:", state.wraps);
  }

  // ---------------- commands -------------------------------------------------------
  const unreg = [];
  function cmd(def) { if (commands && typeof commands.registerCommand === "function") unreg.push(commands.registerCommand(tryExec(def))); }

  function register() {
    cmd({
      name: "nativemods", displayName: "nativemods",
      description: "list voice/audio/media native module names",
      displayDescription: "list voice/audio/media native module names",
      options: [],
      execute: () => {
        const s = nativeSurface();
        return { content: s.length ? "[nativemods] " + s.join(", ") : "[nativemods] none matched" };
      }
    });
    cmd({
      name: "sbping", displayName: "sbping",
      description: "version + load check", displayDescription: "version + load check",
      options: [],
      execute: () => ({ content: "nitro-bench v6 ok | wraps=" + state.wraps + " | perks=" + state.perks + " | relay=" + (state.relaySent ? "sent" : "no-yet") })
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
        return { content: "spoof " + (state.spoof ? "ON" : "off") + " | wraps=" + state.wraps + " | perks=" + state.perks };
      }
    });
  }

  return {
    name: "nitro-bench",
    description: "nitro + all booster perks unlock, soundboard broadcast on tap.",
    authors: [{ name: "asdasdafds", id: "258577658" }],
    onLoad() {
      try {
        except(() => { state.spoof = vendetta.plugin.storage.spoof ?? true; });
        state.guard = state.spoof;
        console.warn("[nitro-bench] starting");
        patchPremium();
        patchBoost();
        patchNamed(KNOWN_BOOL, true);
        patchNamed(KNOWN_TIER, 3);
        patchNamed(KNOWN_MAX, 100);
        patchExact();
        wrapPlayModules();
        patchPerksSweep();
        register();
        console.log("[nitro-bench] loaded  wraps=" + state.wraps + " perks=" + state.perks);
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