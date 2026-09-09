import type { Platform, Streamer, StreamSnapshot, StreamState } from "../types.js";

export interface CheckResult {
  snapshot: StreamSnapshot;
  /** Parches que el monitor debe fusionar en el estado persistido */
  state?: Partial<StreamState>;
}

export interface PlatformAdapter {
  platform: Platform;
  /**
   * Valida el input del usuario y devuelve el canal canónico + nombre para mostrar.
   * Devuelve null si el canal no existe / la plataforma no está configurada.
   */
  resolve(input: string): Promise<{ channel: string; displayName: string } | null>;
  /** Comprueba el estado actual del streamer. */
  check(streamer: Streamer, state: StreamState): Promise<CheckResult>;
}