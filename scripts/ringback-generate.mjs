// Writes public/sounds/ringback.wav: two seconds of the North American ringback tone (440 Hz plus 480 Hz),
// 8 kHz mono 16-bit PCM, the format Twilio plays without converting. The queue's waitUrl plays it, then
// pauses, so the caller hears a normal ringing cadence while the owner answers.
//   bun scripts/ringback-generate.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const RATE = 8000;
const SECONDS = 2;
const samples = RATE * SECONDS;
const data = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i++) {
  const t = i / RATE;
  // Short fades at both ends so the tone starts and stops without a click.
  const fade = Math.min(1, i / 80, (samples - i) / 80);
  const v = 0.25 * fade * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t));
  data.writeInt16LE(Math.round(v * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
mkdirSync("public/sounds", { recursive: true });
writeFileSync("public/sounds/ringback.wav", Buffer.concat([header, data]));
console.log("wrote public/sounds/ringback.wav");
