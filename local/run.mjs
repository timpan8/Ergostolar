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

import { readFile, writeFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { getText, getBuffer, ldObjects, Blocked, Gone, sharedBlocket } from './fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAIRS = path.join(ROOT, 'data', 'chairs.json');
const FINDS = path.join(ROOT, 'data', 'finds.json');
const PHOTOS = path.join(ROOT, 'data', 'photos.json');
const IMG_DIR = path.join(ROOT, 'img');
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
  git('add', 'data/chairs.json', 'data/finds.json', 'data/photos.json', 'img');
  if (!git('status', '--porcelain', 'data', 'img')) { log('Ingen ändring att publicera'); return; }
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
// Produktbilden: ld+json Product.image (sträng, lista eller ImageObject), annars og:image.
// Product kan ligga inbäddad, t.ex. som mainEntity i en WebPage (Lomax), så leta på alla nivåer.
function findProduct(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return null;
  if (!Array.isArray(o) && /Product/.test([].concat(o['@type'] || []).join(' '))) return o;
  for (const v of Array.isArray(o) ? o : Object.values(o)) { const p = findProduct(v, depth + 1); if (p) return p; }
  return null;
}
function pagePhoto(html, base) {
  const prod = findProduct(ldObjects(html));
  let src = [].concat(prod?.image || []).map(x => typeof x === 'string' ? x : x?.url || x?.contentUrl).find(Boolean);
  if (!src) src = (html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i) || [])[1];
  if (!src) return null;
  try { const u = new URL(src.replace(/&amp;/g, '&'), base); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}

// Foto till stolar som saknar ett: hämtas, skalas ned till JPEG (local/resize.ps1) och läggs i img/ + data/photos.json
async function savePhoto(it, src) {
  const id = createHash('md5').update(cleanUrl(it.url)).digest('hex');
  const tmp = path.join(os.tmpdir(), `ergo-${id}.bild`), dst = path.join(IMG_DIR, id + '.jpg');
  await writeFile(tmp, await getBuffer(src));
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'local', 'resize.ps1'), '-Src', tmp, '-Dst', dst], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (e) { throw new Error('bilden gick inte att läsa (' + (String(e.stderr || '').split('\n').map(l => l.trim()).find(l => l && !/^(At |\+|~|At line|CategoryInfo|FullyQualifiedErrorId)/.test(l) && !l.includes(ROOT)) || 'okänt fel').replace(/^Exception calling .*? with .*? argument\(s\): /, '').slice(0, 160) + ', ' + src + ')'); }
  finally { await rm(tmp, { force: true }); }
  return id;
}

const fmt = n => Math.round(n).toLocaleString('sv-SE').replace(/\s/g, ' ');
const COUNT_OK = new Set(['rekomo.se', 'rp.se', 'kontorsmobler.se']);

async function check(it) {
  report.kollade++;
  let html;
  try { html = await getText(it.url); delete it.missing; }
  catch (e) {
    if (e instanceof Gone) {
      // Sidan saknas: flytta till Slutsålt först när den saknats i ett dygn (en sajt kan byggas om)
      if (typeof it.missing !== 'string') it.missing = now.toISOString();
      if (now - new Date(it.missing) >= 20 * 3600e3) return { state: 'out', stock: 'Borttagen' };
      report.granska.push(`${it.name} (${new URL(it.url).host}): sidan finns inte (404) sedan ${it.missing.slice(0, 16).replace('T', ' ')} – flyttas till Slutsålt om den saknas i ett dygn`);
      return null;
    }
    report.olasta.push(`${it.name} (${new URL(it.url).host}): ${e.message}`);
    return null;
  }
  const r = readOffer(html);
  const photoSrc = pagePhoto(html, it.url);
  // Lagersiffror i sidans text gäller bara där de visat sig höra till själva stolen (andra butiker listar fler stolar på sidan)
  const host = new URL(it.url).host.replace(/^www\./, '');
  if (!COUNT_OK.has(host) || (r.count === 0 && r.avail === 'InStock')) r.count = null;
  const res = { photoSrc };
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
  const moves = [], needPhoto = [];
  let photos = {}; try { photos = JSON.parse(await readFile(PHOTOS, 'utf8')); } catch {}
  const hasPhoto = new Set(Object.keys(photos).map(cleanUrl));
  const all = [...ch.IN.map(x => ['IN', x]), ...ch.UNV.map(x => ['UNV', x]), ...ch.OUT.map(x => ['OUT', x])];
  // Alla sajter parallellt, en förfrågan i taget per sajt (fetch.mjs håller pausen)
  await Promise.all(all.map(async ([list, it]) => {
    const res = await check(it).catch(e => { report.olasta.push(`${it.name}: ${e.message}`); return null; });
    if (!res) return;
    const to = apply(it, res, list);
    if (to !== list) moves.push([it, list, to]);
    if (to !== 'OUT' && res.photoSrc && !hasPhoto.has(cleanUrl(it.url))) needPhoto.push([it, res.photoSrc]);
  }));
  for (const [it, from, to] of moves) { ch[from] = ch[from].filter(x => x !== it); ch[to].unshift(it); }
  // Foton till stolar i Går att köpa / Ej verifierade som saknar ett (slutsålda hoppas över).
  // Gick sidan inte att läsa (t.ex. CDON med botspärr): ta fyndets foto för samma annons, annars stolens photoUrl.
  let finds = {}; try { finds = JSON.parse(await readFile(FINDS, 'utf8')); } catch {}
  const imgOk = id => typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id) && existsSync(path.join(IMG_DIR, id + '.jpg'));
  const queued = new Set(needPhoto.map(([it]) => it));
  let reused = 0;
  for (const it of [...ch.IN, ...ch.UNV]) {
    const u = cleanUrl(it.url);
    if (hasPhoto.has(u) || queued.has(it)) continue;
    const f = Object.values(finds).find(x => cleanUrl(x.url) === u && imgOk(x.img));
    if (f) { photos[u] = f.img; reused++; }
    else if (/^https:\/\//.test(it.photoUrl || '')) needPhoto.push([it, it.photoUrl]);
  }
  // Fynd från marknadsplatser som bara har en länk till fotot: ladda ned det. Misslyckas det (utgången länk) görs
  // ett nytt försök först efter en vecka.
  const needFind = Object.values(finds).filter(f => f.state !== 'out' && !imgOk(f.img) && !f.thumb && /^https:\/\//.test(f.photoUrl || '') &&
    !(f.imgTried && now - new Date(f.imgTried) < 7 * 864e5));
  if (needPhoto.length || needFind.length || reused) {
    await mkdir(IMG_DIR, { recursive: true });
    report.foton = [];
    await Promise.all([
      ...needPhoto.map(async ([it, src]) => {
        try { photos[cleanUrl(it.url)] = await savePhoto(it, src); report.foton.push(it.name); }
        catch (e) { report.granska.push(`${it.name}: fotot gick inte att hämta – ${e.message}`); }
      }),
      ...needFind.map(async f => {
        try { f.img = await savePhoto(f, f.photoUrl); delete f.imgTried; report.foton.push(`${f.name} (fynd)`); }
        catch (e) { f.imgTried = now.toISOString(); report.granska.push(`${f.name} (fynd): fotot gick inte att hämta – ${e.message}`); }
      })
    ]);
    await writeFile(PHOTOS, JSON.stringify(photos, null, 1) + '\n');
    if (needFind.length) await writeFile(FINDS, JSON.stringify(finds, null, 1) + '\n');
    log(`Foton: ${report.foton.length} av ${needPhoto.length + needFind.length} nya hämtade, ${reused} från fynden`);
  }
  ch.eyebrow = String(ch.eyebrow || '').replace(/kollat[^·]*$/, `kollat ${svDate}, ca ${svTime}`);
  ch.autoChecked = now.toISOString();
  await writeFile(CHAIRS, JSON.stringify(ch, null, 1) + '\n');
  log(`Kollade ${report.kollade} stolar: ${report.andrade.length} prisändringar, ${report.slut.length} slut, ${report.tillbaka.length} tillbaka, ${report.olasta.length} gick inte att läsa, ${report.granska.length} att granska`);
}

// ---------- 3. Kandidater ----------
// Bevakade modeller. Utökat med fler heldags- och 24/7-stolar (kontrollrum, bevakning, operatörsplatser).
const MODELS = /logic\s*(400|4\b|220)|mereo|extend|kinnarps|plus\s*[68]|\b[689]000\b|capella|savo|\bxo\b|maxikon|h0[59]\b|h09|capisco|malmstol|leap|gesture|aeron|embody|stolcomfort|\bkab\b|rh\s*focus|secur\s*24|24\/7|24\s*h\b|dygnet runt|kontrollrum|bevakningsstol|operatörsstol|elite/i;
// 24/7-stolar får kosta upp till ca 14 000 kr (visas i en egen grupp över budget på sidan)
const H24 = /24\/7|24\s*h\b|dygnet runt|kontrollrum|bevakning|operatör|elite|stolcomfort|\bkab\b|rh\s*focus|secur\s*24/i;
const LISTS = [
  'https://www.rekomo.se/brands/rh/', 'https://www.rekomo.se/brands/kinnarps/', 'https://www.rekomo.se/brands/savo/',
  'https://www.rekomo.se/brands/hag/', 'https://www.rekomo.se/brands/steelcase/',
  'https://bbsmobler.se/sv/brand/rh', 'https://bbsmobler.se/sv/brand/kinnarps',
  'https://rp.se/shop/stolar/kontorsstolar-stolar/',
  'https://relovie.com/k/hem-inredning/mobler/kontorsstolar'
];
const BLOCKET_Q = ['logic 400', 'kinnarps 8000', 'kinnarps plus', 'kinnarps 9000', 'savo xo', 'rh mereo', 'rh extend', 'håg h09', 'malmstolen', 'steelcase leap', 'kontorsstol nackstöd',
  '24/7 stol', 'kontrollrumsstol', 'bevakningsstol', 'operatörsstol', 'logic 400 elite', 'rh focus', 'secur24'];
if (sharedBlocket) await sharedBlocket.needs('ergostolar', BLOCKET_Q); // anmäl sökorden till det gemensamma Blocket-jobbet
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
      let ads;
      // Med jobbköraren: delad Blocket-cache (det gemensamma Blocket-jobbet har oftast redan hämtat sökningen)
      if (sharedBlocket) ads = (await sharedBlocket.search(q, { maxAgeH: 3 })).items.map(a => ({ name: a.titel, url: a.url, price: a.pris, image: a.bild }));
      else {
        const html = await getText('https://www.blocket.se/recommerce/forsale/search?q=' + encodeURIComponent(q));
        const s = html.match(/<script[^>]*id="seoStructuredData"[^>]*>([\s\S]*?)<\/script>/);
        if (!s) throw new Error('inga sökresultat i sidan');
        ads = (JSON.parse(s[1]).mainEntity?.itemListElement || []).map(el => el.item || {}).map(it => ({ name: it.name, url: it.url, price: +(it.offers?.price || 0), image: it.image }));
      }
      for (const a of ads) {
        const u = cleanUrl(a.url);
        if (!u || known.has(u) || cands.has(u) || !MODELS.test(a.name || '') || !(a.price >= 500 && a.price < (H24.test(a.name || '') ? 14000 : 10000))) continue;
        cands.set(u, { name: a.name, url: u, källa: 'blocket.se', pris: a.price, bild: a.image || null, sökord: q });
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
