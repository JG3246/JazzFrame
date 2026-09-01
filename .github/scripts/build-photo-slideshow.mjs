// JazzEra photo-slideshow builder — runs in GitHub Actions.
//
// Turns an ordered folder of still photos into a slideshow video (crossfade
// between images, each shown for a set duration) and creates it as a real
// submission: uploads the video to Storage and inserts a submissions row
// with merge_status='pending', so the existing merge-videos workflow picks
// it up on its next run exactly like a visitor-uploaded video — no changes
// needed downstream.
//
// Source photos must already be uploaded to Storage under
// videos/<SCRATCH_PREFIX>/ (any admin can do this once per series). They are
// listed and sorted by filename, so use a naming scheme that sorts into the
// order you want the slideshow to play (sequential camera filenames work
// naturally; otherwise zero-pad a prefix number).
//
// Configuration is via environment variables (see build-photo-slideshow.yml)
// so a future series only needs new inputs, not a script change.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const SCRATCH_PREFIX = process.env.SCRATCH_PREFIX;          // e.g. "_scratch/day-in-the-garden"
const SESSION_ID = process.env.SESSION_ID || 'session_014';
const DUR = parseFloat(process.env.DURATION_PER_IMAGE || '3.5');   // seconds each image is on screen
const XF = parseFloat(process.env.CROSSFADE_DURATION || '0.8');   // seconds of overlap between images
const AUTHOR_NAME = process.env.AUTHOR_NAME || 'Admin';
const NOTE = process.env.NOTE || '';
const TRACK_TITLE = process.env.TRACK_TITLE || null;
const CLEANUP_SOURCE = (process.env.CLEANUP_SOURCE || 'true') === 'true';
const OUTPUT_SLUG = (process.env.OUTPUT_SLUG || 'slideshow').replace(/[^a-z0-9-]+/gi, '_');

if (!SUPABASE_URL || !KEY || !SCRATCH_PREFIX) {
  console.error('SUPABASE_URL, SUPABASE_KEY and SCRATCH_PREFIX are required');
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;
const STORAGE = `${SUPABASE_URL}/storage/v1`;
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function listScratchImages() {
  const res = await fetch(`${STORAGE}/object/list/videos`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: SCRATCH_PREFIX, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error(`list failed ${res.status}: ${await res.text()}`);
  const entries = await res.json();
  const images = entries
    .filter(e => /\.(jpe?g|png)$/i.test(e.name))
    .map(e => e.name)
    .sort();
  if (!images.length) throw new Error(`no images found under videos/${SCRATCH_PREFIX}/`);
  return images;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function patchOrInsertSubmission(body) {
  const res = await fetch(`${REST}/submissions`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`submission insert failed ${res.status}: ${await res.text()}`);
  return (await res.json())[0];
}

// Same watchdog pattern as merge-videos.mjs: hard timeout plus a stall
// detector on -progress output, since large filtergraphs are exactly the
// kind of ffmpeg run that's hung silently on this project before.
function runFfmpeg(label, args, { timeoutSec, stallSec = 180 }) {
  return new Promise((resolve, reject) => {
    const full = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats', ...args];
    console.log(`[${label}] ffmpeg ${full.join(' ')}`);
    const child = spawn('ffmpeg', full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '', outTimeSec = 0, lastAdvance = Date.now();
    child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    let buf = '';
    child.stdout.on('data', d => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m) { const t = Number(m[1]) / 1e6; if (t > outTimeSec + 0.5) { outTimeSec = t; lastAdvance = Date.now(); } }
      }
    });
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      const stalled = (Date.now() - lastAdvance) / 1000;
      console.log(`  [${label}] out_time=${outTimeSec.toFixed(1)}s elapsed=${Math.round(elapsed)}s`);
      if (elapsed > timeoutSec || stalled > stallSec) {
        clearInterval(timer);
        child.kill('SIGKILL');
        const why = elapsed > timeoutSec ? `timeout after ${Math.round(elapsed)}s` : `no progress for ${Math.round(stalled)}s`;
        reject(new Error(`[${label}] ${why}; stderr tail: ${stderrTail.trim().slice(-600) || '(empty)'}`));
      }
    }, 10000);
    child.on('error', err => { clearInterval(timer); reject(new Error(`[${label}] spawn failed: ${err.message}`)); });
    child.on('exit', code => {
      clearInterval(timer);
      if (code === 0) resolve(); else reject(new Error(`[${label}] ffmpeg exited ${code}; stderr tail: ${stderrTail.trim().slice(-600) || '(empty)'}`));
    });
  });
}

function buildSlideshowArgs(images, outFile) {
  const args = [];
  for (const img of images) args.push('-loop', '1', '-t', String(DUR), '-i', img);

  const filters = [];
  for (let i = 0; i < images.length; i++) {
    filters.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,fps=25[v${i}]`);
  }
  let prev = 'v0';
  for (let k = 1; k < images.length; k++) {
    const offset = (k * (DUR - XF)).toFixed(3);
    const out = k === images.length - 1 ? 'vout' : `vx${k}`;
    filters.push(`[${prev}][v${k}]xfade=transition=fade:duration=${XF}:offset=${offset}[${out}]`);
    prev = out;
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', outFile);
  return args;
}

const workdir = process.env.RUNNER_TEMP || '.';

const imageNames = await listScratchImages();
console.log(`${imageNames.length} source images found under videos/${SCRATCH_PREFIX}/:`);
imageNames.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));

const localPaths = [];
for (const name of imageNames) {
  const dest = path.join(workdir, `src_${localPaths.length}_${path.basename(name)}`);
  await download(`${STORAGE}/object/public/videos/${SCRATCH_PREFIX}/${name}`, dest);
  localPaths.push(dest);
}

const totalDur = imageNames.length * DUR - (imageNames.length - 1) * XF;
console.log(`Building slideshow: ${imageNames.length} images x ${DUR}s (${XF}s crossfade) = ${totalDur.toFixed(1)}s total`);

const outFile = path.join(workdir, `${OUTPUT_SLUG}.mp4`);
await runFfmpeg('slideshow build', buildSlideshowArgs(localPaths, outFile), { timeoutSec: 1800 });

const objectPath = `${SESSION_ID}/${Date.now()}_${OUTPUT_SLUG}.mp4`;
const up = await fetch(`${STORAGE}/object/videos/${objectPath}`, {
  method: 'POST',
  headers: { ...HEADERS, 'Content-Type': 'video/mp4', 'x-upsert': 'true', 'Cache-Control': '3600' },
  body: readFileSync(outFile),
});
if (!up.ok) throw new Error(`video upload failed ${up.status}: ${await up.text()}`);

const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/videos/${objectPath}`;
const sub = await patchOrInsertSubmission({
  session_id: SESSION_ID,
  author_name: AUTHOR_NAME,
  author_email: 'admin@jazzera.local',
  video_url: publicUrl,
  note: NOTE,
  track_title: TRACK_TITLE,
  votes: 0,
  merge_status: TRACK_TITLE ? 'pending' : null,
});
console.log(`Submission created: ${sub.id} -> ${publicUrl}`);

if (CLEANUP_SOURCE) {
  const del = await fetch(`${STORAGE}/object/videos`, {
    method: 'DELETE',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: imageNames.map(n => `${SCRATCH_PREFIX}/${n}`) }),
  });
  if (!del.ok) console.error(`scratch cleanup failed ${del.status}: ${await del.text()}`);
  else console.log(`Cleaned up ${imageNames.length} scratch source images.`);
}
