# Ergostolar

Bevakning av begagnade ergonomiska kontorsstolar under 10 000 kr (stoppad hög rygg, nackstöd, leverans till Stockholm).

**Sida:** https://timpan8.github.io/Ergostolar/

## Så fungerar det
- `index.html` – sidan. Läser `data/chairs.json` (stolarna, toppvalen, datumrad och footer), `data/finds.json` (fynd från marknadsplatser), `data/votes.json` (Tims 👍/👎) och `data/photos.json` + `img/` (foton).
- 👍/👎 sparas direkt i `data/votes.json` via GitHub API med en nyckel som bara finns i webbläsaren.
- Datorns jobb (jobbköraren i `C:\Users\TimLi\Dev\Automation`, utan AI) hämtar pris och lager och letar nya stolar; se `local/`.
- Claude-uppgiften bedömer vilka som passar, väljer toppvalen, kollar Tradera/Marketplace och lägger resultatet i `inbox/`, som datorn publicerar. Se `RUTIN.md`.
