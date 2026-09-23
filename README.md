# Taklo MCP-server

De publieke [MCP](https://modelcontextprotocol.io)-server van **Taklo** — all-in-one bedrijfssoftware voor installatie- en onderhoudsbedrijven.

Een AI-agent kan hiermee feiten over Taklo opzoeken, de maandprijs laten uitrekenen, opvragen wat Taklo zelf aan boekhouding doet (facturen, btw, Peppol) en met welke pakketten het optioneel koppelt, en een proefperiode of terugbelverzoek voorbereiden.

## Het endpoint

```
https://taklo.nl/mcp
```

- **Transport:** Streamable HTTP
- **Authenticatie:** geen
- **Kosten:** geen

### Aansluiten

```json
{
  "mcpServers": {
    "taklo": {
      "type": "http",
      "url": "https://taklo.nl/mcp"
    }
  }
}
```

### Met de hand uitproberen

Stuur een `Accept`-kop die zowel `application/json` als `text/event-stream` accepteert. Zonder die kop antwoordt de server met `-32000 Not Acceptable` — dat is geen storing.

```bash
curl -s -X POST https://taklo.nl/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Een `GET` op `/mcp` geeft `405`. Dat is correct voor een stateless Streamable-HTTP-server: er is geen sessie om te heropenen. Gebruik `/health` als healthcheck, niet `/mcp`.

## De tools

| Tool | Wat het doet | Soort |
| --- | --- | --- |
| `taklo_info` | Feiten over Taklo: prijzen, fair-use, bijkopen, proefperiode, diensten | alleen-lezen |
| `taklo_prijs_berekenen` | Maandprijs voor een aantal gebruikers, met de opbouw erbij | alleen-lezen |
| `taklo_koppelingen` | Boekhoudpakketten, en per pakket of je het zelf kunt aanzetten | alleen-lezen |
| `start_gratis_proefperiode` | Geeft de registreer-link voor de 14-dagen-proef | legt verzoek vast |
| `plan_terugbelmoment` | Legt een terugbelverzoek vast | legt verzoek vast |

Alle bedragen zijn **exclusief btw** (b2b). De tools vermelden dat zelf; geef het mee als je een bedrag doorvertelt.

## Begrensde bevoegdheid

Geen enkele tool maakt zelf een account, afspraak of aanvraag definitief.

`start_gratis_proefperiode` maakt **geen** account aan. De tool geeft een registreer-link terug; de gebruiker rondt daar zelf af met zijn eigen e-mailadres. Dat is met opzet — een proef hoort bij een mens, niet bij een assistent. Geef de link ongewijzigd door, inclusief de queryparameters: daarmee ziet Taklo dat de aanmelding via een AI-assistent kwam.

`plan_terugbelmoment` legt het verzoek vast. Er wordt niemand automatisch gebeld; een mens bevestigt eerst.

Het proces doet nergens een outbound HTTP-call en raakt geen enkele database van Taklo aan.

## De data

De lees-tools serveren een snapshot uit `data/*.json`, niet een live query. Elk antwoord draagt een `snapshotDatum` zodat je ziet hoe oud de feiten zijn. De snapshots worden bij Taklo gegenereerd uit de productcode en periodiek ververst.

Pas `data/*.json` niet met de hand aan in een fork die je actueel wilt houden — dan ontstaat er een tweede waarheid naast taklo.nl.

## Verschil met de server die op taklo.nl draait

De door Taklo gehoste server schrijft de twee schrijvende tool-aanroepen ook naar een interne logtabel, zodat Taklo kan meelezen hoeveel agent-verkeer er is. Die logsink is interne infrastructuur en zit niet in deze repo; hier gaat dezelfde regel naar stdout.

Richting de aanroepende agent is het gedrag identiek: dezelfde vijf tools, dezelfde antwoorden, dezelfde referentiecodes.

## Zelf draaien

```bash
npm install
npm start           # luistert op :8790
```

Of met Docker:

```bash
docker build -t taklo-mcp .
docker run -p 8790:8790 taklo-mcp
```

Daarna:

```bash
curl -s http://localhost:8790/health
```

`ALLOWED_HOSTS` in `server.js` bepaalt welke `Host`-headers geaccepteerd worden (bescherming tegen DNS-rebinding). Draai je dit achter een eigen domein, zet dat domein er dan bij.

## Rate limiting

30 lees-acties en 5 schrijvende acties per minuut per IP-adres. De emmers staan in het geheugen van het proces.

Let op bij hergebruik: staat er een gateway of proxy voor die namens meerdere gebruikers aanroept, dan zien al die gebruikers samen één emmer.

## Licentie

MIT — zie [LICENSE](LICENSE).
