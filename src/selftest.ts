import { env } from "./env.js";
import { kick } from "./platforms/kick.js";
import { twitch } from "./platforms/twitch.js";
import { youtube } from "./platforms/youtube.js";
import type { Streamer, StreamState } from "./types.js";

function dummyStreamer(channel: string, platform: "twitch" | "youtube" | "kick"): Streamer {
  return {
    id: `${platform}:${channel}`,
    platform,
    channel,
    displayName: channel,
    notifyChannelId: null,
    discordUserId: null,
    mentionRoleId: null,
    liveRoleId: null,
    offlineRoleId: null,
    color: null,
    message: null,
    enabled: true,
  };
}

function freshState(): StreamState {
  return {
    isLive: false,
    consecutiveOffline: 0,
    notifyMessageId: null,
    notifyChannelId: null,
    title: null,
    startedAt: null,
    lastVideoId: null,
    lastCheckedVideoId: null,
    activeHistoryId: null,
    peakViewers: 0,
  };
}

async function main(): Promise<void> {
  console.log("🧪 Auto-test de plataformas del bot\n");
  let failures = 0;

  // ── YouTube ──────────────────────────────────────────────
  const ytHandle = process.env.YT_TEST_CHANNEL ?? "mrbeast";
  try {
    const yt = await youtube.resolve(ytHandle);
    if (!yt) {
      console.log(`❌ YouTube: no se pudo resolver "${ytHandle}"`);
      failures++;
    } else {
      console.log(`✅ YouTube: "${yt.displayName}" (${yt.channel})`);
      const check = await youtube.check(dummyStreamer(yt.channel, "youtube"), freshState());
      if (!check.snapshot.ok) {
        console.log("   ⚠️ Comprobación sin respuesta (¿red bloqueada? no es un error del bot)");
      } else {
        console.log(`   ${check.snapshot.isLive ? "🔴 EN DIRECTO" : "⚪ No en directo"} · última comprobación OK`);
      }
    }
  } catch (e) {
    console.log("❌ YouTube:", e instanceof Error ? e.message : String(e));
    failures++;
  }

  // ── Kick ─────────────────────────────────────────────────
  const kickHandle = process.env.KICK_TEST_CHANNEL ?? "xqc";
  try {
    const k = await kick.resolve(kickHandle);
    if (!k) {
      console.log(`❌ Kick: no se pudo resolver "${kickHandle}" (¿API bloqueada, IP de datacenter o canal inexistente?)`);
      failures++;
    } else {
      console.log(`✅ Kick: "${k.displayName}" (${k.channel})`);
      const check = await kick.check(dummyStreamer(k.channel, "kick"), freshState());
      if (!check.snapshot.ok) {
        console.log("   ⚠️ Comprobación sin respuesta");
      } else {
        console.log(`   ${check.snapshot.isLive ? "🔴 EN DIRECTO" : "⚪ No en directo"} · última comprobación OK`);
      }
    }
  } catch (e) {
    console.log("❌ Kick:", e instanceof Error ? e.message : String(e));
    failures++;
  }

  // ── Twitch (solo si hay credenciales) ────────────────────
  if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) {
    try {
      const t = await twitch.resolve("shroud");
      if (!t) {
        console.log("❌ Twitch: no se pudo resolver \"shroud\" (¿credenciales válidas?)");
        failures++;
      } else {
        console.log(`✅ Twitch: "${t.displayName}" (${t.channel})`);
        const check = await twitch.check(dummyStreamer(t.channel, "twitch"), freshState());
        if (!check.snapshot.ok) {
          console.log("   ⚠️ Comprobación sin respuesta");
        } else {
          console.log(`   ${check.snapshot.isLive ? "🔴 EN DIRECTO" : "⚪ No en directo"} · última comprobación OK`);
        }
      }
    } catch (e) {
      console.log("❌ Twitch:", e instanceof Error ? e.message : String(e));
      failures++;
    }
  } else {
    console.log("ℹ️ Twitch: sin credenciales en .env, prueba omitida (configúralo con TWITCH_CLIENT_ID/SECRET)");
  }

  console.log(failures === 0 ? "\n🎉 Todo correcto" : `\n❌ ${failures} comprobación(es) fallida(s)`);
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});