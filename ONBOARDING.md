# Onboarding-tjekliste

## Engangs-setup af master-scriptet (køres ÉN gang i alt)

- [ ] Nyt Apps Script-projekt oprettet i din Drive
- [ ] `apps-script/Code.gs` indsat
- [ ] `apps-script/appsscript.json` indsat (Project Settings → "Show appsscript.json")
- [ ] `bootstrapMaster_RUN_ME()` kørt; OAuth godkendt
- [ ] `MASTER_ADMIN_SECRET` kopieret fra Execution log: `_______________________________`
  (Gem sikkert — vises kun denne ene gang)
- [ ] Deployed → Web app: Execute as **Me**, Access **Anyone**
- [ ] `/exec`-URL kopieret: `_______________________________`
- [ ] URL indsat i `index.html` (`SCRIPT_URL`)
- [ ] `index.html` uploadet/hostet (GitHub Pages, Drive, Netlify…)
- [ ] `setOperator_RUN_ME()` rettet med din email + password og kørt
- [ ] Operatør-login testet: `https://din-hosting/index.html?band=__operator`

---

## Per nyt band — alt sker i operatør-UI'et

Åbn `https://din-hosting/index.html?band=__operator` og log ind.

### Band: ____________________________  Dato: ____________

1. [ ] Klik **"+ Nyt band"**
2. [ ] Udfyld **bandnavn** + **admin-email** (+ evt. admin-navn). Band-id
       foreslås automatisk — ret det hvis nødvendigt.
3. [ ] Klik **Opret band**. Scriptet opretter selv Google Sheet'et (samles i
       Drive-mappen `Band-app/`), initialiserer faner og opretter admin-brugeren.
4. [ ] Kopiér den viste **login-URL** + midlertidige adgangskode.
5. [ ] (Valgfrit) Klik **"Tilpas udseende"** → sæt farve/tema, upload logo,
       skriv rider-tekst (eller upload PDF), udfyld kontakt + bank.
6. [ ] Send login-URL til bandet. Admin logger ind med
       `seedPassword` (default `skiftmig2026`) og tvinges til at skifte den.

**CPR til faktura-modul (valgfrit):**
- [ ] Sæt CPR i operatør-editoren under "Bank & CPR" hvis faktura-modulet skal
      bruges. (Krypteres server-side; vises aldrig i klartekst igen.)

### Noter
```
(plads til særlige aftaler, deadlines, kontaktinfo)
```
