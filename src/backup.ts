import { AttachmentBuilder, Client, Guild, PermissionFlagsBits, TextChannel } from "discord.js";
import { log } from "./logger.js";
import { Store } from "./store.js";

const BACKUP_CHANNEL_NAME = "gremio-bot-backup";

export class DiscordBackupService {
  private syncTimer: NodeJS.Timeout | null = null;
  private isRestoring = false;

  /**
   * Al arrancar el bot: si la base de datos local está vacía (por despliegue nuevo en Render),
   * busca la copia de seguridad guardada en Discord y restaura todos los streamers y ajustes.
   */
  async restoreIfEmpty(client: Client, store: Store): Promise<void> {
    const total = store.streamerCountAll();
    if (total > 0) {
      log(`ℹ️ Base de datos local activa (${total} streamers en seguimiento).`);
      return;
    }

    log("🔍 Base de datos vacía (posible nuevo despliegue de Render). Buscando copia de seguridad en Discord...");
    this.isRestoring = true;

    try {
      for (const guild of client.guilds.cache.values()) {
        const channel = await this.findBackupChannel(guild);
        if (!channel) continue;

        const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (!messages) continue;

        for (const msg of messages.values()) {
          const attachment = msg.attachments.find((a) => a.name.endsWith(".json"));
          if (attachment) {
            const res = await fetch(attachment.url).catch(() => null);
            if (res && res.ok) {
              const text = await res.text();
              if (store.importJson(text)) {
                log(`✅ ¡Restaurados ${store.streamerCountAll()} streamers desde la copia de seguridad en #${channel.name}!`);
                return;
              }
            }
          }
        }
      }
    } finally {
      this.isRestoring = false;
    }
  }

  /**
   * Programa una copia de seguridad en Discord (debounced) cuando se añade o modifica un streamer o ajuste.
   */
  scheduleBackup(client: Client, store: Store): void {
    if (this.isRestoring) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      void this.performBackup(client, store);
    }, 2000);
  }

  /**
   * Ejecuta el guardado inmediato en el canal privado de backup.
   */
  async performBackup(client: Client, store: Store): Promise<void> {
    if (this.isRestoring) return;
    const total = store.streamerCountAll();

    for (const guild of client.guilds.cache.values()) {
      try {
        let channel = await this.findBackupChannel(guild);
        if (!channel) {
          channel = await this.createBackupChannel(guild);
        }
        if (!channel) continue;

        const json = store.exportJson();
        const buffer = Buffer.from(json, "utf8");
        const file = new AttachmentBuilder(buffer, { name: "gremio-bot-backup.json" });

        // Limpiamos mensajes anteriores del bot en ese canal para no acumular basura
        const oldMessages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (oldMessages) {
          for (const old of oldMessages.values()) {
            if (old.author.id === client.user?.id) {
              await old.delete().catch(() => {});
            }
          }
        }

        await channel.send({
          content: `💾 **Copia de seguridad automática del Mensajero Estelar**\nStreamers vigilados: **${total}** · Fecha: <t:${Math.floor(Date.now() / 1000)}:F>\n*(Este archivo permite que tus streamers no se borren aunque Render se reinicie).*`,
          files: [file],
        });
        log(`💾 Copia de seguridad guardada en Discord (${guild.name} -> #${channel.name})`);
      } catch (e) {
        log(`⚠️ No pude guardar copia en ${guild.name}:`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  private async findBackupChannel(guild: Guild): Promise<TextChannel | null> {
    const found = guild.channels.cache.find(
      (c) => c.isTextBased() && !c.isThread() && c.name === BACKUP_CHANNEL_NAME,
    );
    if (found && found.isTextBased()) return found as TextChannel;
    return null;
  }

  private async createBackupChannel(guild: Guild): Promise<TextChannel | null> {
    try {
      const me = guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return null;
      }
      const created = await guild.channels.create({
        name: BACKUP_CHANNEL_NAME,
        topic: "Canal privado de copias de seguridad del bot de directos (no borrar para que sobreviva a reinicios)",
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
      });
      return created as TextChannel;
    } catch {
      return null;
    }
  }
}

export const backupService = new DiscordBackupService();
