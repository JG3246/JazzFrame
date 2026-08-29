// JazzEra merge worker — runs in GitHub Actions.
// Finds submissions that chose a track but have no merged video yet,
// blends the track's audio into the video with ffmpeg, uploads the
// result to Supabase Storage, and records the URL on the row.
//
// Duration rule:
//   video >= track  → video plays once; track ends underneath (output = video length)
//   video <  track  → whole video (visuals + its own sound) loops until the
//                     track finishes, last repeat cut short (output = track length)
//
// Audio balance: track is loudness-normalised to -14 LUFS (dominant); the
// video's own sound to -25 LUFS (present but secondary, never removed).
//
// The work is split into single-purpose ffmpeg passes (normalise track,
// normalise looped video sound, mix the two, then video encode muxing the
// finished audio) — loudnorm feeding amix inside one filtergraph deadlocks
// silently. Each pass runs under a watchdog and reports a heartbeat
// (stage + progress) into the row's merge_error column so progress is
// observable from the database without GitHub log access.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_KEY not set'); process.exit(1); }

const REST = `${SUPABASE_URL}/rest/v1`;
const STORAGE = `${SUPABASE_URL}/storage/v1`;
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const TRACKS = JSON.parse(readFileSync(new URL('./tracks.json', import.meta.url), 'utf8'));

const BED = 'loudnorm=I=-25:TP=-2:LRA=11';    // visitor's own sound, underneath
const TRK = 'loudnorm=I=-14:TP=-1.5:LRA=11';  // jazz track, dominant
const MIX = 'amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=false';

function ffprobe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type:format=duration',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  const info = JSON.parse(out);
  return {
    duration: parseFloat(info.format.duration),
    hasAudio: (info.streams || []).some(s => s.codec_type === 'audio'),
  };
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function patchRow(id, body) {
  const res = await fetch(`${REST}/submissions?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`row update failed ${res.status}: ${await res.text()}`);
}

async function resolveTrack(title, workdir) {
  const entry = TRACKS[title];
  if (!entry) throw new Error(`no track mapping for title: ${title}`);
  if (entry.repo) {
    const p = path.join(process.env.GITHUB_WORKSPACE || '.', entry.repo);
    if (!existsSync(p)) throw new Error(`track file missing in repo: ${entry.repo}`);
    return p;
  }
  const dest = path.join(workdir, 'track_audio');
  await download(entry.url, dest);
  return dest;
}

// Run ffmpeg with a hard watchdog. Parses -progress output for a heartbeat,
// keeps the tail of stderr for diagnostics. Rejects on timeout, non-zero
// exit, or stall (no progress advance for stallSec).
function runFfmpeg(label, args, { timeoutSec, stallSec = 300, onProgress }) {
  return new Promise((resolve, reject) => {
    const full = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'warning',
      '-progress', 'pipe:1', '-nostats', ...args];
    console.log(`  [${label}] ffmpeg ${full.join(' ')}`);
    const child = spawn('ffmpeg', full, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrTail = '';
    let outTimeSec = 0;
    let lastAdvance = Date.now();

    child.stderr.on('data', d => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    let buf = '';
    child.stdout.on('data', d => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m) {
          const t = Number(m[1]) / 1e6;
          if (t > outTimeSec + 0.5) { outTimeSec = t; lastAdvance = Date.now(); }
        }
      }
    });

    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      const stalled = (Date.now() - lastAdvance) / 1000;
      onProgress?.(label, outTimeSec, elapsed);
      if (elapsed > timeoutSec || stalled > stallSec) {
        clearInterval(timer);
        child.kill('SIGKILL');
        const why = elapsed > timeoutSec ? `timeout after ${Math.round(elapsed)}s` : `no progress for ${Math.round(stalled)}s`;
        reject(new Error(`[${label}] ${why} at out_time=${outTimeSec.toFixed(1)}s; stderr tail: ${stderrTail.trim().slice(-600) || '(empty)'}`));
      }
    }, 10000);

    child.on('error', err => { clearInterval(timer); reject(new Error(`[${label}] spawn failed: ${err.message}`)); });
    child.on('exit', code => {
      clearInterval(timer);
      if (code === 0) resolve();
      else reject(new Error(`[${label}] ffmpeg exited ${code}; stderr tail: ${stderrTail.trim().slice(-600) || '(empty)'}`));
    });
  });
}

async function processSubmission(sub, workdir) {
  console.log(`processing submission ${sub.id} (track: ${sub.track_title})`);

  // Heartbeat into the row: stage + progress, throttled to ~20s.
  let lastBeat = 0;
  let stage = 'starting';
  const beat = async (detail) => {
    const now = Date.now();
    if (now - lastBeat < 20000) return;
    lastBeat = now;
    try { await patchRow(sub.id, { merge_error: `[worker ${new Date().toISOString()}] ${detail}` }); } catch { /* heartbeat only */ }
  };
  const onProgress = (label, t, elapsed) => {
    stage = label;
    console.log(`  [${label}] out_time=${t.toFixed(1)}s elapsed=${Math.round(elapsed)}s`);
    beat(`${label}: encoded ${t.toFixed(1)}s (running ${Math.round(elapsed)}s)`);
  };

  await patchRow(sub.id, { merge_status: 'processing', merge_error: '[worker] claimed' });

  stage = 'download video';
  await beat('downloading video');
  const videoFile = path.join(workdir, `input_${sub.id}`);
  await download(sub.video_url, videoFile);
  const trackFile = await resolveTrack(sub.track_title, workdir);

  const video = ffprobe(videoFile);
  const track = ffprobe(trackFile);
  if (!video.duration || !track.duration) throw new Error('could not read durations');
  const loop = video.duration < track.duration;
  const outDur = loop ? track.duration : video.duration;
  const plays = loop ? Math.ceil(track.duration / video.duration) : 1;
  console.log(`  video ${video.duration.toFixed(1)}s (audio: ${video.hasAudio}), track ${track.duration.toFixed(1)}s → ${loop ? `loop x${plays} to track length` : 'single pass, video length'}`);

  // Looping uses the concat demuxer (a plain repeat-list), the most robust
  // way to repeat a clip — no -stream_loop, which proved hang-prone here.
  let loopedInput = ['-i', videoFile];
  if (loop) {
    const listFile = path.join(workdir, `list_${sub.id}.txt`);
    writeFileSync(listFile, `file '${videoFile.replace(/'/g, "'\\''")}'\n`.repeat(plays));
    loopedInput = ['-f', 'concat', '-safe', '0', '-i', listFile];
  }

  // Audio passes. Kept deliberately separate — loudnorm feeding amix inside
  // one filtergraph deadlocks (silent stall ~3s before the mp3 ends), so each
  // step is its own single-purpose ffmpeg run. -vn strips the cover-art image
  // stream some mp3s embed.

  // Pass 1a — normalise the jazz track (dominant level).
  const trkNorm = path.join(workdir, `trk_${sub.id}.m4a`);
  await runFfmpeg('track normalise', [
    '-i', trackFile, '-vn', '-af', TRK,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', trkNorm,
  ], { timeoutSec: 300, stallSec: 120, onProgress });

  let mixFile = trkNorm;
  if (video.hasAudio) {
    // Pass 1b — normalise the video's own (looped) sound at the bed level.
    const bedNorm = path.join(workdir, `bed_${sub.id}.m4a`);
    await runFfmpeg('bed normalise', [
      ...loopedInput, '-vn', '-af', BED, '-t', String(outDur),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', bedNorm,
    ], { timeoutSec: 600, stallSec: 120, onProgress });

    // Pass 1c — mix the two pre-normalised files, track dominant by construction.
    mixFile = path.join(workdir, `mix_${sub.id}.m4a`);
    await runFfmpeg('audio mix', [
      '-i', bedNorm, '-i', trkNorm,
      '-filter_complex', `[0:a][1:a]${MIX}[aout]`, '-map', '[aout]',
      '-t', String(outDur), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', mixFile,
    ], { timeoutSec: 300, stallSec: 120, onProgress });
  }

  // Pass 2 — video encode with the finished audio muxed in.
  const outFile = path.join(workdir, `merged_${sub.id}.mp4`);
  const videoArgs = [];
  videoArgs.push(...loopedInput, '-i', mixFile,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p',
    '-t', String(outDur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outFile);
  await runFfmpeg('video encode', videoArgs, { timeoutSec: 2100, onProgress });

  stage = 'upload';
  lastBeat = 0; await beat('uploading merged file');
  const objectPath = `videos/merged/${sub.id}.mp4`;
  const up = await fetch(`${STORAGE}/object/${objectPath}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'video/mp4', 'x-upsert': 'true', 'Cache-Control': 'max-age=3600' },
    body: readFileSync(outFile),
    signal: AbortSignal.timeout(900000),
  });
  if (!up.ok) throw new Error(`storage upload failed ${up.status}: ${await up.text()}`);

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${objectPath}`;
  await patchRow(sub.id, { merged_video_url: publicUrl, merge_status: 'ready', merge_error: null });
  console.log(`  ready: ${publicUrl}`);
}

const workdir = process.env.RUNNER_TEMP || '.';

// Claim pending work (and re-claim rows stuck in 'processing' from a crashed run —
// the workflow's concurrency group guarantees no two runs execute at once).
const q = `${REST}/submissions?select=id,video_url,track_title,merge_status&track_title=not.is.null&or=(merge_status.is.null,merge_status.eq.pending,merge_status.eq.processing)&order=created_at.asc`;
const res = await fetch(q, { headers: HEADERS });
if (!res.ok) { console.error(`query failed ${res.status}: ${await res.text()}`); process.exit(1); }
const rows = await res.json();
console.log(`${rows.length} submission(s) to merge`);

let failures = 0;
for (const sub of rows) {
  try {
    await processSubmission(sub, workdir);
  } catch (err) {
    failures++;
    console.error(`  FAILED ${sub.id}: ${err.message}`);
    try {
      await patchRow(sub.id, { merge_status: 'error', merge_error: String(err.message).slice(0, 1500) });
    } catch { /* leave as processing; next run retries */ }
  }
}
process.exit(failures ? 1 : 0);
