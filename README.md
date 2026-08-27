# Mixtape

Een muziek-tijdlijn-gezelschapsspel: geprinte kaarten met een QR-code op de
voorkant en het antwoord op de achterkant, en een telefoon-app die het nummer
afspeelt zonder ooit te laten zien wat het is.

Spotify verzorgt het afspelen. De app streamt zelf nooit audio — hij bestuurt
het apparaat waarop je Spotify-account al is ingelogd (Spotify Connect), zodat
de muziek uit de speaker komt terwijl het telefoonscherm niets laat zien behalve
een klok.

## Draaien

```bash
npm install     # jsqr + qrcode-generator zijn toegevoegd aan package.json
npm start       # http://127.0.0.1:5200
```

De dev-server staat vast op `127.0.0.1:5200` in `angular.json`.

> **Gebruik `127.0.0.1`, nooit `localhost`.** Spotify weigert de letterlijke
> string `localhost` in een redirect-URI. De app leidt zijn redirect-URI af van
> het adres waarop je hem hebt geladen, dus `http://localhost:5200` openen
> levert een redirect-URI op die Spotify weigert.

## Eenmalige Spotify-instelling

1. Maak een app aan op <https://developer.spotify.com/dashboard>.
2. Voeg `http://127.0.0.1:5200/` toe als Redirect URI — precies zo, inclusief de
   afsluitende slash.
3. Vink **Web API** aan, sla op, en kopieer de Client ID naar het instelscherm
   van de app.
4. Voeg het Spotify-account-e-mailadres van elke speler toe onder
   **User Management**.

Regels van Development Mode, anno 2026: de eigenaar van de app moet Spotify
Premium hebben, er kunnen maximaal vijf gebruikers op de allowlist staan, en
iedereen die meespeelt heeft Premium nodig.

## Doorgeven aan iemand anders

Een gedeployede kopie kan zijn eigen Spotify Client ID meedragen, zodat de
ontvanger het dashboard nooit hoeft te zien. Die staat in
`src/app/core/config.ts` en mag veilig gecommit worden: een PKCE-client-id is
een publieke identifier die in elke authorize-URL meereist, wat precies de
bedoeling van de flow is.

- `BUILT_IN_CLIENT_ID` — stel dit in en het instelscherm krimpt tot één enkele
  "Verbind met Spotify"-knop. Een handmatig ingevoerde client id heeft nog steeds
  voorrang.

Dit verandert alleen de instel-drempel, niet wie er mag spelen: Development Mode
beperkt de app nog steeds tot vijf Spotify-accounts op de allowlist, elk met
Premium.

## Gebruiken

De app slaat niets op — het is een stateless generator en speler. De QR van een
kaart bevat de kale Spotify-id van het nummer, dus scannen speelt het nummer
direct af; het antwoord staat geprint op de achterkant van de kaart.

- **Kaarten maken** (Instellingen → Kaarten maken, of de Terug-knop vanuit Spelen) — plak
  een afspeellijst die van jou is. De app markeert elk nummer waarvan het album
  op een remaster, compilatie of live-opname lijkt, omdat Spotify de
  releasedatum van *die persing* rapporteert, niet die van het nummer. Corrigeer
  de gemarkeerde jaartallen met de hand; dit is de stap die bepaalt of het spel
  werkt. Daarna **Kaarten maken** → Printen.
- **Printen** — een geschaalde voorvertoning van elk vel, voor- en achterkant,
  gevolgd door het printvenster. Print dubbelzijdig op **100% / werkelijke
  grootte**, met duplex ingesteld om te draaien op de **lange rand**. De
  achterkant-vellen zijn al gespiegeld zodat ze passen. Er is ook een
  **3D-tegels (.stl)**-export. De QR is versie 3 (29×29) op foutcorrectieniveau
  H, ≈50,9 mm op een kaart van 65 mm.
- **Spelen** — scan een kaart. Het nummer speelt anoniem af.

Doordat de QR de Spotify-id zelf bevat, is een kaart niet aan een domein
gebonden en werkt hij ongeacht waar de app is gedeployed — niets om opnieuw te
genereren. Hij wordt alleen gelezen door de eigen scanner van de app, niet door
een gewone telefooncamera.

## Indeling

```
src/app/core/         services zonder UI
  spotify-auth.ts     Authorization Code + PKCE, token-refresh
  spotify-api.ts      dunne Web API-wrapper, vriendelijke foutvertaling
  player.ts           afspeelstatus, klok, clip-timer
  deck.ts             afspeellijst-import + jaartal-heuristiek (in geheugen, geen opslag)
  scanner.ts          BarcodeDetector met een jsQR-fallback
  qr.ts               QR SVG / matrix-generatie voor kaarten en tegels
src/app/pages/        één map per scherm
```

De status leeft in `localStorage` onder het voorvoegsel `mixtape.`: tokens, het
gekozen apparaat en de cliplengte. De kaarten zelf worden nooit opgeslagen — de
QR van een kaart bevat alles wat het spel nodig heeft.

## Wanneer kaarten maken geweigerd wordt

Spotify verwijderde `GET /playlists/{id}/tracks` in februari 2026 en beantwoordt
het verwijderde pad met een kale `403 Forbidden`, wat precies leest als een
rechtenprobleem maar dat niet is. De builder roept in plaats daarvan
`GET /playlists/{id}/items` aan en leest de `item` van elke entry — dezelfde
wijziging hernoemde dat geneste object van `track`.

Daarnaast heeft een 403 drie ongerelateerde oorzaken en de melding zegt niet
welke. De builder plaatst een **"Zoek uit welke het is"**-knop onder de fout:
hij stelt Spotify een handvol vragen, één voor één, en leest het antwoord af aan
het patroon.

- *Elke* aanroep geweigerd, inclusief `/me` — de app mag de Web API niet
  aanroepen voor dit account. Twee dashboard-instellingen veroorzaken dit en de
  probe kan ze niet onderscheiden, dus controleer beide: vink **Web API** aan
  onder "Which API/SDKs are you planning to use?", en voeg het ingelogde account
  toe onder **User Management**.
- `/me` werkt, afspeellijsten geweigerd — het token mist de playlist-scopes.
  Verbreek de verbinding en verbind opnieuw; een ververst token behoudt de
  scopes van de oorspronkelijke toestemming, dus opnieuw verbinden is de enige
  manier om ze te verbreden.
- Alleen die ene afspeellijst geweigerd — door Spotify gemaakte lijsten (Top 50,
  Discover Weekly, Daily Mix, decennium- en genre-afspeellijsten) zijn gesloten
  voor apps van derden. Kopieer de nummers naar een eigen afspeellijst.

Succesvol inloggen bewijst op zichzelf weinig — een Development Mode-app kan een
token uitdelen en vervolgens elke API-aanroep weigeren.

## Bekende beperkingen

- **De camera vereist een beveiligde context.** `http://127.0.0.1:5200` telt als
  beveiligd, dus scannen werkt op de dev-machine. Een LAN-adres zoals
  `192.168.x.x` niet — op een telefoon moet je daarom via HTTPS deployen.
- **Alleen Premium.** De Web API weigert afspelen voor gratis accounts.
- **Spotify moet een actief apparaat hebben.** Open Spotify en speel een seconde
  iets af vóór de eerste scan, en kies daarna de speaker in Instellingen.
