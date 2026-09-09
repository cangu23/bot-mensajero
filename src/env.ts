import "dotenv/config";

export const env = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
  GUILD_ID: process.env.GUILD_ID ?? null,
  TWITCH_CLIENT_ID: process.env.TWITCH_CLIENT_ID ?? null,
  TWITCH_CLIENT_SECRET: process.env.TWITCH_CLIENT_SECRET ?? null,
  POLL_INTERVAL_SECONDS: Number(process.env.POLL_INTERVAL_SECONDS ?? "60") || 60,
  DATA_FILE: process.env.DATA_FILE ?? "./data/store.db",
  WEB_PANEL_PASSWORD: process.env.WEB_PANEL_PASSWORD ?? "",
  WEB_PANEL_PORT: Number(process.env.WEB_PANEL_PORT ?? "3000") || 3000,
  WEB_PANEL_HOST: process.env.WEB_PANEL_HOST ?? "127.0.0.1",
  /** Dirección pública del panel (para el botón de /ms). Si está vacía, usa localhost */
  WEB_PANEL_URL: process.env.WEB_PANEL_URL ?? "",
};

/** URL que se muestra/abre desde Discord (el botón de /ms). */
export function panelUrl(): string {
  return env.WEB_PANEL_URL || `http://localhost:${env.WEB_PANEL_PORT}`;
}

/** Devuelve la lista de variables obligatorias que faltan. */
export function validateEnv(): string[] {
  const missing: string[] = [];
  if (!env.DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
  return missing;
}

export function twitchConfigured(): boolean {
  return Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
}