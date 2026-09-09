import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Guild, Message } from "discord.js";
import { log } from "./logger.js";
import { formatDuration, formatNumber, PLATFORM_COLOR, PLATFORM_EMOJI, PLATFORM_LABEL, platformUrl, replacePlaceholders, timeAgo } from "./util.js";
import type { GuildConfig, Streamer, StreamSnapshot, StreamState } from "./types.js";

const OFFLINE_COLOR = 0x2b2d31;

async function fetchNotifyChannel(guild: Guild, channelId: string | null) {
  if (!channelId) return null;
  try {
    const ch = await guild.channels.fetch(channelId);
    return ch && ch.isTextBased() ? ch : null;
  } catch {
    return null;
  }
}

export function buildLiveEmbed(streamer: Streamer, snap: StreamSnapshot): EmbedBuilder {
  const color = streamer.color ?? PLATFORM_COLOR[streamer.platform];
  const label = PLATFORM_LABEL[streamer.platform];
  const startTime = snap.startedAt ? new Date(snap.startedAt).getTime() : Date.now();
  const startUnix = Math.floor(startTime / 1000);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: `${streamer.displayName} está en directo`,
      iconURL: snap.avatarUrl ?? undefined,
      url: snap.url,
    })
    .setTitle(`${PLATFORM_EMOJI[streamer.platform]} ${snap.title || `${streamer.displayName} en ${label}`}`)
    .setURL(snap.url)
    .addFields(
      { name: "🎮 Categoría", value: snap.category ? `**${snap.category}**` : "—", inline: true },
      { name: "👀 Espectadores", value: `**${formatNumber(snap.viewers)}**`, inline: true },
      { name: "⏱ Empezó", value: `<t:${startUnix}:R>`, inline: true },
    )
    .setFooter({ text: `Gremio Estelar · ${label}` })
    .setTimestamp(new Date(startTime));

  if (snap.avatarUrl) embed.setThumbnail(snap.avatarUrl);
  const mainImage = snap.bannerUrl || snap.thumbnailUrl;
  if (mainImage) embed.setImage(mainImage);
  return embed;
}

export interface NotifyResult {
  message: Message;
  channelId: string;
}

/**
 * Envía el aviso de directo (ping + mensaje personalizado con placeholders + embed + botón).
 * Usa el canal propio del streamer si lo tiene; si no, el canal global del gremio.
 */
export async function notifyLive(
  guild: Guild,
  cfg: GuildConfig,
  streamer: Streamer,
  snap: StreamSnapshot,
): Promise<NotifyResult | null> {
  const channelId = streamer.notifyChannelId ?? cfg.notifyChannelId;
  const channel = await fetchNotifyChannel(guild, channelId);
  if (!channel) {
    log(`⚠️ ${guild.id}: sin canal de avisos para ${streamer.displayName}. Usa /config canal (global) o la opción anuncios al añadir.`);
    return null;
  }
  const parts: string[] = [];
  if (streamer.mentionRoleId) {
    if (streamer.mentionRoleId === "everyone" || streamer.mentionRoleId === guild.id) {
      parts.push("@everyone");
    } else if (streamer.mentionRoleId === "here") {
      parts.push("@here");
    } else {
      parts.push(`<@&${streamer.mentionRoleId}>`);
    }
  }
  if (streamer.message) {
    parts.push(replacePlaceholders(streamer.message, streamer, snap));
  } else {
    parts.push(`¡**${streamer.displayName}** ha comenzado un nuevo directo!`);
  }
  const content = parts.length ? parts.join(" ") : undefined;

  const label = PLATFORM_LABEL[streamer.platform];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`🔴 Ver directo en ${label}`)
      .setURL(snap.url),
  );

  try {
    const message = await channel.send({
      content,
      embeds: [buildLiveEmbed(streamer, snap)],
      components: [row],
    });
    return { message, channelId: channel.id };
  } catch (e) {
    log("⚠️ No pude enviar el aviso:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Edita el aviso anterior para marcarlo como finalizado con estadísticas de duración y pico de viewers. */
export async function markOffline(
  guild: Guild,
  _cfg: GuildConfig,
  streamer: Streamer,
  state: StreamState,
): Promise<void> {
  if (!state.notifyMessageId || !state.notifyChannelId) return;
  const channel = await fetchNotifyChannel(guild, state.notifyChannelId);
  if (!channel) return;
  try {
    const msg = await channel.messages.fetch(state.notifyMessageId);
    const label = PLATFORM_LABEL[streamer.platform];
    const channelLink = platformUrl(streamer.platform, streamer.channel);
    const prevThumbnail = msg.embeds[0]?.thumbnail?.url;

    const embed = new EmbedBuilder()
      .setColor(OFFLINE_COLOR)
      .setAuthor({
        name: `${streamer.displayName} · ${label}`,
        iconURL: prevThumbnail,
        url: channelLink,
      })
      .setTitle(`📴 Directo finalizado — ${streamer.displayName}`)
      .setURL(channelLink)
      .setFooter({ text: `Gremio Estelar · ${label}` })
      .setTimestamp(new Date());

    if (state.title) embed.setDescription(`*${state.title}*`);
    if (prevThumbnail) embed.setThumbnail(prevThumbnail);

    const fields = [
      { name: "📴 Estado", value: "🔴 Fuera de línea", inline: true },
    ];

    if (state.startedAt) {
      const unixStart = Math.floor(new Date(state.startedAt).getTime() / 1000);
      fields.push({
        name: "⏳ Duración",
        value: `**${formatDuration(state.startedAt)}**`,
        inline: true,
      });
      fields.push({
        name: "⏱ Empezó",
        value: `<t:${unixStart}:t> (<t:${unixStart}:R>)`,
        inline: true,
      });
    }

    if (state.peakViewers && state.peakViewers > 0) {
      fields.push({
        name: "👥 Pico de espectadores",
        value: `**${formatNumber(state.peakViewers)}**`,
        inline: true,
      });
    }

    embed.addFields(fields);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(`📺 Ver canal de ${streamer.displayName}`)
        .setURL(channelLink),
    );

    // Mensaje superior limpio: quita la mención activa de @here para no confundir
    const offlineContent = `🔴 *El directo de **${streamer.displayName}** ha finalizado.*`;

    await msg.edit({
      content: offlineContent,
      embeds: [embed],
      components: [row],
    });
  } catch (e) {
    log("⚠️ No pude marcar el aviso como finalizado:", e instanceof Error ? e.message : String(e));
  }
}