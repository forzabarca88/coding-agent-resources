import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Plays a gentle success tone when the agent finishes its work
 * and is ready for the user's next input.
 * Precomputed WAV buffer, cached player lookup, minimal I/O.
 */

// --- Cached at module scope: computed once, reused forever ---

// Precompute the WAV buffer once at load time (avoids per-call CPU/GC)
const WAV_BUFFER: Buffer = generateArpeggioWav();

// Cache the player lookup result (platform doesn't change during a session)
let cachedPlayer: { cmd: string; args: string[]; stdin: boolean } | null | undefined = undefined;

function getPlayer(): { cmd: string; args: string[]; stdin: boolean } | null {
  if (cachedPlayer !== undefined) return cachedPlayer;

  const isMac = process.platform === "darwin";
  if (isMac) {
    cachedPlayer = { cmd: "afplay", args: [], stdin: false };
    return cachedPlayer;
  }

  // On Linux/Unix — check PATH using fs.accessSync (no subprocess spawn)
  // stdin: true means the player accepts "-" to read from stdin
  const players: { cmd: string; args: string[]; stdin: boolean }[] = [
    { cmd: "pw-play", args: [""], stdin: true },
    { cmd: "paplay", args: [""], stdin: true },
    { cmd: "aplay", args: [], stdin: false },
    { cmd: "play", args: [], stdin: false },
    { cmd: "mpv", args: ["--no-video", "--no-terminal"], stdin: true },
    { cmd: "ffplay", args: ["-nodisp", "-autoexit"], stdin: true },
  ];

  const pathDirs = (process.env.PATH ?? "").split(":");
  cachedPlayer = null;

  for (const player of players) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, player.cmd);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        cachedPlayer = player;
        break;
      } catch {
        // Not in this dir, try next
      }
    }
    if (cachedPlayer) break;
  }

  return cachedPlayer;
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    try {
      if (!ctx?.hasUI) return;

      await playSuccessTone(ctx);
    } catch (error) {
      console.warn("Failed to play success tone:", error);
    }
  });
}

async function playSuccessTone(ctx: ExtensionContext) {
  try {
    const player = getPlayer();
    if (!player) {
      // Fallback to simple terminal beep
      if (ctx?.hasUI) {
        process.stdout.write("\u0007");
      }
      return;
    }

    if (player.stdin) {
      // Pipe WAV buffer directly via stdin — no disk I/O
      const proc = spawn(player.cmd, [...player.args, "-"], {
        stdio: ["pipe", "ignore", "ignore"],
      });

      proc.stdin.write(WAV_BUFFER);
      proc.stdin.end();
      proc.unref();

      // mpv/sox need explicit termination; others self-exit on EOF
      if (player.cmd === "mpv" || player.cmd === "play") {
        setTimeout(() => {
          try { proc.kill("SIGTERM"); } catch { /* already exited */ }
        }, 3000);
      }
    } else {
      // Player requires a file path — write to a single reused temp file
      // (overwrites in place, no allocation churn, no cleanup)
      const tempFile = getTempFile();
      await fs.promises.writeFile(tempFile, WAV_BUFFER);
      const proc = spawn(player.cmd, [...player.args, tempFile], {
        stdio: "ignore",
        detached: true,
      });
      proc.unref();
    }
  } catch (error) {
    console.warn("Failed to play success tone:", error);
  }

  // Subtle success notification
  if (ctx?.hasUI && ctx?.ui?.notify) {
    ctx.ui.notify("Ready!", "success");
  }
}

// Single temp file reused across all plays (avoids alloc churn + cleanup)
let cachedTempFile: string | undefined;
function getTempFile(): string {
  if (!cachedTempFile) {
    cachedTempFile = path.join(os.tmpdir(), "pi-success-tone.wav");
  }
  return cachedTempFile;
}

/**
 * Generates a ~0.8-second 16-bit Mono WAV file with a pleasant bell tone.
 * Uses 22050 Hz sample rate — sufficient for a notification tone while
 * cutting CPU and memory usage by ~50% vs 44100 Hz.
 */
function generateArpeggioWav(): Buffer {
  const sampleRate = 22050;
  const durationSeconds = 0.8;
  const numSamples = sampleRate * durationSeconds;

  const headerSize = 44;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  const partials = [
    { freq: 880.00, amplitude: 0.35, decay: 1.2 },
    { freq: 2433.0, amplitude: 0.20, decay: 0.6 },
    { freq: 4765.0, amplitude: 0.12, decay: 0.4 },
    { freq: 9590.0, amplitude: 0.06, decay: 0.2 },
    { freq: 1056.0, amplitude: 0.10, decay: 0.8 },
  ];

  const twoPi = 2 * Math.PI;

  for (let t = 0; t < numSamples; t++) {
    let sampleValue = 0;
    const time = t / sampleRate;

    let attackEnvelope = 1.0;
    if (time < 0.01) {
      attackEnvelope = (time / 0.01) * (time / 0.01);
    }

    for (const partial of partials) {
      const decayEnvelope = Math.exp(-time / partial.decay);
      const envelope = attackEnvelope * decayEnvelope;
      sampleValue += Math.sin(twoPi * partial.freq * time) * envelope * partial.amplitude;
    }

    if (sampleValue > 1) sampleValue = 1;
    if (sampleValue < -1) sampleValue = -1;

    buffer.writeInt16LE(Math.floor(sampleValue * 32767), headerSize + t * 2);
  }

  return buffer;
}
