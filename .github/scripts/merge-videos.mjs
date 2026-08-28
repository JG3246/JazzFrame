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

function buildFfmpegArgs(videoFile, trackFile, video, track, outFile) {
  const BED = 'loudnorm=I=-25:TP=-2:LRA=11';    // visitor's own sound, underneath
  const TRK = 'loudnorm=I=-14:TP=-1.5:LRA=11';  // jazz track, dominant
  const MIX = 'amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=false';
  const VID = 'scale=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p';

  const args = ['-y', '-hide_banner', '-loglevel', 'warning'];
  const loop = video.duration < track.duration;
  if (loop) args.push('-stream_loop', '-1');
  args.push('-i', videoFile, '-i', trackFile);

  let filter, audioMap;
  if (video.hasAudio) {
    filter = `[0:v]${VID}[vout];[0:a]${BED}[bed];[1:a]${TRK}[trk];[bed][trk]${MIX}[aout]`;
    audioMap = '[aout]';
  } else {
    filter = `[0:v]${VID}[vout];[1:a]${TRK}[aout]`;
    audioMap = '[aout]';
  }
  args.push('-filter_complex', filter, '-map', '[vout]', '-map', audioMap);

  // Output length: track length when looping, else video length.
  args.push('-t', String(loop ? track.duration : video.duration));

  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    outFile,
  );
  return args;
}

async function processSubmission(sub, workdir) {
  console.log(`processing submission ${sub.id} (track: ${sub.track_title})`);
  await patchRow(sub.id, { merge_status: 'processing' });

  const videoFile = path.join(workdir, `input_${sub.id}`);
  await download(sub.video_url, videoFile);
  const trackFile = await resolveTrack(sub.track_title, workdir);

  const video = ffprobe(videoFile);
  const track = ffprobe(trackFile);
  if (!video.duration || !track.duration) throw new Error('could not read durations');
  console.log(`  video ${video.duration.toFixed(1)}s (audio: ${video.hasAudio}), track ${track.duration.toFixed(1)}s → ${video.duration < track.duration ? 'loop video to track length' : 'single pass, video length'}`);

  const outFile = path.join(workdir, `merged_${sub.id}.mp4`);
  execFileSync('ffmpeg', buildFfmpegArgs(videoFile, trackFile, video, track, outFile), { stdio: 'inherit' });

  const objectPath = `videos/merged/${sub.id}.mp4`;
  const up = await fetch(`${STORAGE}/object/${objectPath}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'video/mp4', 'x-upsert': 'true', 'Cache-Control': 'max-age=3600' },
    body: readFileSync(outFile),
  });
  if (!up.ok) throw new Error(`storage upload failed ${up.status}: ${await up.text()}`);

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${objectPath}`;
  await patchRow(sub.id, { merged_video_url: publicUrl, merge_status: 'ready' });
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
    try { await patchRow(sub.id, { merge_status: 'error' }); } catch { /* leave as processing; next run retries */ }
  }
}
process.exit(failures ? 1 : 0);
