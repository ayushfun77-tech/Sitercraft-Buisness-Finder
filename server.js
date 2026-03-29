const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const ENV_FILE = path.join(ROOT_DIR, ".env");
const APIFY_RUN_CACHE = new Map();

loadEnvFile(ENV_FILE);

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const DEFAULT_CTA_LINK =
  process.env.DEFAULT_CTA_LINK || "https://ayushfun77-tech.github.io/SiteCraft";
const DEFAULT_APIFY_LANGUAGE = process.env.APIFY_LANGUAGE || "en";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, {
        defaultCtaLink: DEFAULT_CTA_LINK,
        hasApifyConfig: hasApifyConfig(),
        hasOutboundWebhook: Boolean(process.env.OUTREACH_WEBHOOK_URL),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readJsonBody(req);
      const payload = await searchPlaces(body || {});
      return sendJson(res, 200, payload);
    }

    if (req.method === "POST" && url.pathname === "/api/dispatch") {
      const body = await readJsonBody(req);
      const payload = await dispatchLead(body || {});
      return sendJson(res, 200, payload);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      error: error.publicMessage || "Something went wrong on the server.",
      details: process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
});

server.listen(PORT, () => {
  console.log(`SiteCraft Prospect AI running on http://localhost:${PORT}`);
});

async function searchPlaces(input) {
  const location = sanitizeText(input.location);
  const businessType = sanitizeText(input.businessType);
  const keyword = sanitizeText(input.keyword);
  const pageSize = clampNumber(input.pageSize, 5, 50, 15);
  const minReviews = clampNumber(input.minReviews, 0, 100000, 20);
  const onlyNoWebsite = Boolean(input.onlyNoWebsite);

  if (!location) {
    throw badRequest("Add a location first.");
  }
  if (!businessType) {
    throw badRequest("Add a business type like cafe, clinic, salon, or gym.");
  }

  const apifyConfig = await resolveApifyConfig(input);
  const searchString = [businessType, keyword].filter(Boolean).join(" ");
  const actorInput = buildApifyInput(apifyConfig.baseInput, {
    location,
    pageSize,
    searchString,
  });

  const rawPlaces = await runApifyActor(
    apifyConfig.actorId,
    apifyConfig.token,
    actorInput
  );

  let leads = rawPlaces
    .filter(Boolean)
    .map((place) => normalizeApifyLead(place, { businessType, location }));

  leads = leads.filter((lead) => lead.reviewCount >= minReviews);

  if (onlyNoWebsite) {
    leads = leads.filter((lead) => !lead.websiteUrl);
  }

  leads.sort(compareLeads);

  return {
    meta: {
      location,
      businessType,
      minReviews,
      onlyNoWebsite,
      returned: leads.length,
      source: "Apify Google Maps Scraper",
    },
    results: leads,
  };
}

async function resolveApifyConfig(input) {
  const directToken = sanitizeText(process.env.APIFY_TOKEN);
  const directActorId = sanitizeText(process.env.APIFY_ACTOR_ID);
  const directRunUrl =
    sanitizeText(process.env.APIFY_RUN_URL) || sanitizeText(input.apifyRunUrl);

  if (directToken && directActorId) {
    return {
      token: directToken,
      actorId: directActorId,
      baseInput: getDefaultApifyInput(),
    };
  }

  if (!directRunUrl) {
    throw badRequest(
      "Add your Apify run URL in the setup panel or put APIFY_RUN_URL in .env."
    );
  }

  if (APIFY_RUN_CACHE.has(directRunUrl)) {
    return APIFY_RUN_CACHE.get(directRunUrl);
  }

  const parsed = parseApifyRunUrl(directRunUrl);
  const metadata = await fetchJson(
    `https://api.apify.com/v2/actor-runs/${encodeURIComponent(
      parsed.runId
    )}?token=${encodeURIComponent(parsed.token)}`
  );

  const actorId = sanitizeText(metadata?.data?.actId);
  const defaultStoreId = sanitizeText(metadata?.data?.defaultKeyValueStoreId);

  if (!actorId) {
    throw badRequest("Could not resolve the Apify actor ID from the run URL.");
  }

  let baseInput = getDefaultApifyInput();
  if (defaultStoreId) {
    try {
      const savedInput = await fetchJson(
        `https://api.apify.com/v2/key-value-stores/${encodeURIComponent(
          defaultStoreId
        )}/records/INPUT?token=${encodeURIComponent(parsed.token)}`
      );

      if (savedInput && typeof savedInput === "object" && !Array.isArray(savedInput)) {
        baseInput = { ...baseInput, ...savedInput };
      }
    } catch (error) {
      console.warn("Falling back to local Apify defaults because saved input could not be loaded.");
    }
  }

  const config = {
    token: parsed.token,
    actorId,
    baseInput,
  };

  APIFY_RUN_CACHE.set(directRunUrl, config);
  return config;
}

function buildApifyInput(baseInput, params) {
  return {
    ...getDefaultApifyInput(),
    ...baseInput,
    locationQuery: params.location,
    searchStringsArray: [params.searchString],
    maxCrawledPlacesPerSearch: params.pageSize,
    language: sanitizeText(baseInput.language) || DEFAULT_APIFY_LANGUAGE,
    includeWebResults: false,
    scrapeContacts: false,
    scrapeDirectories: false,
    scrapeImageAuthors: false,
    scrapePlaceDetailPage: false,
    scrapeTableReservationProvider: false,
    website: "allPlaces",
    maxQuestions: 0,
    maxReviews: 0,
    maxImages: 0,
    maximumLeadsEnrichmentRecords: 0,
  };
}

async function runApifyActor(actorId, token, actorInput) {
  const response = await fetch(
    `https://api.apify.com/v2/acts/${encodeURIComponent(
      actorId
    )}/run-sync-get-dataset-items?token=${encodeURIComponent(
      token
    )}&clean=true&format=json&timeout=120`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(actorInput),
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Apify actor run failed: ${response.status} ${responseText}`);
  }

  const parsed = responseText ? JSON.parse(responseText) : [];
  return Array.isArray(parsed) ? parsed : [];
}

async function dispatchLead(input) {
  const lead = input.lead || {};
  const message = sanitizeText(input.message);
  const webhookUrl = sanitizeText(process.env.OUTREACH_WEBHOOK_URL);

  if (!lead.id || !sanitizeText(lead.name)) {
    throw badRequest("Pick a lead before dispatching it.");
  }
  if (!message) {
    throw badRequest("Generate or edit the outreach message before dispatching it.");
  }
  if (!webhookUrl) {
    throw badRequest(
      "Outbound webhook is not configured. Add OUTREACH_WEBHOOK_URL to your .env to automate dispatch."
    );
  }

  const payload = {
    lead,
    message,
    senderName: sanitizeText(input.senderName),
    senderBrand: sanitizeText(input.senderBrand),
    demoLink: sanitizeText(input.demoLink),
    ctaLink: sanitizeText(input.ctaLink),
    meetingLink: sanitizeText(input.meetingLink),
    generatedAt: new Date().toISOString(),
    source: "sitecraft-prospect-ai",
  };

  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body).toString(),
    "X-SiteCraft-Source": "sitecraft-prospect-ai",
  };

  const webhookSecret = sanitizeText(process.env.WEBHOOK_SECRET);
  if (webhookSecret) {
    headers["X-SiteCraft-Signature"] = crypto
      .createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body,
  });

  const responseText = await response.text();

  if (!response.ok) {
    const error = new Error(`Webhook dispatch failed: ${response.status} ${responseText}`);
    error.statusCode = 502;
    error.publicMessage = "Your webhook rejected the outreach payload.";
    throw error;
  }

  return {
    ok: true,
    status: response.status,
    message: "Lead payload sent to your automation webhook.",
    responsePreview: responseText.slice(0, 400),
  };
}

async function serveStatic(pathname, res) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "Forbidden." });
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      return serveStatic(path.join(pathname, "index.html"), res);
    }
    const ext = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mimeType });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendJson(res, 404, { error: "Not found." });
  }
}

function normalizeApifyLead(place, context) {
  const reviewCount = Number(place.reviewsCount || 0);
  const rating = Number(place.totalScore || 0);
  const websiteUrl = sanitizeText(place.website);
  const phoneRaw =
    sanitizeText(place.phoneUnformatted) || sanitizeText(place.phone);
  const isClosed = Boolean(place.permanentlyClosed || place.temporarilyClosed);

  const lead = {
    id:
      sanitizeText(place.placeId) ||
      sanitizeText(place.cid) ||
      sanitizeText(place.fid) ||
      sanitizeText(place.url) ||
      sanitizeText(place.title) ||
      crypto.randomUUID(),
    name: sanitizeText(place.title) || "Unknown business",
    address: sanitizeText(place.address) || "Address not available",
    rating,
    reviewCount,
    websiteUrl,
    hasWebsite: Boolean(websiteUrl),
    phone: phoneRaw || null,
    whatsappNumber: toWhatsAppNumber(phoneRaw),
    mapsUrl: sanitizeText(place.url) || null,
    businessStatus: isClosed ? "CLOSED" : "OPERATIONAL",
    primaryType:
      sanitizeText(place.categoryName) || sanitizeText(context.businessType),
    types: Array.isArray(place.categories) ? place.categories : [],
    locationLabel: context.location,
    requestedType: context.businessType,
    imageUrl: sanitizeText(place.imageUrl) || null,
    searchString: sanitizeText(place.searchString),
  };

  lead.fitScore = scoreLead(lead);
  lead.whyItRanks = buildWhyItRanks(lead);
  return lead;
}

function scoreLead(lead) {
  let score = 0;
  if (!lead.hasWebsite) score += 74;
  if (lead.whatsappNumber) score += 18;
  if (lead.businessStatus === "OPERATIONAL") score += 12;
  score += Math.min(lead.reviewCount, 500) * 0.5;
  score += lead.rating * 15;
  return Math.round(score);
}

function compareLeads(a, b) {
  if (a.hasWebsite !== b.hasWebsite) {
    return Number(a.hasWebsite) - Number(b.hasWebsite);
  }
  if (b.reviewCount !== a.reviewCount) {
    return b.reviewCount - a.reviewCount;
  }
  if (b.rating !== a.rating) {
    return b.rating - a.rating;
  }
  return b.fitScore - a.fitScore;
}

function buildWhyItRanks(lead) {
  const reasons = [];
  if (!lead.hasWebsite) reasons.push("No website detected");
  reasons.push(`${lead.reviewCount} reviews`);
  if (lead.rating) reasons.push(`${lead.rating.toFixed(1)} rating`);
  if (lead.whatsappNumber) reasons.push("WhatsApp-ready phone found");
  return reasons;
}

function hasApifyConfig() {
  return Boolean(
    sanitizeText(process.env.APIFY_RUN_URL) ||
      (sanitizeText(process.env.APIFY_TOKEN) &&
        sanitizeText(process.env.APIFY_ACTOR_ID))
  );
}

function parseApifyRunUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/v2\/actor-runs\/([^/]+)/);
    const runId = match?.[1];
    const token = url.searchParams.get("token");

    if (!runId || !token) {
      throw new Error("missing runId or token");
    }

    return { runId, token };
  } catch (error) {
    throw badRequest(
      "Apify run URL must look like https://api.apify.com/v2/actor-runs/<runId>?token=<token>."
    );
  }
}

function getDefaultApifyInput() {
  return {
    includeWebResults: false,
    language: DEFAULT_APIFY_LANGUAGE,
    locationQuery: "",
    maxCrawledPlacesPerSearch: 15,
    maximumLeadsEnrichmentRecords: 0,
    scrapeContacts: false,
    scrapeDirectories: false,
    scrapeImageAuthors: false,
    scrapePlaceDetailPage: false,
    scrapeReviewsPersonalData: true,
    scrapeSocialMediaProfiles: {
      facebooks: false,
      instagrams: false,
      tiktoks: false,
      twitters: false,
      youtubes: false,
    },
    scrapeTableReservationProvider: false,
    searchStringsArray: ["restaurant"],
    skipClosedPlaces: false,
    searchMatching: "all",
    placeMinimumStars: "",
    website: "allPlaces",
    maxQuestions: 0,
    maxReviews: 0,
    reviewsSort: "newest",
    reviewsFilterString: "",
    reviewsOrigin: "all",
    maxImages: 0,
    allPlacesNoSearchAction: "",
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { method: "GET" });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : {};
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toWhatsAppNumber(value) {
  const digits = sanitizeText(value).replace(/[^\d+]/g, "");
  if (!digits) return "";
  return digits.replace(/^\+/, "").replace(/^00/, "");
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw badRequest("Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw badRequest("Request body must be valid JSON.");
  }
}
