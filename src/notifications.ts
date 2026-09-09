import { EmbedBuilder, Guild, Message } from "discord.js";
import { log } from "./logger.js";
import { formatNumber, PLATFORM_COLOR, PLATFORM_EMOJI, PLATFORM_LABEL, platformUrl, timeAgo } from "./util.js";
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
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${PLATFORM_EMOJI[streamer.platform]} ${streamer.displayName} está EN DIRECTO en ${label}`)
    .setURL(snap.url)
    .addFields(
      { name: "🎮 Categoría", value: snap.category ?? "—", inline: true },
      { name: "👀 Espectadores", value: formatNumber(snap.viewers), inline: true },
      { name: "⏱ Empezó", value: timeAgo(snap.startedAt), inline: true },
    )
    .setFooter({ text: `Gremio Estelar · ${label}` });
  if (snap.title) embed.setDescription(snap.title);
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
 * Envía el aviso de directo (ping + mensaje personalizado + embed).
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
  if (streamer.message) parts.push(streamer.message);
  const content = parts.length ? parts.join(" ") : undefined;
  try {
    const message = await channel.send({ content, embeds: [buildLiveEmbed(streamer, snap)] });
    return { message, channelId: channel.id };
  } catch (e) {
    log("⚠️ No pude enviar el aviso:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Edita el aviso anterior para marcarlo como finalizado (queda como archivo). */
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
    const embed = new EmbedBuilder()
      .setColor(OFFLINE_COLOR)
      .setTitle(`${PLATFORM_EMOJI[streamer.platform]} ${streamer.displayName} — directo finalizado`)
      .setURL(platformUrl(streamer.platform, streamer.channel))
      .addFields({ name: "📴 Estado", value: "El directo ha terminado", inline: false })
      .setFooter({ text: `Gremio Estelar · ${label}` });
    if (state.title) embed.setDescription(state.title);
    if (state.startedAt) {
      embed.addFields({ name: "⏱ Empezó", value: timeAgo(state.startedAt), inline: true });
    }
    await msg.edit({ embeds: [embed] });
  } catch (e) {
    log("⚠️ No pude marcar el aviso como finalizado:", e instanceof Error ? e.message : String(e));
  }
}