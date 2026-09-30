# Swamp Tillskott

**Ladda ner:** gå till [Releases](../../releases/latest) och hämta `Swamp-Tillskott-…-portable.exe` (körs direkt) eller `Swamp-Tillskott-Setup-….exe` (installerar). Exe-filerna byggs automatiskt av GitHub Actions vid varje ändring.

Skrivbordsapp (Electron) för **portal.swamp.se / Sensor Online** med fokus på regn vs nivå i avloppsledningar – för att se och kvantifiera tillskottsvatten.

## Funktioner
**Regn & nivå**
- Tre synkade paneler: regn (alltid summerat per timme som standard, går att byta till 30 min / 10 min / dygn), nivå + förväntad torrvädersnivå, och regnpåverkan (nivå − torrväder).
- Dra över diagrammet för att zooma, scrollhjul zoomar, dubbelklick återställer. Reglaget i botten panorerar.
- Torrvädersprofil: median av nivån per kvart på dygnet (vardag/helg) från perioder utan regn senaste 48 h.
- Regnhändelser detekteras automatiskt (uppehåll > 6 h delar händelser). Per händelse: regnmängd, max intensitet, nivåhöjning över torrväder, mm nivå per mm regn, tid till topp och överskott (mm·h).
- Spridningsdiagram regn vs nivåhöjning med regressionslinje → "mm nivåhöjning per mm regn".
- Automatisk hantering av mätarbyte/flytt: data före ett långt glapp eller bestående nivåskifte används inte i torrväderberäkningen.
- Spikfilter (Hampel) för enstaka felvärden.

**Regnmätare**
- Karta med alla regnmätare, storlek/färg efter regnmängd i vald period.
- Tabell: senaste timmen, 24 h, 7 d, 30 d, vald period, max mm/h, senaste regn, batteri.
- Diagram per timme/dygn + ackumulerat för valda mätare (max 6), dygnstabell med värmekarta. CSV-export.

## Inloggning
- E-post + lösenord (samma som portalen). "Kom ihåg mig" sparar uppgifterna krypterat med Windows DPAPI (Electron safeStorage).
- Alternativt "Logga in via portalen" (öppnar portalen, fungerar även med SSO – appen plockar upp sessionen).

## Utveckling
```
npm install
npm start            # kör appen
npm test             # testar beräkningarna på syntetisk data
npm run dist         # bygger Windows-installer + portable i dist/
SWAMP_MOCK=1 npm start   # kör med syntetisk testdata utan inloggning
```
Kortkommandon: F5 uppdatera, F12 utvecklarverktyg.
