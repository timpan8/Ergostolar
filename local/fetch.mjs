// Snäll hämtning: en förfrågan i taget per sajt, minst MIN_GAP ms emellan (plus lite slump), längre väntan vid
// 429/5xx, och stopp om sajten visar en botspärr. Vi försöker aldrig ta oss runt en spärr.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MIN_GAP = +(process.env.FETCH_MIN_GAP_MS || 4000);
const pause = ms => new Promise(r => setTimeout(r, ms));
const lastHit = new Map(), queue = new Map();

export class Blocked extends Error {}
export class Gone extends Error {}

function throttled(host, fn) {
  const next = (queue.get(host) || Promise.resolve()).catch(() => {}).then(async () => {
    const wait = (lastHit.get(host) || 0) + MIN_GAP + Math.random() * 1500 - Date.now();
    if (wait > 0) await pause(wait);
    try { return await fn(); } finally { lastHit.set(host, Date.now()); }
  });
  queue.set(host, next);
  return next;
}

// Hämtar en sida som text. Gone = 404/410, Blocked = botspärr.
export async function getText(url) {
  const host = new URL(url).host;
  for (let i = 0; i < 3; i++) {
    const r = await throttled(host, () => fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'sv-SE,sv;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(30000) }))
      .catch(e => ({ ok: false, status: 0, err: e }));
    if (r.status === 404 || r.status === 410) throw new Gone(`${r.status}`);
    if (r.ok) {
      const t = await r.text();
      if (/<title>[^<]*(Client Challenge|Just a moment|Attention Required)/i.test(t)) throw new Blocked(`${host} visar en botspärr`);
      return t;
    }
    if (r.status === 403 && i === 0) { const t = await r.text?.().catch(() => '') || ''; if (/Just a moment|challenge/i.test(t)) throw new Blocked(`${host} visar en botspärr`); }
    if (r.status && r.status < 500 && r.status !== 429 && r.status !== 403) throw new Error(`svarade ${r.status}`);
    if (i < 2) await pause(15000 * (i + 1));
  }
  throw new Error('svarade inte');
}

// Alla ld+json-objekt på sidan (även @graph)
export function ldObjects(html) {
  return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean).flatMap(j => Array.isArray(j) ? j : j['@graph'] || [j]);
}
