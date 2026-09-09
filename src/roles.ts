import { Guild } from "discord.js";
import { log } from "./logger.js";
import type { GuildConfig, Streamer } from "./types.js";

async function getMember(guild: Guild, userId: string) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

export async function applyLive(guild: Guild, cfg: GuildConfig, streamer: Streamer): Promise<void> {
  if (!streamer.discordUserId) return;
  const member = await getMember(guild, streamer.discordUserId);
  if (!member) {
    log(`ℹ️ El usuario Discord ${streamer.discordUserId} no está en el servidor (¿/anadir sin vincular usuario?)`);
    return;
  }
  const liveRoleId = streamer.liveRoleId ?? cfg.liveRoleId;
  const offlineRoleId = streamer.offlineRoleId ?? cfg.offlineRoleId;
  if (liveRoleId) {
    await member.roles.add(liveRoleId).catch((e) =>
      log(`⚠️ No pude asignar el rol de directo: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
  if (offlineRoleId) {
    await member.roles.remove(offlineRoleId).catch((e) =>
      log(`⚠️ No pude quitar el rol offline: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

export async function applyOffline(guild: Guild, cfg: GuildConfig, streamer: Streamer): Promise<void> {
  if (!streamer.discordUserId) return;
  const member = await getMember(guild, streamer.discordUserId);
  if (!member) return;
  const liveRoleId = streamer.liveRoleId ?? cfg.liveRoleId;
  const offlineRoleId = streamer.offlineRoleId ?? cfg.offlineRoleId;
  if (liveRoleId) {
    await member.roles.remove(liveRoleId).catch((e) =>
      log(`⚠️ No pude quitar el rol de directo: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
  if (offlineRoleId) {
    await member.roles.add(offlineRoleId).catch((e) =>
      log(`⚠️ No pude asignar el rol offline: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}