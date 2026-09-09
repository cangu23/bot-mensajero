import { ActionRowBuilder, AutocompleteInteraction, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, Interaction, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { applyOffline } from "./roles.js";
import { env, panelUrl, twitchConfigured } from "./env.js";
import { log } from "./logger.js";
import { Monitor } from "./monitor.js";
import { adapters } from "./platforms/index.js";
import { Store } from "./store.js";
import { cleanHandle, detectPlatformFromInput, parseColor, PLATFORM_EMOJI, PLATFORM_LABEL, platformUrl, timeAgo } from "./util.js";
import { createPanelAuthToken } from "./web/server.js";
import type { GuildConfig, Platform, Streamer } from "./types.js";

const PLATFORM_CHOICES = [
  { name: "Twitch", value: "twitch" },
  { name: "YouTube", value: "youtube" },
  { name: "Kick", value: "kick" },
] as const;

const commandList = [
  new SlashCommandBuilder()
    .setName("ayuda")
    .setDescription("Guía rápida del bot y sus comandos"),
  new SlashCommandBuilder()
    .setName("anadir")
    .setDescription("Añadir un streamer para vigilar sus directos (pega la URL o el nombre)")
    .addStringOption((o) =>
      o.setName("canal")
        .setDescription("URL o nombre: twitch.tv/x · youtube.com/@x o UC… · kick.com/x")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("plataforma")
        .setDescription("Opcional: solo si no pegas una URL (twitch, youtube, kick)")
        .addChoices(...PLATFORM_CHOICES),
    )
    .addChannelOption((o) =>
      o.setName("anuncios")
        .setDescription("Canal donde anunciar a ESTE streamer (opcional; si no, el global de /config canal)")
        .addChannelTypes(ChannelType.GuildText),
    )
    .addUserOption((o) => o.setName("usuario").setDescription("Usuario de Discord que recibirá el rol de directo"))
    .addRoleOption((o) => o.setName("rol").setDescription("Rol al que se pinguea al anunciar el directo"))
    .addRoleOption((o) => o.setName("rol-live").setDescription("Rol 'en directo' solo para este streamer (override)"))
    .addRoleOption((o) => o.setName("rol-offline").setDescription("Rol 'fuera de directo' solo para este streamer (override)"))
    .addStringOption((o) => o.setName("color").setDescription("Color del embed en hexadecimal, ej. #9146FF"))
    .addStringOption((o) => o.setName("mensaje").setDescription("Mensaje personalizado que acompaña al aviso")),
  new SlashCommandBuilder()
    .setName("quitar")
    .setDescription("Dejar de vigilar un streamer (elígelo de la lista)")
    .addStringOption((o) =>
      o.setName("streamer").setDescription("Streamer a dejar de vigilar").setAutocomplete(true).setRequired(true),
    ),
  new SlashCommandBuilder().setName("lista").setDescription("Ver los streamers vigilados y su estado"),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configuración del gremio")
    .addSubcommand((s) =>
      s
        .setName("canal")
        .setDescription("Canal donde se publican los avisos de directo")
        .addChannelOption((o) =>
          o.setName("canal").setDescription("Canal de texto").setRequired(true).addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("rol-live")
        .setDescription("Rol global asignado a los streamers en directo")
        .addRoleOption((o) => o.setName("rol").setDescription("El rol (opcional si usas quitar)"))
        .addBooleanOption((o) => o.setName("quitar").setDescription("Quitar el rol configurado")),
    )
    .addSubcommand((s) =>
      s
        .setName("rol-offline")
        .setDescription("Rol global asignado cuando termina el directo")
        .addRoleOption((o) => o.setName("rol").setDescription("El rol (opcional si usas quitar)"))
        .addBooleanOption((o) => o.setName("quitar").setDescription("Quitar el rol configurado")),
    )
    .addSubcommand((s) => s.setName("ver").setDescription("Ver la configuración actual")),
  new SlashCommandBuilder().setName("comprobar").setDescription("Forzar una comprobación de todos los streamers ahora"),
  new SlashCommandBuilder().setName("estado").setDescription("Estado del bot y de las plataformas"),
  new SlashCommandBuilder().setName("ms").setDescription("Abrir el panel de gestión del gremio"),
  new SlashCommandBuilder().setName("panel").setDescription("Abrir el panel de gestión (alias de /ms)"),
];

export async function registerCommands(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await registerCommandsForGuild(guild);
  }
}

export async function registerCommandsForGuild(guild: import("discord.js").Guild): Promise<void> {
  await guild.commands.set(commandList.map((c) => c.toJSON()));
}

function isAdmin(interaction: Interaction): boolean {
  if (!interaction.inGuild() || !interaction.memberPermissions) return false;
  return (
    interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
  );
}

async function handleAutocomplete(interaction: AutocompleteInteraction, store: Store): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const query = interaction.options.getFocused().toString().toLowerCase();
  const cfg = store.getGuild(interaction.guildId);
  const options = cfg.streamers
    .filter(
      (s) =>
        !query ||
        s.displayName.toLowerCase().includes(query) ||
        s.channel.toLowerCase().includes(query) ||
        PLATFORM_LABEL[s.platform].toLowerCase().includes(query),
    )
    .slice(0, 25)
    .map((s) => ({
      name: `${PLATFORM_EMOJI[s.platform]} ${s.displayName} · ${PLATFORM_LABEL[s.platform]}${s.enabled ? "" : " (pausado)"}`,
      value: s.id,
    }));
  await interaction.respond(options);
}

export function createHandler(client: Client, store: Store, monitor: Monitor) {
  return async function onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      try {
        await handleAutocomplete(interaction, store);
      } catch (e) {
        log("⚠️ Error en autocompletado:", e instanceof Error ? e.message : String(e));
        await interaction.respond([]).catch(() => {});
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
      await runCommand(interaction, store, monitor);
    } catch (e) {
      log("❌ Error en comando:", e instanceof Error ? e.stack ?? e.message : String(e));
      if (!interaction.replied) {
        await interaction.reply({ content: "❌ Algo falló. Revisa los logs del bot.", ephemeral: true }).catch(() => {});
      }
    }
  };
}

async function runCommand(interaction: Interaction, store: Store, monitor: Monitor): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: "Este bot solo funciona dentro de servidores.", ephemeral: true });
    return;
  }
  const name = interaction.commandName;
  if (name !== "ayuda" && !isAdmin(interaction)) {
    await interaction.reply({
      content: "🔒 Necesitas permiso **Gestionar servidor** o **Administrador** para usar este comando.",
      ephemeral: true,
    });
    return;
  }

  switch (name) {
    case "ayuda":
      return cmdAyuda(interaction);
    case "anadir":
      return cmdAdd(interaction, store);
    case "quitar":
      return cmdRemove(interaction, store);
    case "lista":
      return cmdList(interaction, store);
    case "config":
      return cmdConfig(interaction, store);
    case "comprobar":
      return cmdCheck(interaction, monitor);
    case "estado":
      return cmdStatus(interaction, store, monitor);
    case "ms":
    case "panel":
      return cmdPanel(interaction);
    default:
      return;
  }
}

async function cmdAyuda(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🌟 Gremio Estelar · Bot de directos")
    .setDescription(
      "Vigila los directos de **Twitch**, **YouTube** y **Kick** y avisa en el canal del gremio con embed personalizable, ping por rol y roles de directo.",
    )
    .addFields(
      { name: "🚀 Primeros pasos", value: "1. `/config canal` → dónde se publican los avisos\n2. `/config rol-live` → rol que se asigna en directo (opcional)\n3. `/anadir canal:https://twitch.tv/mi_canal` → empieza a vigilar" },
      { name: "➕ /anadir", value: "Pega la **URL del canal** o el nombre; la plataforma se detecta sola. Opciones extra: `anuncios` (canal propio), `usuario`, `rol`, `color`, `mensaje`, `rol-live`/`rol-offline`." },
      { name: "➖ /quitar", value: "Escribe `/quitar` y **elige el streamer de la lista** (autocompletado)." },
      { name: "📋 /lista", value: "Muestra los streamers vigilados y quién está en directo." },
      { name: "⚙️ /config", value: "Subcomandos: `canal`, `rol-live`, `rol-offline`, `ver`." },
      { name: "🔍 /comprobar", value: "Fuerza una comprobación inmediata de todos los streamers." },
      { name: "🩺 /estado", value: "Salud del bot y configuración de cada plataforma." },
      { name: "🛠 /ms (o /panel)", value: "Abre el panel de gestión: aquí se hace TODO (añadir/quitar streamers, canales de aviso, roles, historial)." },
    )
    .setFooter({ text: "Solo admins pueden configurar. ¡Que empiece el directo! 🎬" });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function cmdAdd(interaction: Interaction, store: Store): Promise<void> {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  const raw = interaction.options.getString("canal", true);
  const explicitPlatform = interaction.options.getString("plataforma") as Platform | null;
  // Si hay URL, la plataforma se detecta sola; la opción explícita es solo para nombres sueltos
  const platform = detectPlatformFromInput(raw) ?? explicitPlatform;
  if (!platform || !["twitch", "youtube", "kick"].includes(platform)) {
    await interaction.reply({
      content: `❌ No pude detectar la plataforma de **${raw}**.
Pega la URL del canal (ej. https://twitch.tv/shroud, https://www.youtube.com/@x, https://kick.com/x) o elige la plataforma con la opción **plataforma**.`,
      ephemeral: true,
    });
    return;
  }
  const input = cleanHandle(raw, platform);

  if (platform === "twitch" && !twitchConfigured()) {
    await interaction.reply({
      content:
        "❌ **Twitch no está configurado.** Añade `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET` a `.env` (crea una app en https://dev.twitch.tv/console/apps) y reinicia el bot.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const adapter = adapters[platform];
  const resolved = await adapter.resolve(input);
  if (!resolved) {
    await interaction.editReply({
      content: `❌ No encontré el canal **${input}** en ${PLATFORM_LABEL[platform]}. Revisa que el nombre esté bien escrito.`,
    });
    return;
  }

  const streamerId = `${platform}:${resolved.channel}`;
  const cfg = store.getGuild(interaction.guildId);
  if (cfg.streamers.some((s) => s.id === streamerId)) {
    await interaction.editReply({ content: `⚠️ **${resolved.displayName}** ya está vigilado.` });
    return;
  }

  const colorRaw = interaction.options.getString("color");
  const color = parseColor(colorRaw);
  if (colorRaw && color === null) {
    await interaction.editReply({ content: `❌ Color **"${colorRaw}"** no válido. Usa formato hexadecimal, ej. #9146FF.` });
    return;
  }

  const streamer: Streamer = {
    id: streamerId,
    platform,
    channel: resolved.channel,
    displayName: resolved.displayName,
    notifyChannelId: interaction.options.getChannel("anuncios")?.id ?? null,
    discordUserId: interaction.options.getUser("usuario")?.id ?? null,
    mentionRoleId: interaction.options.getRole("rol")?.id ?? null,
    liveRoleId: interaction.options.getRole("rol-live")?.id ?? null,
    offlineRoleId: interaction.options.getRole("rol-offline")?.id ?? null,
    color,
    message: interaction.options.getString("mensaje"),
    enabled: true,
  };
  store.addStreamer(interaction.guildId, streamer);

  const extras: string[] = [];
  if (streamer.discordUserId) extras.push(`🎭 Usuario de rol: <@${streamer.discordUserId}>`);
  if (streamer.mentionRoleId) extras.push(`📢 Ping: <@&${streamer.mentionRoleId}>`);
  const warning = cfg.notifyChannelId ? "" : "\n⚠️ **Aún no hay canal de avisos:** usa `/config canal` para elegir dónde se publican.";

  await interaction.editReply({
    content:
      `✅ **${resolved.displayName}** (${PLATFORM_EMOJI[platform]} ${PLATFORM_LABEL[platform]}) ahora está vigilado.\n🔗 ${platformUrl(platform, resolved.channel)}` +
      (extras.length ? `\n${extras.join("\n")}` : "") +
      warning,
  });
}

/** Busca un streamer por id, URL, canal o nombre para mostrar (en cualquier plataforma). */
function findStreamerByInput(cfg: GuildConfig, input: string): Streamer | undefined {
  const direct = cfg.streamers.find((s) => s.id === input);
  if (direct) return direct;
  const platform = detectPlatformFromInput(input);
  if (platform) {
    const cleaned = cleanHandle(input, platform);
    return (
      cfg.streamers.find((s) => s.id === `${platform}:${cleaned}`) ??
      cfg.streamers.find((s) => s.platform === platform && (s.channel === cleaned || s.displayName.toLowerCase() === cleaned.toLowerCase()))
    );
  }
  const cleaned = input.trim().toLowerCase().replace(/^@/, "");
  return cfg.streamers.find((s) => s.channel === cleaned || s.displayName.toLowerCase() === cleaned);
}

async function cmdRemove(interaction: Interaction, store: Store): Promise<void> {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  const raw = interaction.options.getString("streamer", true).trim();
  const cfg = store.getGuild(interaction.guildId);
  const streamer = findStreamerByInput(cfg, raw);

  if (!streamer) {
    await interaction.reply({
      content: `❌ No encontré **${raw}** entre los vigilados. Prueba con /lista para verlos todos.`,
      ephemeral: true,
    });
    return;
  }

  const removed = store.removeStreamer(interaction.guildId, streamer.id);
  if (!removed) {
    await interaction.reply({ content: "❌ No se pudo eliminar el streamer.", ephemeral: true });
    return;
  }
  // Si estaba en directo, cerramos la entrada de historial y quitamos roles
  const st = store.getState(streamer.id);
  if (st.isLive) {
    store.finalizeHistory(st.activeHistoryId ?? "", new Date().toISOString(), st.peakViewers ?? 0);
    st.isLive = false;
    st.activeHistoryId = null;
    store.setState(streamer.id, st);
    if (interaction.guild && streamer.discordUserId) {
      await applyOffline(interaction.guild, store.getGuild(interaction.guildId), streamer);
    }
  }
  await interaction.reply({ content: `🗑 **${streamer.displayName}** ya no está vigilado.`, ephemeral: true });
}

async function cmdList(interaction: Interaction, store: Store): Promise<void> {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  const cfg = store.getGuild(interaction.guildId);
  if (cfg.streamers.length === 0) {
    await interaction.reply({ content: "📭 No hay streamers vigilados. Añade uno con `/anadir`.", ephemeral: true });
    return;
  }
  const lines = cfg.streamers.map((s, i) => {
    const st = store.getState(s.id);
    const live = st.isLive ? "🔴 **EN DIRECTO**" : "⚪ fuera";
    const discord = s.discordUserId ? `<@${s.discordUserId}>` : "—";
    const ping = s.mentionRoleId ? `<@&${s.mentionRoleId}>` : "—";
    return `${i + 1}. ${PLATFORM_EMOJI[s.platform]} **${s.displayName}** (${PLATFORM_LABEL[s.platform]}) · ${live}\n   Usuario: ${discord} · Ping: ${ping}`;
  });
  await interaction.reply({ content: `📋 **Streamers vigilados (${cfg.streamers.length})**\n\n${lines.join("\n")}`, ephemeral: true });
}

async function cmdConfig(interaction: Interaction, store: Store): Promise<void> {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  const cfg = store.getGuild(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === "canal") {
    const channel = interaction.options.getChannel("canal", true);
    if (!("isTextBased" in channel) || !channel.isTextBased()) {
      await interaction.reply({ content: "❌ Ese canal no es de texto.", ephemeral: true });
      return;
    }
    cfg.notifyChannelId = channel.id;
    store.persist();
    await interaction.reply({ content: `✅ Los avisos se publicarán en <#${channel.id}>.`, ephemeral: true });
    return;
  }

  if (sub === "rol-live" || sub === "rol-offline") {
    const quitar = interaction.options.getBoolean("quitar") ?? false;
    const role = interaction.options.getRole("rol");
    if (quitar || !role) {
      if (sub === "rol-live") cfg.liveRoleId = null;
      else cfg.offlineRoleId = null;
      store.persist();
      await interaction.reply({ content: `✅ Rol **${sub === "rol-live" ? "en directo" : "fuera de directo"}** desconfigurado.`, ephemeral: true });
      return;
    }
    if (sub === "rol-live") cfg.liveRoleId = role.id;
    else cfg.offlineRoleId = role.id;
    store.persist();
    await interaction.reply({ content: `✅ Rol **${sub === "rol-live" ? "en directo" : "fuera de directo"}**: <@&${role.id}>.`, ephemeral: true });
    return;
  }

  if (sub === "ver") {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("⚙️ Configuración del gremio")
      .addFields(
        { name: "📢 Canal de avisos", value: cfg.notifyChannelId ? `<#${cfg.notifyChannelId}>` : "— (usa /config canal)", inline: true },
        { name: "🟢 Rol en directo", value: cfg.liveRoleId ? `<@&${cfg.liveRoleId}>` : "—", inline: true },
        { name: "⚪ Rol fuera de directo", value: cfg.offlineRoleId ? `<@&${cfg.offlineRoleId}>` : "—", inline: true },
        { name: "👀 Streamers vigilados", value: `${cfg.streamers.length}`, inline: true },
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  await interaction.reply({ content: "Subcomando desconocido.", ephemeral: true });
}

async function cmdCheck(interaction: Interaction, monitor: Monitor): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ ephemeral: true });
  const summary = await monitor.pollOnce();
  const liveList = summary.liveNames.length ? `\n🔴 En directo ahora: ${summary.liveNames.join(", ")}` : "";
  await interaction.editReply({
    content:
      `🔍 **Comprobación completada**\n` +
      `✅ En directo: ${summary.live} · 📴 Fuera: ${summary.offline} · ⏭ Sin respuesta: ${summary.skipped} · ❌ Errores: ${summary.errors}` +
      liveList,
  });
}

async function cmdPanel(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const base = panelUrl();
  const token = createPanelAuthToken();
  const directUrl = `${base}${base.includes("?") ? "&" : "?"}auth=${token}`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🛠 Panel de gestión · Gremio Estelar")
    .setDescription(
      "Aquí se hace **todo** sin comandos:\n" +
        "• Añadir/quitar streamers (también en lote, pegando URLs)\n" +
        "• Elegir el canal global de avisos y el canal propio de cada streamer\n" +
        "• Roles live/offline, pings, colores y mensajes por streamer\n" +
        "• Historial de directos y comprobaciones manuales\n\n" +
        "⚡ **Acceso con 1 clic**: Usa el botón de abajo para entrar directamente al panel sin tener que escribir la contraseña.",
    )
    .addFields(
      { name: "🔗 Enlace del panel", value: base },
      {
        name: "🔑 Contraseña del panel",
        value: env.WEB_PANEL_PASSWORD
          ? `||${env.WEB_PANEL_PASSWORD}|| *(toca para revelar)*`
          : "*(Sin contraseña requerida)*",
      },
    )
    .setFooter({ text: "Solo administradores · Este mensaje es efímero (solo tú lo ves)" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("🌐 Abrir el panel (Acceso directo)").setURL(directUrl),
  );
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function cmdStatus(interaction: Interaction, store: Store, monitor: Monitor): Promise<void> {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  const client = interaction.client;
  const uptime = client.readyAt ? timeAgo(client.readyAt.toISOString()) : "—";
  const lastPoll = monitor.lastPollAt ? timeAgo(monitor.lastPollAt.toISOString()) : "nunca";
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("🩺 Estado del bot")
    .addFields(
      { name: "🤖 Conexión", value: `🟢 Online · ${uptime}`, inline: true },
      { name: "⏱ Última comprobación", value: lastPoll, inline: true },
      { name: "👀 Streamers vigilados", value: `${store.streamerCount(interaction.guildId)}`, inline: true },
      { name: "🟣 Twitch", value: twitchConfigured() ? "configurado ✅" : "no configurado ❌", inline: true },
      { name: "🔴 YouTube", value: "RSS público ✅", inline: true },
      { name: "🟢 Kick", value: "API pública ✅", inline: true },
    );
  await interaction.reply({ embeds: [embed], ephemeral: true });
}