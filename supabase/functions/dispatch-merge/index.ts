// Called by a DB webhook right after a submissions row is inserted with a
// chosen track. Immediately fires the merge-videos GitHub Actions workflow
// via workflow_dispatch, instead of waiting on GitHub's cron schedule
// (observed running every 4-5h instead of the configured 5 min on this
// low-traffic repo).
//
// Auth: the Supabase gateway checks the anon-key JWT on the Authorization
// header (standard); this function additionally requires a shared secret
// in x-webhook-secret so only our own DB trigger can actually trigger a
// dispatch (the anon key alone is public/readable in gate.html).

const GITHUB_OWNER = 'JG3246';
const GITHUB_REPO = 'JazzFrame';
const WORKFLOW_FILE = 'merge-videos.yml';
const REF = 'main';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const expected = Deno.env.get('WEBHOOK_SECRET');
  const got = req.headers.get('x-webhook-secret');
  if (!expected || got !== expected) {
    return new Response('unauthorized', { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const record = payload?.record;
  if (payload?.type !== 'INSERT' || payload?.table !== 'submissions' || !record?.track_title) {
    return new Response('ignored', { status: 200 });
  }

  const token = Deno.env.get('GITHUB_TOKEN');
  if (!token) {
    console.error('GITHUB_TOKEN not set');
    return new Response('server misconfigured', { status: 500 });
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'jazzframe-merge-dispatcher',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(`workflow dispatch failed: ${res.status} ${text}`);
    return new Response('dispatch failed', { status: 502 });
  }

  console.log(`dispatched merge workflow for submission ${record.id}`);
  return new Response('dispatched', { status: 200 });
});
