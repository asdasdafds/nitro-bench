((vendetta) => {
  // nitro-bench — vendetta-contract plugin (eval'd as `vendetta => ({...})`)
  // nitro spoof + soundboard gate unlock + /sb soundboard play command.
  // live-target keys (soundboard gates, playSound module) re-derived per client build.
  const { metro, commands, patcher } = vendetta;
  const byProps = metro.findByProps || (() => null);
  const byName = metro.findByName || (() => null);
  const byStore = metro.findByStoreName || (() => null);
  const common = metro.common || {};

  const state = { spoof: true, unlocked: [] };
  let unpatchAll = [];

  // option type: STRING = 3 (bunny ApplicationCommandOptionType)
  const STRING = 3;

  function patchPremium() {
    const UserStore = byStore("UserStore");
    if (!UserStore || typeof UserStore.getCurrentUser !== "function") {
      console.warn("[nitro-bench] UserStore.resolve=false");
      return () => {};
    }
    return patcher.after("getCurrentUser", UserStore, (_args, user) => {
      if (user && state.spoof) Object.assign(user, { premiumType: 2, premium: true });
      return user;
    });
  }

  const GATE_PROPS = [
    "canPlaySound", "useCanPlaySound", "canUseSoundboard",
    "isSoundboardBlocked", "isSoundboardPotentiallyUnavailable",
    "isSoundboardModeDenied", "getSoundboardTier"
  ];

  function patchGates() {
    const ups = [];
    for (const key of GATE_PROPS) {
      try {
        const mod = byProps(key);
        if (mod && typeof mod[key] === "function") {
          ups.push(patcher.instead(key, mod, () => true));
          state.unlocked.push(key);
        }
      } catch { /* skip */ }
    }
    return () => ups.forEach((u) => { try { u(); } catch { /* torn */ } });
  }

  function findPlay() {
    const cands = [
      () => byProps("playSound", "stopSound"),
      () => byProps("playSound"),
      () => byName("playSound"),
    ];
    for (const c of cands) {
      try {
        const m = c();
        if (m && typeof m.playSound === "function") return m;
      } catch { /* next */ }
    }
    return null;
  }

  async function listSounds(_ctx) {
    const channelId = common.channels && common.channels.getVoiceChannelId();
    if (!channelId) return [];
    const ChannelStore = byStore("ChannelStore");
    const chan = ChannelStore && ChannelStore.getChannel(channelId);
    const guildId = chan && chan.guild_id;
    if (!guildId) return [];

    const actions = byProps("fetchSoundboardSounds");
    if (actions && typeof actions.fetchSoundboardSounds === "function") {
      try { await actions.fetchSoundboardSounds({ channelId, guildId }); } catch { /* non-fatal */ }
    }
    const SoundboardStore = byStore("SoundboardStore");
    const getter = SoundboardStore && (SoundboardStore.getSounds || SoundboardStore.getSoundboardSounds);
    const map = getter ? (getter.call(SoundboardStore, guildId, channelId) || {}) : {};
    const arr = map && typeof map.toArray === "function" ? map.toArray() : Object.values(map);
    return arr.filter((s) => s && typeof s === "object");
  }

  function playSound(sound, channelId, guildId) {
    const mod = findPlay();
    if (!mod) return "no playSound module found";
    try {
      mod.playSound(sound, { channelId, guildId, location: "SOUNDBOARD" });
      return "played " + (sound.name || sound.id);
    } catch (e) {
      return "play failed: " + (e && e.message);
    }
  }

  const unreg = [];
  function register() {
    if (!commands || typeof commands.registerCommand !== "function") return;
    unreg.push(commands.registerCommand({
      name: "sb",
      displayName: "sb",
      description: "list or play a soundboard sound",
      displayDescription: "list or play a soundboard sound",
      options: [{
        name: "sound",
        description: "sound name or id, or list",
        displayName: "sound",
        displayDescription: "sound name or id, or list",
        required: false,
        type: STRING
      }],
      execute: async (args, ctx) => {
        const want = ((args || []).find((a) => a.name === "sound") || {}).value || "list";
        if (want === "list") {
          try {
            const sounds = await listSounds(ctx);
            return { content: sounds.length ? sounds.map((s) => s.name || s.id).slice(0, 40).join(", ") : "no soundboard sounds in this server" };
          } catch (e) { return { content: "list failed: " + (e && e.message) }; }
        }
        let sounds = [];
        try { sounds = await listSounds(ctx); } catch { /* handled below */ }
        const hit = sounds.find((s) => s.name === want || s.id === want)
          || sounds.find((s) => (s.name || "").toLowerCase().includes(String(want).toLowerCase()));
        if (!hit) return { content: "no sound named " + want };
        return {
          content: playSound(
            hit,
            ctx && ctx.channel ? ctx.channel.id : hit.channel_id,
            ctx && ctx.guild ? ctx.guild.id : hit.guild_id
          )
        };
      }
    }));

    unreg.push(commands.registerCommand({
      name: "nitro",
      displayName: "nitro",
      description: "toggle nitro spoof",
      displayDescription: "toggle nitro spoof",
      options: [{
        name: "on",
        description: "1 or 0",
        displayName: "on",
        displayDescription: "1 or 0",
        required: false,
        type: STRING
      }],
      execute: (args) => {
        const { storage } = vendetta.plugin;
        const v = ((args || []).find((a) => a.name === "on") || {}).value;
        state.spoof = v === "0" || v === "off" ? false : true;
        try { storage.spoof = state.spoof; } catch { /* non-persistent ok */ }
        return { content: "nitro spoof " + (state.spoof ? "ON" : "off") + " (client-side only)" };
      }
    }));
  }

  return {
    name: "nitro-bench",
    description: "nitro booster spoof, soundboard unlock, and /sb soundboard playback.",
    authors: [{ name: "asdasdafds", id: "258577658" }],
    onLoad() {
      try { state.spoof = vendetta.plugin.storage.spoof ?? true; } catch { /* default on */ }

      console.warn("[nitro-bench] starting");

      unpatchAll = [patchPremium(), patchGates()];
      register();

      const { storage } = vendetta.plugin;
      try { storage.spoof = state.spoof; } catch { /* ok */ }

      console.log("[nitro-bench] loaded, premium spoof " + (state.spoof ? "on" : "off") + ", unlocked gates: " + state.unlocked.length);
    },
    onUnload() {
      unpatchAll.forEach((u) => { try { u(); } catch { /* teardown */ } });
      unpatchAll = [];
      unreg.forEach((u) => { try { u(); } catch { /* teardown */ } });
      unreg.length = 0;
      console.log("[nitro-bench] stopped");
    }
  };
})(vendetta);