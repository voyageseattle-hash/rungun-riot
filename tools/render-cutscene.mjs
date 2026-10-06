#!/usr/bin/env node
// Render an in-engine cutscene (CUTSCENE in index.html) to an MP4.
//
//   node tools/render-cutscene.mjs [scene] [--fps 30] [--size 1920x1080] [--out out/opening-1080p.mp4]
//
// Video: headless Chromium loads the game, calls CUTSCENE.renderAt(scene, t)
// for every frame and pipes the frames to ffmpeg, so the frames are exact
// regardless of machine speed. Audio: the scene's music bed and cue table
// are mixed offline by ffmpeg from the same assets/ files the game plays.
// Needs ffmpeg on PATH and the `playwright` package (npm i -D playwright).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : dflt; };
const scene = args[0] && !args[0].startsWith("--") ? args[0] : "opening";
const fps = Number(flag("fps", 30));
const [OW, OH] = flag("size", "1920x1080").split("x").map(Number);
const out = path.resolve(ROOT, flag("out", `out/${scene}-${OH}p.mp4`));
const MUSIC_VOL = 0.55, SFX_VOL = 0.85;   // match the in-game music BASE / SFX bus trims

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req("playwright"); } catch {}
  const globalRoot = execFileSync("npm", ["root", "-g"]).toString().trim();
  return req(path.join(globalRoot, "playwright"));
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".json": "application/json", ".css": "text/css" };
function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

function audioArgs(info) {
  const inputs = [], filters = [], labels = [];
  const add = (file) => { inputs.push("-i", file); return inputs.length / 2; };   // index 0 is the video pipe
  if (info.music) {
    const file = path.join(ROOT, "assets", `music_${info.music}.mp3`);
    if (fs.existsSync(file)) {
      const i = add(file);
      filters.push(`[${i}:a]atrim=0:${info.dur},afade=t=in:d=0.8,afade=t=out:st=${info.dur - 2}:d=2,volume=${MUSIC_VOL}[m]`);
      labels.push("[m]");
    }
  }
  info.cues.forEach((c, n) => {
    const file = path.join(ROOT, "assets", `sfx_${c.sfx}.mp3`);
    if (!fs.existsSync(file)) return;
    const i = add(file), p = c.pitch || 1, ms = Math.round(c.t * 1000);
    // playbackRate semantics: pitch and speed move together, as in the game
    const rate = p === 1 ? "" : `asetrate=44100*${p},aresample=44100,`;
    filters.push(`[${i}:a]aresample=44100,${rate}volume=${(c.vol ?? 0.5) * SFX_VOL},adelay=${ms}|${ms}[c${n}]`);
    labels.push(`[c${n}]`);
  });
  if (!labels.length) return { inputs, map: [] };
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,atrim=0:${info.dur},alimiter=limit=0.89[aout]`);
  return { inputs, map: ["-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k"] };
}

const server = await serve();
const { chromium } = loadPlaywright();
const browser = await chromium.launch(fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: undefined } : {});
try {
  const page = await browser.newPage({ viewport: { width: OW, height: OH } });
  page.on("pageerror", e => console.error("[page]", e.message));
  const { port } = server.address();
  await page.goto(`http://127.0.0.1:${port}/index.html?cutscene=${scene}&export=1`, { waitUntil: "load" });
  await page.waitForFunction(() => typeof CUTSCENE !== "undefined");
  const info = await page.evaluate(async id => { await CUTSCENE.ready(id); return CUTSCENE.info(id); }, scene);
  if (!info) throw new Error(`unknown scene "${scene}"`);
  const total = Math.round(info.dur * fps);
  console.log(`${info.title}: ${info.dur}s, ${total} frames @ ${fps}fps, ${OW}x${OH} → ${path.relative(ROOT, out)}`);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const audio = audioArgs(info);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    ...audio.inputs, ...audio.map,
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => ff.on("close", code => code ? rej(new Error("ffmpeg exited " + code)) : res()));

  for (let f = 0; f < total; f++) {
    const b64 = await page.evaluate(([id, t, w, h]) => {
      CUTSCENE.renderAt(id, t, w, h);
      return document.querySelector("#cutsceneScreen canvas").toDataURL("image/jpeg", 0.95).split(",")[1];
    }, [scene, f / fps, OW, OH]);
    if (!ff.stdin.write(Buffer.from(b64, "base64"))) await new Promise(r => ff.stdin.once("drain", r));
    if (f % fps === 0) process.stdout.write(`\r  ${Math.round(f / fps)}s / ${info.dur}s`);
  }
  ff.stdin.end();
  await done;
  console.log(`\r  done: ${path.relative(ROOT, out)}`);
} finally {
  await browser.close();
  server.close();
}
