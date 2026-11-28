# Claude-uppgiften för Ergostolar

Uppgiften körs 08:10 och 18:10. **Datorn hämtar själv** (07:40, 11:40, 17:40, `local/run.mjs` via jobbköraren i
`C:\Users\TimLi\Dev\Automation`): pris och lager på varje stol i listan, produktfoto till stolar som saknar ett, och nya kandidater från Rekomo, BBS, RP, Relovie och
Blocket. Uppgiften gör det som kräver omdöme eller en riktig webbläsare. Skriv allt på svenska.

**Arbetsmapp:** `C:\Users\TimLi\Dev\Ergostolar`. Börja med `git pull --rebase --autostash`.
**Uppgiften committar och pushar aldrig.** Ändringar läggs i inkorgen `C:\Users\TimLi\Dev\Ergostolar\inbox\`; datorns jobb
"ergostolar-inkorg" publicerar inom 15 minuter. Ändra inte filerna i `data/` direkt.
Köp aldrig något, kontakta aldrig säljare och logga inte in någonstans.

**Butiksregistret** `C:\Users\TimLi\Dev\Automation\registry\butiker.json` (regler i `registry\README.md`) är det gemensamma
underlaget för vilka butiker som kollas. Ergostolars butiker har kategorin `kontor` och `ergostolar` i `projekt`.
Hittar du en ny relevant butik (t.ex. en återbruksbutik för kontorsmöbler) eller lär dig något nytt om en befintlig
(botspärr, moms, strukturerad data, frakt): skriv in det direkt i registret och nämn det i rapporten.
Butiker med `hamtning: "dator"` hämtas redan av datorns jobb.

## Tims krav ("Passar dig")
- Budget under 10 000 kr INKLUSIVE moms, frakt och eventuellt nackstöd.
- Bor i Stockholm, behöver inte provsitta. Butiker som skickar till Stockholm (hela Sverige, eller EU om totalen med frakt ryms)
  är lika bra. Stolar som bara kan hämtas ska hämtas i Stockholmsområdet, annars tas de bort.
- Långa arbetsdagar, 170–185 cm, inga besvär. STOPPAD rygg och sits (inte mesh), HÖG rygg och NACKSTÖD (monterat eller tillval).
- Begagnat/renoverat från seriösa aktörer, gärna med garanti/öppet köp. Håll också koll på prisvärda 24/7-stolar
  (t.ex. RH Logic 400 Elite 24/7) inom samma budget.

## Tims omdömen
`data/votes.json`: `{ "<modellnyckel>": { "model": "...", "vote": 1 | -1 } }`. Prioritera gillade modeller, lägg inte till nya
exemplar av ogillade och välj dem inte som toppval. Ändra aldrig i votes.json (Tim sätter dem på sidan).

## 1. Läs datorns resultat
- `C:\Users\TimLi\Dev\Automation\output\ergostolar\senaste-kontroll.json`: `andrade` (prisändringar), `slut` (flyttade till
  Slutsålt), `tillbaka` (i lager igen), `granska` (stora prishopp, sidor som saknas eller foton som inte gick att hämta – kontrollera dem), `foton` (stolar som
  fått foto), `olasta`
  (sidor datorn inte kunde läsa, t.ex. CDON med botspärr – kolla dem själv).
- `...\output\ergostolar\kandidater.json`: nya stolar av bevakade modeller som inte finns i listan. Bedöm dem (steg 2).
- Dagens logg: `C:\Users\TimLi\Dev\Automation\logs\ergostolar\`.

## 2. Bedöm och uppdatera listan
Utgå från `data/chairs.json` (`IN` = går att köpa, `UNV` = ej verifierat, `OUT` = slutsålt, `PICKS`, `eyebrow`, `footer`).
- Kandidater: öppna produktsidan (WebFetch eller Chrome) och avgör rygg, rygghöjd, nackstöd, pris inkl. moms, frakt och lager.
  Lägg verifierade som passar budgeten i `IN`, osäkra i `UNV`. Max ca 10–15 sidor per körning.
- Sidor datorn inte kunde läsa och raderna under `granska`: kolla dem och rätta pris/lager/flytta.
- Fält per stol: name, url, store, stock, state (in/few/unv/out), tier (Premium/Mycket bra/Bra/Specialfall), value (1–5),
  price (heltal kr INKL moms), approx, note, back (pad/mesh/saddle), tall, neck (yes/opt/no/unk), neckNote, why, h24 (bara om
  24/7-klassad), newPrice, cond, condSrc, condNote (se Skick nedan). Behåll modellnamnet i name. Inga påhittade data – hellre
  "unk"/"Ej verifierat". Moms: Rekomo, RP, Rafz, AKIAB och Yllw visar exkl. moms → ×1,25.
- **Skick** (sidan har ett filter på det): bedöm varje stol i `IN` och `UNV` och varje fynd som saknar `cond`, och gör om
  bedömningen om säljarens text eller fotot ändrats. Bedömda stolar behåller sitt `cond` mellan körningarna.
  - `cond`: `new` (som ny: säljaren skriver nyskick/som ny/oanvänd/ny klädsel, eller fotot visar en stol utan synligt slitage),
    `good` (normalt begagnat skick, små bruksspår), `worn` (sliten: säljaren nämner slitage, fläckar, hål, nött eller nedsutten
    stoppning, skick C/"med anmärkning", eller fotot visar det), `unk` (går inte att avgöra).
  - Läs säljarens text först: butikernas skicksgrad (t.ex. Rekomo/Offeco A/B/C, "gott begagnat skick") och annonsens beskrivning.
  - Titta sedan på fotot: `img/<id>.jpg` där id står i `data/photos.json` (nyckel = stolens url utan avslutande /), eller `img`/
    `photoUrl` för fynd. Öppna bilden med Read. Leta efter nött eller blank klädsel på sitsens framkant och armstöden, fläckar,
    noppor, sprickor i plast, skavd fot och nedsjunken sits. Säger texten inget, bedöm från fotot. Visar fotot tydligt slitage
    som texten inte nämner: välj `worn` – fotot väger tyngst. Är fotot en katalogbild (samma bild för flera exemplar, vit
    studiobakgrund utan detaljer) säger det inget om skicket.
  - `condSrc`: `text`, `foto` eller `båda`. `condNote`: högst 60 tecken, t.ex. "nött sits och armstöd" eller "säljaren: skick A".
  - Välj inte en stol med `cond: "worn"` som toppval om det finns ett likvärdigt alternativ i bättre skick.
- `PICKS`: tre bästa köpen för Tim enligt kraven och omdömena, med frakt. Format:
  `{ "label", "name", "store" (början av butiksnamnet), "price"?, "priceNote"?, "text", "where" }` – name+store måste matcha en stol i IN.
- `eyebrow`: behåll texten, datorn uppdaterar "kollat …". `footer`: 3–6 meningar om vad som ändrats sedan förra kollen.
- Lägg hela den uppdaterade listan som `inbox\chairs.json`.

## 3. Marknadsplatser
**Facebook Marketplace och köp/sälj-grupper**
- Vad som söks styr du i `C:\Users\TimLi\Dev\Automation\bestallningar\marketplace.json` (sökningar med `"projekt": "ergostolar"`,
  med `must`) och `bestallningar\fb-grupper.json`. Fyll på och rensa enligt `bestallningar\README.md`.
- Kör dagens Chrome-plan enligt avsnittet "Marketplace och grupper i Chrome" i `bestallningar\README.md` (plan → Chrome →
  import). Den tar bara det som inte redan körts i dag.
- Läs resultatet: `C:\Users\TimLi\Dev\Automation\output\marketplace\senaste.json` (dagens nya annonser, prisändringar, sålda)
  och `...\archive\marketplace\annonser.json` (alla annonser med historik). Sök inte om det som redan finns där.
- Bedöm de nya annonserna (rätt modell, stoppad hög rygg, nackstöd, pris + frakt eller hämtning i Stockholmsområdet). Öppna en
  annons i Chrome bara om titel, pris och bild inte räcker för att bedöma den.

**Tradera och CDON** kräver webbläsare (botspärr) och kollas i Claude in Chrome. Sök på bevakade modeller (RH Logic 400, Mereo,
Extend, Kinnarps 8000/Plus/9000, Savo XO, HÅG H09, Malmstolen, Steelcase Leap, samt "24/7", "kontrollrumsstol").

Fynd från alla marknadsplatser: ta bara med annonser du bedömt, högst 10 fynd, bästa först. Lägg dem som `inbox\finds.json`:
`{ "<url>": { name, url, store, stock, state, tier, value, price, note, back, tall, neck, neckNote, why, checked (ÅÅÅÅ-MM-DD), photoUrl, cond, condSrc, condNote, h24?, newPrice? } }`.
Såld annons: samma url med `"state": "out"`. Ska bort helt: `{ "<url>": { "remove": true } }`. Blocket sköts av datorn.

## 4. Avisering
Skicka en kort pushnotis ENDAST om något viktigt hänt: en ny stol som passar Tim eller en ny prisvärd 24/7-stol under
10 000 kr inkl. frakt (särskilt av en gillad modell), ett tydligt prisfall (>10 %) på en sådan stol, eller att ett av de tre
toppvalen tagit slut. 1–3 meningar med modell, butik, pris inkl. moms (och frakt) och länken https://timpan8.github.io/Ergostolar/.
Annars: avsluta med en rad om att listan är granskad.
