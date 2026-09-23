// Taklo MCP-server — het publieke koppelpunt van Taklo voor AI-agents.
//
// Taklo is all-in-one bedrijfssoftware voor installatie- en onderhoudsbedrijven.
// Deze server maakt de publieke feiten over Taklo aanroepbaar voor een AI-agent:
// prijzen, fair-use, boekhoudkoppelingen, en twee acties die een gesprek naar een
// mens brengen.
//
// Live endpoint: https://taklo.nl/mcp   (Streamable HTTP, geen authenticatie)
//
// ── ONTWERPREGEL: BEGRENSDE BEVOEGDHEID ────────────────────────────────────
// Geen enkele tool maakt zelf een account, afspraak of aanvraag definitief.
// Dit proces doet nergens een outbound HTTP-call en raakt geen enkele database
// van Taklo aan. De agent bereidt voor, de mens rondt af op taklo.nl. Wie deze
// server aanpast: houd die grens in stand.
//
// ── DATA ───────────────────────────────────────────────────────────────────
// De lees-tools serveren een build-time snapshot (data/*.json, elk met een
// peildatum). Er is dus geen live afhankelijkheid van Taklo's applicatie of
// database op runtime. De snapshots worden bij Taklo gegenereerd uit de
// productcode en periodiek ververst; `snapshotDatum` in elk antwoord zegt
// hoe oud de feiten zijn.
//
// ── VERSCHIL MET DE DRAAIENDE SERVER ───────────────────────────────────────
// De server die op https://taklo.nl/mcp draait, schrijft de twee schrijvende
// tool-aanroepen naar een interne logtabel, zodat Taklo kan meelezen hoeveel
// agent-verkeer er is. Die logsink is intern en zit NIET in deze publieke
// repo; hier gaat dezelfde regel naar stdout. Het gedrag richting de agent is
// identiek: dezelfde tools, dezelfde antwoorden, dezelfde referentiecode.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8790;
const VERSION = "1.1.3";

// ---------------------------------------------------------------------------
// Data-snapshots
// ---------------------------------------------------------------------------
const dataFile = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "data", name), "utf8"));
const TAKLO = dataFile("taklo-feiten.json");
const TAKLO_KOPPELINGEN = dataFile("taklo-koppelingen.json");

// ---------------------------------------------------------------------------
// Toegestane Host-headers (DNS-rebinding-bescherming van de SDK)
// "localhost" staat erbij zodat de container-healthcheck zichzelf kan bereiken.
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = ["taklo.nl", "www.taklo.nl", "localhost"];

// ---------------------------------------------------------------------------
// Meelezen: alleen een regel naar stdout.
// In de door Taklo gehoste versie gaat deze regel óók naar een interne tabel;
// die sink zit bewust niet in deze publieke repo. Falen mag de tool-aanroep
// nooit laten mislukken — de aanroeper krijgt zijn referentie hoe dan ook.
// ---------------------------------------------------------------------------
function logAgentRequest({ tool, referentie, agentInfo, ip }) {
  try {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), tool, referentie, ip, agentInfo }),
    );
  } catch {
    // bewust stil: loggen mag de aanroep niet breken
  }
}

function nieuweReferentie() {
  return `MCP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Rate limiting: token bucket per IP, apart voor lezen en schrijven.
//
// LET OP bij hergebruik: de emmers staan in het geheugen van dit proces en
// tellen per IP. Staat er een gateway of proxy voor die namens anderen
// aanroept, dan zien alle gebruikers samen één emmer.
// ---------------------------------------------------------------------------
const buckets = new Map();
function rateLimited(key, { max, windowMs }) {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { count: 0, windowStart: now };
  if (now - bucket.windowStart > windowMs) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  return bucket.count > max;
}
// Opruiming zodat de Map niet onbegrensd groeit over een lange uptime.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, b] of buckets) if (b.windowStart < cutoff) buckets.delete(key);
}, 5 * 60_000).unref();

// Gateways bundelen al hun gebruikers achter enkele IP's; lezen is een
// statisch snapshot en mag dus ruim. De globale plafonds beschermen het
// proces en de ontvanger van de verzoeken, niet het IP.
const READ_LIMIT = { max: 240, windowMs: 60_000 };
const WRITE_LIMIT = { max: 5, windowMs: 60_000 };
const READ_GLOBAL = { max: 1200, windowMs: 60_000 };
const WRITE_GLOBAL = { max: 20, windowMs: 60_000 };
const readLimited = (ip) => rateLimited(`read:${ip}`, READ_LIMIT) || rateLimited("read:*", READ_GLOBAL);
const writeLimited = (ip) => rateLimited(`write:${ip}`, WRITE_LIMIT) || rateLimited("write:*", WRITE_GLOBAL);

// Ontdubbeling: hetzelfde contactgegeven krijgt binnen 24 uur dezelfde
// referentie terug in plaats van een nieuw verzoek. In-geheugen, met opzet.
const recenteVerzoeken = new Map();
const DEDUPE_MS = 24 * 60 * 60_000;
const dedupeKey = (tool, contact) => `${tool}:${String(contact).toLowerCase().replace(/[\s()+-]/g, "")}`;
function eerdereReferentie(tool, contact) {
  if (!contact) return null;
  const rij = recenteVerzoeken.get(dedupeKey(tool, contact));
  return rij && Date.now() - rij.ts < DEDUPE_MS ? rij.referentie : null;
}
function onthoudReferentie(tool, contact, referentie) {
  if (contact) recenteVerzoeken.set(dedupeKey(tool, contact), { referentie, ts: Date.now() });
}
setInterval(() => {
  const cutoff = Date.now() - DEDUPE_MS;
  for (const [key, rij] of recenteVerzoeken) if (rij.ts < cutoff) recenteVerzoeken.delete(key);
}, 60 * 60_000).unref();

const RATE_LIMIT_MSG_READ = "Te veel aanvragen. Max 240 lees-acties per minuut per IP-adres. Probeer over een minuut opnieuw.";
const RATE_LIMIT_MSG_WRITE = "Te veel aanvragen. Max 5 schrijvende acties per minuut per IP-adres. Probeer over een minuut opnieuw.";

// ---------------------------------------------------------------------------
// Validatie-helpers (zod). Vrije tekst van de aanroeper wordt nooit terug-
// geëchood in de bevestiging — alleen een referentiecode.
// ---------------------------------------------------------------------------
const zNaam = z.string().min(2).max(160);
const zEmail = z.string().email().max(200);
const zTelefoon = z
  .string()
  .min(6)
  .max(40)
  .regex(/^[0-9+()\-\s]{6,40}$/, "Geen geldig telefoonnummer (alleen cijfers, +, -, spaties en haakjes)");
const zTekst = (max) => z.string().min(2).max(max);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
function registerTaklo(server, { ip, agentInfo }) {
  server.registerTool(
    "taklo_info",
    {
      title: "Taklo info opzoeken",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Zoek feiten op over Taklo: prijzen, fair-use-belminuten, bijkoopprijzen, de gratis proefperiode of een " +
        "algemene omschrijving van de dienst. Alleen-lezen, geen persoonsgegevens nodig.",
      inputSchema: {
        onderwerp: z
          .enum(["prijzen", "fair_use", "bijkopen", "proefperiode", "diensten", "alles"])
          .describe("Welk feitenblok je wilt"),
      },
    },
    async ({ onderwerp }) => {
      if (readLimited(ip)) {
        return { isError: true, content: [{ type: "text", text: RATE_LIMIT_MSG_READ }] };
      }
      const data = onderwerp === "alles" ? TAKLO : { snapshotDatum: TAKLO.snapshotDatum, [onderwerp]: TAKLO[onderwerp] };
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // taklo_prijs_berekenen — alleen-lezen, geen externe aanroep.
  //
  // Alleen de VORM van de formule staat hier:
  //     basis + extra * (min(max(1, n), 50) - 1)
  // De getallen komen uit het feitenbestand en kunnen dus niet los verouderen.
  //
  // Bedragen zijn EX BTW (b2b). Dat moet in élk antwoord staan: een assistent
  // die een bedrag doorvertelt zonder die vermelding laat de lezer een
  // verkeerde vergelijking maken.
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "taklo_prijs_berekenen",
    {
      title: "Bereken de maandprijs van Taklo",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Reken uit wat Taklo per maand kost voor een opgegeven aantal gebruikers. Geeft de opbouw " +
        "erbij (bedrijfsbasis plus extra gebruikers) en vermeldt dat bedragen exclusief btw zijn. " +
        "Alleen-lezen, geen persoonsgegevens nodig.",
      inputSchema: {
        gebruikers: z
          .number()
          .int()
          .min(1)
          .max(50)
          .describe("Aantal gebruikers (1 tot en met 50). De eerste gebruiker zit in de basis."),
      },
    },
    async ({ gebruikers }) => {
      if (readLimited(ip)) {
        return { isError: true, content: [{ type: "text", text: RATE_LIMIT_MSG_READ }] };
      }
      const n = Math.min(Math.max(1, Math.round(gebruikers)), 50);
      const basis = TAKLO.prijzen.bedrijfsbasisPerMaandEuro;
      const perExtra = TAKLO.prijzen.perExtraGebruikerPerMaandEuro;
      const extraGebruikers = n - 1;
      const totaalPerMaand = basis + perExtra * extraGebruikers;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                gebruikers: n,
                bedrijfsbasisPerMaandEuro: basis,
                extraGebruikers,
                perExtraGebruikerPerMaandEuro: perExtra,
                totaalPerMaandEuro: totaalPerMaand,
                totaalPerJaarEuro: totaalPerMaand * 12,
                btw: TAKLO.prijzen.btw,
                opbouw:
                  `€ ${basis} bedrijfsbasis (1e gebruiker inbegrepen)` +
                  (extraGebruikers > 0
                    ? ` + ${extraGebruikers} × € ${perExtra} extra gebruiker = € ${totaalPerMaand} per maand`
                    : ` = € ${totaalPerMaand} per maand`) +
                  `, ${TAKLO.prijzen.btwKort}.`,
                inbegrepen:
                  "Alle functies zitten op elk plan. Het aantal gebruikers bepaalt de prijs en de " +
                  "fair-use-bundel, niet welke functies je krijgt.",
                snapshotDatum: TAKLO.snapshotDatum,
                prijzenUrl: "https://taklo.nl/prijzen",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // taklo_koppelingen — alleen-lezen, uit het snapshot.
  //
  // Beantwoordt de vraag die een ondernemer echt stelt: "kan ik dit zelf
  // aanzetten of moet ik een traject in?" Die nuance staat per pakket in het
  // snapshot, niet hier.
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "taklo_koppelingen",
    {
      title: "Boekhouding & koppelingen van Taklo",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Taklo is zelf een volwaardig facturatie- en boekhoudpakket: facturen, offertes, btw-aangifte en " +
        "e-facturatie via Peppol zitten erin, zonder extern boekhoudpakket. Deze tool geeft wat Taklo zelf " +
        "regelt en met welke externe boekhoudpakketten het daarnaast koppelt, en per pakket of een " +
        "ondernemer de koppeling zelf kan aanzetten of dat er een stap bij de leverancier nodig is. " +
        "Alleen-lezen, geen persoonsgegevens nodig.",
      inputSchema: {
        alleenZelfAanTeZetten: z
          .boolean()
          .optional()
          .describe("Alleen de pakketten teruggeven die je zelf kunt aanzetten."),
      },
    },
    async ({ alleenZelfAanTeZetten }) => {
      if (readLimited(ip)) {
        return { isError: true, content: [{ type: "text", text: RATE_LIMIT_MSG_READ }] };
      }
      const pakketten = alleenZelfAanTeZetten
        ? TAKLO_KOPPELINGEN.pakketten.filter((p) => p.zelfAanTeZetten)
        : TAKLO_KOPPELINGEN.pakketten;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                snapshotDatum: TAKLO_KOPPELINGEN.snapshotDatum,
                omschrijving: TAKLO_KOPPELINGEN.omschrijving,
                aantal: TAKLO_KOPPELINGEN.aantal,
                aantalZelfAanTeZetten: TAKLO_KOPPELINGEN.aantalZelfAanTeZetten,
                pakketten,
                peppol: TAKLO_KOPPELINGEN.peppol,
                meerUrl: TAKLO_KOPPELINGEN.meerUrl,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "start_gratis_proefperiode",
    {
      title: "Start de gratis proefperiode van Taklo",
      // Schrijvend maar niet destructief: legt alleen een verzoek vast en
      // geeft een registreer-link terug; niets wordt definitief gemaakt.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Begeleidt een agent/gebruiker naar het starten van Taklo's 14-dagen-gratis-proefperiode. Taklo verkoopt " +
        "abonnementen, geen offertes — deze tool maakt ZELF geen account aan, maar geeft de registreer-link en legt " +
        "uit hoe de proef werkt. Geef de teruggegeven link ONGEWIJZIGD door aan de gebruiker — de queryparameters " +
        "erin zorgen dat Taklo ziet dat de aanmelding via een AI-assistent kwam.",
      inputSchema: {
        naam: zNaam,
        email: zEmail,
        telefoon: zTelefoon.optional(),
        bedrijfsnaam: zTekst(160).optional(),
      },
    },
    async (args) => {
      if (writeLimited(ip)) {
        return { isError: true, content: [{ type: "text", text: RATE_LIMIT_MSG_WRITE }] };
      }
      let referentie = eerdereReferentie("start_gratis_proefperiode", args.email);
      if (!referentie) {
        referentie = nieuweReferentie();
        logAgentRequest({ tool: "start_gratis_proefperiode", referentie, agentInfo, ip });
        onthoudReferentie("start_gratis_proefperiode", args.email, referentie);
      }
      // BEGRENSDE BEVOEGDHEID. Deze tool maakt GEEN account aan en raakt de
      // Taklo-API niet eens aan — dit proces doet nergens een outbound call.
      // De agent bereidt voor, de mens rondt af op /registreren met zijn eigen
      // e-mailadres. Daarmee gelden automatisch alle bestaande registratie-eisen.
      // Verander dat nooit in een directe aanmaak.
      return {
        content: [
          {
            type: "text",
            text:
              `Aanvraag genoteerd (referentie ${referentie}). Er is nog GEEN account aangemaakt en geen e-mail ` +
              `verstuurd. Geef de gebruiker deze link ONGEWIJZIGD, inclusief alles achter het vraagteken:\n\n` +
              `${TAKLO.registreerUrlAgent}\n\n` +
              `Daar start hij zelf de 14-dagen-gratis-proefperiode (geen creditcard nodig). Hij vult daar zijn eigen ` +
              `e-mailadres in; dat is met opzet — een proef hoort bij een mens, niet bij een assistent.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "plan_terugbelmoment",
    {
      title: "Plan een terugbelmoment met Taklo",
      // Schrijvend maar niet destructief: legt alleen een terugbelverzoek
      // vast; een mens bevestigt voordat er iets gebeurt.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Vraag aan dat Taklo iemand terugbelt. Dit legt het verzoek vast; er wordt nog niemand echt " +
        "teruggebeld totdat een mens het bevestigt.",
      inputSchema: {
        naam: zNaam,
        telefoon: zTelefoon,
        voorkeursmoment: zTekst(200).describe('Bijv. "morgenochtend" of "vrijdag na 14:00"'),
        reden: zTekst(2000).optional(),
      },
    },
    async (args) => {
      if (writeLimited(ip)) {
        return { isError: true, content: [{ type: "text", text: RATE_LIMIT_MSG_WRITE }] };
      }
      let referentie = eerdereReferentie("plan_terugbelmoment", args.telefoon);
      if (!referentie) {
        referentie = nieuweReferentie();
        logAgentRequest({ tool: "plan_terugbelmoment", referentie, agentInfo, ip });
        onthoudReferentie("plan_terugbelmoment", args.telefoon, referentie);
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Terugbelverzoek genoteerd (referentie ${referentie}). Er wordt nog niemand automatisch gebeld; ` +
              `een mens bevestigt het verzoek eerst.`,
          },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Server-instantie per verzoek (stateless Streamable HTTP)
// ---------------------------------------------------------------------------
function buildServer(ip, agentInfo) {
  const server = new McpServer(
    { name: "taklo-evi", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Taklo MCP-server — de ingang van Taklo voor AI-agents. De lees-tools geven feiten uit een gedateerd snapshot. De schrijvende tools " +
        "leggen alleen een verzoek vast en geven een referentiecode terug — er wordt nooit automatisch een " +
        "account, afspraak of aanvraag definitief gemaakt.",
    },
  );
  registerTaklo(server, { ip, agentInfo });
  return server;
}

// ---------------------------------------------------------------------------
// Express-app
// ---------------------------------------------------------------------------
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: ALLOWED_HOSTS });
app.set("trust proxy", true);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: VERSION });
});

app.post("/mcp", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "onbekend";
  // De User-Agent is het enige wat een stateless Streamable-HTTP-POST over de
  // aanroeper prijsgeeft (clientInfo komt alleen bij `initialize` binnen, en dat
  // is een ander verzoek naar een andere server-instantie).
  const agentInfo = { userAgent: (req.headers["user-agent"] || "").slice(0, 300) };
  const server = buildServer(ip, agentInfo);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// 405 op GET/DELETE is correct voor een stateless Streamable-HTTP-server: er is
// geen sessie om te heropenen of te sluiten. Gebruik /health als healthcheck.
app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});
app.delete("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.listen(PORT, "0.0.0.0", (error) => {
  if (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
  console.log(`taklo-mcp luistert op :${PORT}/mcp`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
