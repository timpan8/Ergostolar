// Ergostolar – datorns jobb utan AI (körs av jobbköraren i C:\Users\TimLi\Dev\Automation).
//
//   node local/run.mjs              tillämpa inkorgen, kolla pris/lager, leta kandidater, publicera
//   node local/run.mjs --no-push    samma men committa/pusha inte
//   node local/run.mjs --inbox-only bara tillämpa inkorgen och publicera
//
// Gör:
// 1. Inkorgen (ERGO_INBOX) från Claude-uppgiften: chairs.json (hela listan efter bedömning) och finds.json (fynd).
// 2. Pris och lager på varje stol: ld+json (med moms-flagga) och lagertext. Slut/borttagen -> Slutsålt; tillbaka i lager -> Går att köpa.
//    Prisändringar över 40 % och sidor som inte gick att läsa ändras inte utan listas för Claude.
// 3. Nya kandidater från butikernas listsidor och Blocket (modeller enligt MODELS) – bara listade, Claude bedömer dem.
// Resultat för Claude: JOB_OUT_DIR\senaste-kontroll.json och kandidater.json.

import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { getText, ldObjects, Blocked, Gone } from './fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAIRS = path.join(ROOT, 'data', 'chairs.json');
const FINDS = path.join(ROOT, 'data', 'finds.json');
const OUT_DIR = process.env.JOB_OUT_DIR || path.join(os.tmpdir(), 'ergostolar-runs');
const INBOX = process.env.ERGO_INBOX;
const push = !process.argv.includes('--no-push');
const inboxOnly = process.argv.includes('--inbox-only');
const log = (...a) => console.log(new Date().toLocaleTimeString('sv-SE'), ...a);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cleanUrl = u => String(u || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
const now = new Date();
const svDate = now.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Stockholm' }).replace('.', '');
const svTime = now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }).replace(':', '.');

if (push) { git('pull', '--rebase', '--autostash', '-q'); }

// ---------- 1. Inkorgen ----------
async function applyInbox() {
  if (!INBOX) return [];
  await mkdir(path.join(INBOX, 'done'), { recursive: true });
  const applied = [];
  for (const f of ['chairs.json', 'finds.json']) {
    const src = path.join(INBOX, f);
    let txt; try { txt = await readFile(src, 'utf8'); } catch { continue; }
    try {
      const j = JSON.parse(txt);
      if (f === 'chairs.json') {
        if (!Array.isArray(j.IN) || !Array.isArray(j.UNV) || !Array.isArray(j.OUT) || !Array.isArray(j.PICKS)) throw new Error('IN, UNV, OUT och PICKS måste finnas');
        await writeFile(CHAIRS, JSON.stringify(j, null, 1) + '\n');
      } else {
        // finds.json: { "<url>": {fynd} | {"remove": true} } slås ihop med befintliga fynd (nyckel = hash av url som på sidan)
        const cur = JSON.parse(await readFile(FINDS, 'utf8'));
        for (const [u, v] of Object.entries(j)) {
          const k = keyOf(cleanUrl(v?.url || u));
          if (v && v.remove) delete cur[k]; else cur[k] = { ...cur[k], ...v, url: cleanUrl(v.url || u) };
        }
        await writeFile(FINDS, JSON.stringify(cur, null, 1) + '\n');
      }
      await rename(src, path.join(INBOX, 'done', `${now.toISOString().replace(/[:.]/g, '-')}-${f}`));
      applied.push(f);
    } catch (e) {
      log(`PROBLEM inkorg ${f}: ${e.message} – döps om till fel-${f}`);
      await rename(src, path.join(INBOX, `fel-${f}`)).catch(() => {});
    }
  }
  if (applied.length) log('Tillämpat från inkorgen: ' + applied.join(', '));
  return applied;
}
function keyOf(u) { let h = 2166136261; for (let i = 0; i < u.length; i++) { h ^= u.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return 'f' + h.toString(16); }

async function publish(msg) {
  git('add', 'data/chairs.json', 'data/finds.json');
  if (!git('status', '--porcelain', 'data')) { log('Ingen ändring att publicera'); return; }
  git('commit', '-q', '-m', msg);
  try { git('push', '-q'); } catch { log('Push nekades, hämtar och försöker igen'); git('pull', '--rebase', '-q'); git('push', '-q'); }
  log('Publicerat');
}

const fromInbox = await applyInbox();
if (inboxOnly) {
  if (fromInbox.length && push) await publish(`Bedömning ${svDate} ${svTime} (från Claude-uppgiften)`);
  process.exit(0);
}

// ---------- 2. Pris och lager ----------
const ch = JSON.parse(await readFile(CHAIRS, 'utf8'));
const report = { tid: now.toISOString(), kollade: 0, andrade: [], slut: [], tillbaka: [], granska: [], olasta: [] };

function readOffer(html) {
  const prod = ldObjects(html).find(j => /Product/.test([].concat(j['@type']).join(' ')));
  const offers = prod ? [].concat(prod.offers || []).flatMap(o => o['@type'] === 'AggregateOffer' ? [].concat(o.offers || o) : [o]) : [];
  const o = offers[0];
  let price = null, vat = null, cur = null, avail = null;
  if (o) {
    const spec = [].concat(o.priceSpecification || [])[0];
    price = Number(spec?.price ?? o.price ?? o.lowPrice);
    vat = spec && typeof spec.valueAddedTaxIncluded === 'boolean' ? spec.valueAddedTaxIncluded : null;
    cur = spec?.priceCurrency || o.priceCurrency || 'SEK';
    avail = String(o.availability || '').replace(/^https?:\/\/schema\.org\//, '') || null;
  }
  const m = html.replace(/<[^>]+>/g, ' ').match(/(\d{1,4})\s*(?:st\s*)?(?:i lager|styck|tillgängliga|tillgänglig)\b/i);
  const count = m ? +m[1] : null;
  return { price: price > 0 ? price : null, vat, cur, avail, count };
}
const fmt = n => Math.round(n).toLocaleString('sv-SE').replace(/\s/g, ' ');
const COUNT_OK = new Set(['rekomo.se', 'rp.se', 'kontorsmobler.se']);

async function check(it) {
  report.kollade++;
  let html;
  try { html = await getText(it.url); delete it.missing; }
  catch (e) {
    if (e instanceof Gone) {
      // Sidan saknas: flytta till Slutsålt först efter två körningar i rad (en sajt kan byggas om)
      it.missing = (it.missing || 0) + 1;
      if (it.missing >= 2) return { state: 'out', stock: 'Borttagen' };
      report.granska.push(`${it.name} (${new URL(it.url).host}): sidan finns inte (404) – flyttas till Slutsålt om den saknas nästa körning också`);
      return null;
    }
    report.olasta.push(`${it.name} (${new URL(it.url).host}): ${e.message}`);
    return null;
  }
  const r = readOffer(html);
  // Lagersiffror i sidans text gäller bara där de visat sig höra till själva stolen (andra butiker listar fler stolar på sidan)
  const host = new URL(it.url).host.replace(/^www\./, '');
  if (!COUNT_OK.has(host) || (r.count === 0 && r.avail === 'InStock')) r.count = null;
  const res = {};
  // Lager
  if (r.avail === 'OutOfStock' || r.avail === 'SoldOut' || r.count === 0) { res.state = 'out'; res.stock = 'Slut'; }
  else if (r.avail === 'PreOrder' || r.avail === 'BackOrder') { res.state = 'in'; res.stock = it.stock && /förbeställ/i.test(it.stock) ? it.stock : 'Förbeställning'; }
  else if (r.count != null) { res.stock = `${r.count} i lager`; res.state = r.count >= 3 ? 'in' : 'few'; }
  else if (r.avail === 'InStock') { res.state = it.state === 'out' ? 'in' : it.state; }
  // Pris (bara SEK). Moms enligt sidans flagga; saknas den: den tolkning som ligger närmast förra priset.
  if (r.price && r.cur === 'SEK') {
    const f = r.vat === true ? 1 : r.vat === false ? 1.25 : (Math.abs(r.price - it.price) <= Math.abs(r.price * 1.25 - it.price) ? 1 : 1.25);
    const p = Math.round(r.price * f);
    if (p !== it.price) {
      if (Math.abs(p - it.price) / it.price > 0.4) report.granska.push(`${it.name}: läste ${fmt(p)} kr mot sparade ${fmt(it.price)} kr – inte ändrat`);
      else { res.price = p; res.exkl = f === 1.25 ? r.price : null; }
    }
  }
  if (!r.price && r.avail == null && r.count == null) report.olasta.push(`${it.name} (${new URL(it.url).host}): ingen pris- eller lagerdata på sidan`);
  return res;
}

function apply(it, res, list) {
  const before = { price: it.price, state: it.state, stock: it.stock };
  if (res.price) {
    // "4 950 exkl. moms" i noten följer med det nya priset
    if (res.exkl && /\d[\d\s ]*\s*exkl\. moms/.test(it.note || '')) it.note = it.note.replace(/\d[\d\s ]*(?=\s*exkl\. moms)/, fmt(res.exkl));
    report.andrade.push(`${it.name}: ${fmt(before.price)} → ${fmt(res.price)} kr`);
    it.price = res.price;
  }
  if (res.stock) it.stock = res.stock;
  if (res.state && list !== 'UNV') it.state = res.state;
  if (res.state === 'out' && list !== 'OUT') { it.state = 'out'; report.slut.push(`${it.name} (${it.store})`); return 'OUT'; }
  if (list === 'OUT' && res.state && res.state !== 'out') { report.tillbaka.push(`${it.name} (${it.store}): ${it.stock}`); return 'IN'; }
  return list;
}

if (process.env.ERGO_SKIP_CHECK !== '1') {
  const moves = [];
  const all = [...ch.IN.map(x => ['IN', x]), ...ch.UNV.map(x => ['UNV', x]), ...ch.OUT.map(x => ['OUT', x])];
  // Alla sajter parallellt, en förfrågan i taget per sajt (fetch.mjs håller pausen)
  await Promise.all(all.map(async ([list, it]) => {
    const res = await check(it).catch(e => { report.olasta.push(`${it.name}: ${e.message}`); return null; });
    if (!res) return;
    const to = apply(it, res, list);
    if (to !== list) moves.push([it, list, to]);
  }));
  for (const [it, from, to] of moves) { ch[from] = ch[from].filter(x => x !== it); ch[to].unshift(it); }
  ch.eyebrow = String(ch.eyebrow || '').replace(/kollat[^·]*$/, `kollat ${svDate}, ca ${svTime}`);
  ch.autoChecked = now.toISOString();
  await writeFile(CHAIRS, JSON.stringify(ch, null, 1) + '\n');
  log(`Kollade ${report.kollade} stolar: ${report.andrade.length} prisändringar, ${report.slut.length} slut, ${report.tillbaka.length} tillbaka, ${report.olasta.length} gick inte att läsa, ${report.granska.length} att granska`);
}

// ---------- 3. Kandidater ----------
const MODELS = /logic\s*(400|4\b|220)|mereo|extend|kinnarps|plus\s*8|\b8000\b|savo|\bxo\b|h0[59]\b|capisco|malmstol|leap|gesture|24\/7|kontrollrum/i;
const LISTS = [
  'https://www.rekomo.se/brands/rh/', 'https://www.rekomo.se/brands/kinnarps/', 'https://www.rekomo.se/brands/savo/',
  'https://www.rekomo.se/brands/hag/', 'https://www.rekomo.se/brands/steelcase/',
  'https://bbsmobler.se/sv/brand/rh', 'https://bbsmobler.se/sv/brand/kinnarps',
  'https://rp.se/shop/stolar/kontorsstolar-stolar/',
  'https://relovie.com/k/hem-inredning/mobler/kontorsstolar'
];
const BLOCKET_Q = ['logic 400', 'kinnarps 8000', 'kinnarps plus', 'savo xo', 'rh mereo', 'rh extend', 'håg h09', 'malmstolen', 'steelcase leap', 'kontorsstol nackstöd'];
const known = new Set([...ch.IN, ...ch.UNV, ...ch.OUT].map(x => cleanUrl(x.url)));
try { Object.values(JSON.parse(await readFile(FINDS, 'utf8'))).forEach(f => known.add(cleanUrl(f.url))); } catch {}
const cands = new Map();
const strip = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();

await Promise.all([
  ...LISTS.map(async src => {
    try {
      const html = await getText(src), base = new URL(src);
      // Produktlänkar med namn: <a href="...produkt..."> namn </a>
      for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]{1,400}?)<\/a>/g)) {
        let u; try { u = cleanUrl(new URL(m[1], base).href); } catch { continue; }
        if (!/\/(produkt|product|products|p)\//i.test(new URL(u).pathname)) continue;
        const name = strip(m[2]);
        if (name.length < 6 || !MODELS.test(name) || known.has(u) || cands.has(u)) continue;
        cands.set(u, { name: name.slice(0, 140), url: u, källa: base.host.replace(/^www\./, '') });
      }
    } catch (e) { report.olasta.push(`Listsida ${src}: ${e.message}`); }
  }),
  ...BLOCKET_Q.map(async q => {
    try {
      const html = await getText('https://www.blocket.se/recommerce/forsale/search?q=' + encodeURIComponent(q));
      const s = html.match(/<script[^>]*id="seoStructuredData"[^>]*>([\s\S]*?)<\/script>/);
      if (!s) throw new Error('inga sökresultat i sidan');
      for (const el of JSON.parse(s[1]).mainEntity?.itemListElement || []) {
        const it = el.item || {}, u = cleanUrl(it.url), price = +(it.offers?.price || 0);
        if (!u || known.has(u) || cands.has(u) || !MODELS.test(it.name || '') || !(price >= 500 && price < 10000)) continue;
        cands.set(u, { name: it.name, url: u, källa: 'blocket.se', pris: price, bild: it.image || null, sökord: q });
      }
    } catch (e) { report.olasta.push(`Blocket "${q}": ${e.message}`); }
  })
]);
report.kandidater = cands.size;
log(`Nya kandidater: ${cands.size} (listas för Claude, läggs inte in automatiskt)`);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, 'kandidater.json'), JSON.stringify([...cands.values()], null, 1));
await writeFile(path.join(OUT_DIR, 'senaste-kontroll.json'), JSON.stringify(report, null, 1));
for (const k of ['andrade', 'slut', 'tillbaka', 'granska']) report[k].forEach(x => log(k.toUpperCase(), x));

// ---------- 4. Publicera ----------
if (!push) { log('--no-push: committar inte'); process.exit(0); }
await publish(`Pris och lager ${svDate} ${svTime} (automatisk)`);
process.exit(report.olasta.length > report.kollade / 2 ? 3 : 0);
