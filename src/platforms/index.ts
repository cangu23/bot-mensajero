import type { Platform } from "../types.js";
import { kick } from "./kick.js";
import { twitch } from "./twitch.js";
import type { PlatformAdapter } from "./types.js";
import { youtube } from "./youtube.js";

export const adapters: Record<Platform, PlatformAdapter> = {
  twitch,
  youtube,
  kick,
};

export type { PlatformAdapter } from "./types.js";