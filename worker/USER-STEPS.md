# Dine skridt (Jonas) — status

## ✅ Allerede gjort (af Claude)
- Cloudflare-login godkendt
- KV-namespace `SESSIONS` oprettet (id: `c0a52403e89a44ea95e9f94c2e4e900e`)
- Hemmeligheden `APP_TOKEN` gemt i Cloudflare
- Worker-kode + config skrevet

## ⬜ DIT ENESTE RESTERENDE SKRIDT: sæt tokenet i Apps Script

1. Åbn dit Apps Script-projekt: <https://script.google.com> → vælg band-app-projektet
2. Klik ⚙️ **Project Settings** (venstre menu)
3. Scroll ned til **Script Properties** → **Add script property**
4. Property: `APP_SHARED_TOKEN`
5. Value: samme værdi som `APP_TOKEN` i `worker/.dev.vars` (aldrig i git — filen er gitignoret)
6. Klik **Save script properties**

> ✅ Udført 2026-07-03. Tokenet ligger lokalt i `worker/.dev.vars` og i Cloudflare
> (`wrangler secret list` viser det). Gem det også i en password-manager.

> Uden dette skridt afviser Apps Script alle kald fra Worker'en, og login fejler.
> Skridtet lukker samtidig sikkerhedsfund B/F (det offentligt kendte default-token).

## Senere (valgfrit): eget domæne
Cloudflare dashboard → **Workers & Pages** → `band-app` → **Settings** →
**Domains & Routes** → **Add Custom Domain** → fx `app.ditdomæne.dk`
(domænet skal ligge på din Cloudflare-konto).

## Daglige kommandoer (fra `worker/`-mappen)
- Lokal test: `npm run dev` → åbn `http://localhost:8787/?band=<dit-band-id>`
- Deploy: `npm run deploy`
