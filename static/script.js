/* =========================================================================
   SAFRMRTAH — AI TRAVEL INTELLIGENCE PLATFORM (frontend)

   Architecture:

     STATE ──► API ──► NORMALIZATION ──► SESSION STORE ──► RENDERING

   - STATE          appState: current thread, sessions, active view
   - API            POST /api/travel, POST /api/travel/approve   (unchanged)
                    GET  /api/travel/sessions                     (optional)
                    GET  /api/travel/session/{thread_id}          (optional)
   - NORMALIZATION  normalizeTravelResponse() turns the backend payload into
                    a UI-friendly TripSession. Every extractor is conservative:
                    a value that is not present in the backend output becomes
                    { value: null, source: "not_available" } and is displayed
                    as "Not available". Nothing is invented.
   - SESSION STORE  Raw backend payloads are kept per thread_id (localStorage
                    as a UI cache). PostgreSQL/LangGraph checkpoints remain the
                    authoritative store when the optional GET endpoints exist.
   - RENDERING      One render function per domain view.
   ========================================================================= */

"use strict";


/* =========================================================================
   1. CONSTANTS
   ========================================================================= */

const API = {
  travel: "/api/travel",
  approve: "/api/travel/approve",
  sessions: "/api/travel/sessions",
  session: (threadId) => `/api/travel/session/${encodeURIComponent(threadId)}`,
  health: "/health"
};

const STORAGE_KEY = "tripmate.sessions.v2";
const UI_STORAGE_KEY = "tripmate.ui.v2";
const MAX_STORED_SESSIONS = 40;

const NA = "Not available";
const NO_DATA = "Nothing found for this trip";

const VIEWS = ["dashboard", "flights", "hotels", "weather", "budget", "itinerary", "report"];

/* Agent registry — order matches backend AGENT_ORDER. */
const AGENTS = [
  { id: "flight_agent",    label: "Flight Agent",    icon: "✈", view: "flights",   source: "AviationStack and Tavily" },
  { id: "hotel_agent",     label: "Hotel Agent",     icon: "▣", view: "hotels",    source: "Tavily web search" },
  { id: "weather_agent",   label: "Weather Agent",   icon: "☁", view: "weather",   source: "OpenWeather" },
  { id: "budget_agent",    label: "Budget Agent",    icon: "◈", view: "budget",    source: "Groq LLM" },
  { id: "itinerary_agent", label: "Itinerary Agent", icon: "☷", view: "itinerary", source: "Groq LLM" }
];

const STATUS_META = {
  draft:      { label: "Draft",      tone: "warn" },
  finalized:  { label: "Approved",   tone: "ok" },
  revised:    { label: "Updated",    tone: "info" },
  completed:  { label: "Ready",      tone: "ok" },
  blocked:    { label: "Not planned", tone: "bad" },
  incomplete: { label: "Unfinished", tone: "muted" },
  unknown:    { label: "Unknown",    tone: "muted" }
};

/* Budget categories, matched against row labels. Order matters. */
const BUDGET_CATEGORIES = [
  { key: "flights",    label: "Flights",    re: /flight|air\s*fare|airfare|airline|air\s*ticket/i },
  { key: "hotels",     label: "Hotels",     re: /hotel|accommodation|lodging|\bstay\b|hostel|resort/i },
  { key: "transport",  label: "Transport",  re: /transport|transfer|taxi|metro|uber|careem|local travel|\bbus\b|\btrain\b|car rental|commut/i },
  { key: "activities", label: "Activities", re: /activit|sightseeing|attraction|tour|entrance|entry fee|excursion|entertain|safari|ticket/i },
  { key: "meals",      label: "Meals",      re: /meal|food|dining|restaurant|eat/i },
  { key: "misc",       label: "Misc.",      re: /misc|contingenc|buffer|other|visa|insurance|shopping|\bsim\b|incidental|souvenir|tips?\b/i }
];

const TOTAL_RE = /\btotal\b|grand total|overall cost|trip cost/i;

/* Three-letter tokens that are not airport codes. */
const IATA_STOP = new Set([
  "THE", "AND", "FOR", "NOT", "ANY", "ALL", "YES", "USD", "EUR", "GBP", "BDT", "AED",
  "MAD", "JPY", "THB", "INR", "CAD", "AUD", "API", "MCP", "LLM", "GMT", "UTC", "EST",
  "PST", "CET", "IST", "FAQ", "TBD", "ETA", "ETD", "VAT", "TAX", "ATM", "SIM", "NEW",
  "AIR", "VIA", "OUT", "ARE", "YOU", "CAN", "ONE", "TWO", "MIN", "MAX", "AVG", "EST"
]);

const CUR_TOKEN =
  "(US\\$|\\$|€|£|৳|¥|₹|(?:USD|EUR|GBP|BDT|AED|MAD|JPY|THB|INR|CAD|AUD|Tk|TK|DHS?|Dhs?)(?![A-Za-z]))";
const NUM_TOKEN = "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";
const MULT_TOKEN = "(k(?![a-z])|K(?![a-zA-Z])|lakhs?(?![a-z])|lacs?(?![a-z]))?";
const MONEY_RE_SOURCE =
  `${CUR_TOKEN}?\\s?${NUM_TOKEN}\\s*${MULT_TOKEN}\\s*${CUR_TOKEN}?` +
  `(?:\\s*(?:-|–|—|‑|to)\\s*${CUR_TOKEN}?\\s?${NUM_TOKEN}\\s*${MULT_TOKEN}\\s*${CUR_TOKEN}?)?`;


/* =========================================================================
   2. STATE
   ========================================================================= */

const appState = {
  currentThreadId: null,      // thread of the selected trip (null = new trip)
  sessions: [],               // session records (raw backend payload per thread)
  activeView: "dashboard",
  waitingForApproval: false,  // derived: current trip status === "draft"
  isLoading: false,
  loadingKind: null,          // "generate" | "approve"
  loadingStartedAt: null,
  backend: {
    online: null,             // result of GET /health
    sessionsEndpoint: "unknown" // "supported" | "unsupported" | "unknown"
  },
  syncing: new Set()          // thread_ids being refreshed from the backend
};

/* Normalized trips cache: thread_id -> { stamp, trip } */
const tripCache = new Map();

let loadingTimer = null;


/* =========================================================================
   3. GENERIC UTILITIES
   ========================================================================= */

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[c]));
}

/* Remove Markdown/HTML decoration from a short string. */
function stripMd(text) {
  return String(text ?? "")
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:])/g, "$1$2")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/* Field wrapper: a value with its provenance, or "not_available". */
function field(value, source) {
  const v = value === undefined || value === null ? "" : String(value).trim();
  return v ? { value: v, source } : { value: null, source: "not_available" };
}

function show(f, fallback = NA) {
  return f && f.value ? f.value : fallback;
}

function has(f) {
  return Boolean(f && f.value);
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function uniqueBy(list, keyFn) {
  const seen = new Set();
  return list.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* Prose only: drop Markdown tables, headings and separators so a table is
   never flattened into one long "sentence" of pipes. */
function proseOnly(markdown) {
  return String(markdown || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*:?-{3,}/.test(line) && !/^\s*#{1,6}\s/.test(line))
    .join("\n");
}

function sentences(text) {
  return stripMd(proseOnly(text))
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}


/* =========================================================================
   4. MARKDOWN UTILITIES (rendering + structural parsing)
   ========================================================================= */

/* Remove scripts, event handlers and javascript: URLs from rendered HTML. */
function sanitizeHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content
    .querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button,textarea,select")
    .forEach((node) => node.remove());
  tpl.content.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        name === "style" ||
        ((name === "href" || name === "src" || name === "xlink:href") && value.startsWith("javascript:"))
      ) {
        node.removeAttribute(attr.name);
      }
    });
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return tpl.innerHTML;
}

function markdownToHtml(markdown) {
  if (!markdown) return "";
  if (typeof marked === "undefined") {
    return `<pre class="plain-pre">${escapeHtml(markdown)}</pre>`;
  }
  const parse = typeof marked.parse === "function" ? marked.parse : marked;
  return sanitizeHtml(parse(String(markdown)));
}

/* Kept for compatibility with the previous script. */
function renderMarkdown(element, markdown) {
  if (element) element.innerHTML = markdownToHtml(markdown);
}

/* Headings: "# Title" lines and stand-alone "**Title**" lines. */
function parseHeadings(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const heads = [];
  lines.forEach((line, index) => {
    let m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      heads.push({ line: index, level: m[1].length, title: stripMd(m[2]) });
      return;
    }
    m = line.match(/^\s{0,3}(?:\d+[.)]\s+)?(?:\*\*|__)([^*_]{2,90})(?:\*\*|__)\s*:?\s*$/);
    if (m) heads.push({ line: index, level: 5, title: stripMd(m[1]) });
  });
  return { lines, heads };
}

/* Body of the first section whose heading matches one of the patterns. */
function findSection(markdown, patterns, options = {}) {
  if (!markdown) return "";
  const { lines, heads } = parseHeadings(markdown);
  for (let h = 0; h < heads.length; h++) {
    const head = heads[h];
    if (!patterns.some((p) => p.test(head.title))) continue;
    if (options.exclude && options.exclude.some((p) => p.test(head.title))) continue;
    let end = lines.length;
    for (let k = h + 1; k < heads.length; k++) {
      if (heads[k].level <= head.level) {
        end = heads[k].line;
        break;
      }
    }
    const body = lines.slice(head.line + 1, end).join("\n").trim();
    if (body) return body;
  }
  return "";
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

/* All GitHub-style Markdown tables in a text. */
function parseMarkdownTables(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const tables = [];
  const separator = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|") || !separator.test(lines[i + 1])) continue;
    const headers = splitTableRow(lines[i]).map(stripMd);
    if (headers.length < 2) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) {
      const cells = splitTableRow(lines[j]);
      if (cells.every((c) => !c || /^:?-+:?$/.test(c))) continue;
      rows.push(cells);
    }
    tables.push({ headers, rows, start: i, end: j });
    i = j - 1;
  }
  return tables;
}

function columnIndex(headers, re, exclude) {
  return headers.findIndex((h) => re.test(h) && !(exclude && exclude.test(h)));
}

/* "- **Label:** value" / "- Label: value" / "- **Label** – value" */
function parseBulletPairs(markdown) {
  const out = [];
  String(markdown || "").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*(?:[-*•+]|\d+[.)])\s+(.+)$/);
    if (!m) return;
    const body = m[1].trim();
    let label = "";
    let value = "";
    let p = body.match(/^(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*(?::|–|—|-)?\s*(.*)$/);
    if (p) {
      label = p[1].replace(/[:\s]+$/, "");
      value = p[2];
    } else if ((p = body.match(/^([^:]{2,60}):\s*(.+)$/))) {
      label = p[1];
      value = p[2];
    } else {
      label = body;
    }
    out.push({ label: stripMd(label), value: value.trim(), raw: body, bold: /^(\*\*|__)/.test(body) });
  });
  return out;
}

/* Values of "Label: value" lines and 2-column table rows whose label matches. */
function findLabeledAll(markdown, labelRe) {
  const values = [];
  String(markdown || "").split(/\r?\n/).forEach((line) => {
    if (/^\s*\|/.test(line)) {
      const cells = splitTableRow(line);
      if (cells.length >= 2 && labelRe.test(stripMd(cells[0])) && stripMd(cells[1])) {
        values.push(cells.slice(1).join(" | "));
      }
      return;
    }
    const cleaned = line
      .replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, "")
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/\*\*|__/g, "");
    const m = cleaned.match(/^\s*(.{1,70}?)\s*[:：]\s+(.+)$/);
    if (m && labelRe.test(m[1].trim())) values.push(m[2].trim());
  });
  return values;
}

function findLabeled(markdown, labelRe) {
  return findLabeledAll(markdown, labelRe)[0] || "";
}


/* =========================================================================
   5. MONEY PARSING (conservative — currency required unless told otherwise)
   ========================================================================= */

function normalizeCurrency(token) {
  if (!token) return null;
  const t = token.toUpperCase().replace(/\.$/, "");
  if (t === "$" || t === "US$" || t === "USD") return "USD";
  if (t === "€" || t === "EUR") return "EUR";
  if (t === "£" || t === "GBP") return "GBP";
  if (t === "৳" || t === "BDT" || t === "TK") return "BDT";
  if (t === "¥" || t === "JPY") return "JPY";
  if (t === "₹" || t === "INR") return "INR";
  if (t === "DH" || t === "DHS") return "DH";
  return t;
}

function multiplier(token) {
  if (!token) return 1;
  if (/^k$/i.test(token)) return 1000;
  if (/^la/i.test(token)) return 100000;
  return 1;
}

function toNumber(raw, mult) {
  const n = parseFloat(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n * multiplier(mult) : null;
}

/**
 * Parse the first money amount/range in a text.
 * Returns { currency, display, low, high, text } or null.
 */
function parseMoney(text, options = {}) {
  const source = String(text || "");
  if (!source) return null;

  /* "5 nights × $130 = $650" → prefer the part after the last "=" */
  if (!options.noEquals && source.includes("=")) {
    const after = source.slice(source.lastIndexOf("=") + 1);
    const parsed = parseMoney(after, { ...options, noEquals: true });
    if (parsed) return parsed;
  }

  const re = new RegExp(MONEY_RE_SOURCE, "g");
  let m;
  while ((m = re.exec(source)) !== null) {
    if (!m[2]) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const currencyToken = m[1] || m[4] || m[5] || m[8] || options.defaultCurrency || null;
    const next = source.charAt(m.index + m[0].length);
    if (next === "%") continue;
    if (!currencyToken && !options.allowPlain) continue;

    const low = toNumber(m[2], m[3]);
    let high = m[6] ? toNumber(m[6], m[7] || m[3]) : null;
    if (low === null) continue;
    if (!currencyToken && low >= 1900 && low <= 2100 && !m[3]) continue; // looks like a year
    if (high !== null && high < low) high = null;

    return {
      currency: normalizeCurrency(currencyToken),
      token: currencyToken,
      low,
      high,
      text: m[0].trim()
    };
  }
  return null;
}

function formatAmount(n) {
  if (n === null || n === undefined) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 100 && n % 1 ? 2 : 0 });
}

function formatMoney(money) {
  if (!money) return null;
  const symbols = { USD: "$", EUR: "€", GBP: "£", BDT: "৳", JPY: "¥", INR: "₹" };
  const sym = symbols[money.currency];
  const fmt = (n) => (sym ? `${sym}${formatAmount(n)}` : `${formatAmount(n)}`);
  const body = money.high ? `${fmt(money.low)}–${fmt(money.high)}` : fmt(money.low);
  if (sym) return body;
  return money.currency ? `${money.currency} ${body}` : body;
}

function moneyHigh(money) {
  return money ? (money.high ?? money.low) : 0;
}


/* =========================================================================
   6. NORMALIZATION — ROUTE, DURATION, STATUS
   ========================================================================= */

function cleanPlace(value) {
  const v = stripMd(value).replace(/^(?:the|a)\s+/i, "").replace(/[.,;:]+$/, "").trim();
  if (!v || /^(n\/?a|none|unknown|not specified|unspecified|-+)$/i.test(v)) return "";
  return v;
}

function parseRouteFromText(text) {
  const t = String(text || "");
  const cap = "([A-ZÀ-Ý][\\wÀ-ÿ'’.-]*(?:\\s+[A-ZÀ-Ý][\\wÀ-ÿ'’.-]*){0,3})";
  let m = t.match(new RegExp(`\\b[Ff]rom\\s+${cap}\\s+to\\s+${cap}`));
  if (m) return { origin: m[1], destination: m[2] };
  m = t.match(new RegExp(`\\b(?:to|in)\\s+${cap}\\s+from\\s+${cap}`));
  if (m) return { origin: m[2], destination: m[1] };
  m = t.match(new RegExp(`${cap}\\s*(?:→|->)\\s*${cap}`));
  if (m) return { origin: m[1], destination: m[2] };
  return { origin: "", destination: "" };
}

function parseDuration(text) {
  const m = String(text || "").match(/\b(\d{1,2})\s*-?\s*(days?|nights?|weeks?)\b/i);
  if (!m) return "";
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase().replace(/s$/, "");
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function durationDays(durationValue) {
  const m = String(durationValue || "").match(/(\d+)\s*(day|week|night)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (/week/i.test(m[2])) return n * 7;
  if (/night/i.test(m[2])) return n + 1;
  return n;
}

/* Status of a trip from a POST /api/travel or /approve payload. */
function deriveStatus(data, previousStatus) {
  if (!data) return previousStatus || "unknown";
  if (data.status && STATUS_META[data.status]) return data.status;
  if (data.guardrail_allowed === false) return "blocked";
  if (data.requires_approval) return "draft";
  if (data.approved === true) return "finalized";
  if (data.approved === false && data.human_feedback) return "revised";
  if (data.answer) return previousStatus === "draft" ? "finalized" : "completed";
  return previousStatus || "unknown";
}

/* "Temporarily unavailable" / failure markers the backend writes. */
function isDegraded(text) {
  return /temporarily unavailable|unable to reliably determine|request failed|not found on server/i.test(text || "");
}


/* =========================================================================
   7. NORMALIZATION — FLIGHTS
   ========================================================================= */

function parseAirport(value) {
  const v = stripMd(value);
  let code = null;
  const m =
    v.match(/\(([A-Z]{3})\)/) ||
    v.match(/IATA(?:\s*code)?\s*[:\-–]?\s*([A-Z]{3})\b/) ||
    v.match(/^([A-Z]{3})\b(?=\s*[–—\-:(,]|\s*$)/);
  if (m && !IATA_STOP.has(m[1])) code = m[1];

  let name = v
    .replace(/\(([A-Z]{3})\)/g, "")
    .replace(/IATA(?:\s*code)?\s*[:\-–]?\s*[A-Z]{3}\b/, "")
    .replace(/^([A-Z]{3})\s*[–—\-:]\s*/, "")
    .split(/;|\s[–—]\s|\.\s/)[0]
    .replace(/\s+,/g, ",")
    .replace(/[,–—\-:\s]+$/, "")
    .trim();

  if (/^(not|unable|unknown|n\/a)/i.test(name)) name = "";
  return { code, name: name ? truncate(name, 70) : null };
}

function extractAirlines(text, tables) {
  const names = [];
  const push = (raw) => {
    stripMd(raw)
      .split(/,|\/|;|\s+and\s+|\s+&\s+/)
      .map((s) => s.replace(/\(.*?\)/g, "").replace(/[.\s]+$/, "").trim())
      .filter((s) => s.length >= 2 && s.length <= 45 && s.split(" ").length <= 6)
      .filter((s) => !/^(n\/?a|none|not available|unknown|various|multiple|several|other|others|etc|e\.?g)\b/i.test(s))
      .forEach((s) => names.push(s));
  };

  tables.forEach((t) => {
    const col = columnIndex(t.headers, /airline|carrier|operator/i);
    if (col >= 0) t.rows.forEach((row) => push(row[col] || ""));
  });

  if (!names.length) {
    findLabeledAll(text, /^(?:operating\s+)?(?:airlines?|carriers?)\b/i).forEach(push);
  }

  if (!names.length) {
    const section = findSection(text, [/^airlines?\b|^carriers?\b/i]);
    parseBulletPairs(section).forEach((b) => push(b.label));
  }

  return uniqueBy(names, (n) => n.toLowerCase()).slice(0, 12);
}

function extractStops(text) {
  const t = stripMd(text);
  const parts = [];
  const negatedDirect = /\bno (?:direct|non-?stop)|not (?:a )?direct|without (?:a )?direct/i.test(t);
  if (!negatedDirect && /non-?stop|\bdirect\b/i.test(t)) parts.push("Direct");
  if (/\b(?:1|one)[- ]stop/i.test(t)) parts.push("1 stop");
  if (/\b(?:2|two)[- ]stops?/i.test(t)) parts.push("2 stops");
  return parts.length ? parts.join(" / ") : "";
}

function extractFlightDuration(text) {
  const durRe = /~?\s*\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?)\b(?:\s*\d+\s*(?:m|min|mins|minutes?)\b)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?)\b(?:\s*\d+\s*(?:m|min|mins|minutes?)\b)?)?/i;
  const lines = String(text || "").split(/\r?\n/).filter((l) => /duration|flight time|flying time|travel time/i.test(l));
  for (const line of lines) {
    const m = stripMd(line).match(durRe);
    if (m) return m[0].replace(/^~\s*/, "~").trim();
  }
  return "";
}

function extractFlightFare(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => /fare|price|airfare|ticket|cost/i.test(l));
  for (const line of lines) {
    const money = parseMoney(stripMd(line));
    if (money) return money;
  }
  return null;
}

function extractFlightData(response, context) {
  const text = String(response.flight_results || "");
  const selected = context.agents.includes("flight_agent");

  let status = "generated";
  if (!selected) status = "not_selected";
  else if (!text.trim()) status = "no_data";
  else if (/unable to reliably determine/i.test(text)) status = "unresolved";
  else if (/temporarily unavailable/i.test(text)) status = "unavailable";

  const tables = parseMarkdownTables(text);

  /* Airports: only from labeled lines in the Flight Agent output. */
  let originAirport = { code: null, name: null };
  let destinationAirport = { code: null, name: null };
  if (status === "generated") {
    const dep = findLabeled(text, /^(?:\d+\.\s*)?(?:resolved\s+)?(?:departure|origin|outbound)(?:\s+airport)?\b/i);
    const arr = findLabeled(text, /^(?:\d+\.\s*)?(?:resolved\s+)?(?:destination|arrival)(?:\s+airport)?\b/i);
    if (dep) originAirport = parseAirport(dep);
    if (arr) destinationAirport = parseAirport(arr);

    if (!originAirport.code || !destinationAirport.code) {
      const m = stripMd(text).match(/\b([A-Z]{3})\s*(?:→|->|–|—|to)\s*([A-Z]{3})\b/);
      if (m && !IATA_STOP.has(m[1]) && !IATA_STOP.has(m[2]) && m[1] !== m[2]) {
        originAirport.code = originAirport.code || m[1];
        destinationAirport.code = destinationAirport.code || m[2];
      }
    }
  }

  const airlines = status === "generated" ? extractAirlines(text, tables) : [];
  const fare = status === "generated" ? extractFlightFare(text) : null;
  const optionsTable =
    tables.find((t) => t.headers.some((h) => /airline|carrier|flight|route|depart|operator/i.test(h))) || null;

  return {
    selected,
    status,
    origin: field(context.origin.value, context.origin.source),
    destination: field(context.destination.value, context.destination.source),
    originCode: field(originAirport.code, "flight_agent"),
    destinationCode: field(destinationAirport.code, "flight_agent"),
    originAirport: field(originAirport.name, "flight_agent"),
    destinationAirport: field(destinationAirport.name, "flight_agent"),
    airlines,
    duration: field(status === "generated" ? extractFlightDuration(text) : "", "flight_agent"),
    stops: field(status === "generated" ? extractStops(text) : "", "flight_agent"),
    fare: field(formatMoney(fare), "flight_agent_estimate"),
    optionsTable,
    tables,
    liveDataMentioned: /aviationstack|live|schedule/i.test(text),
    raw: text
  };
}


/* =========================================================================
   8. NORMALIZATION — HOTELS
   ========================================================================= */

const HOTEL_WORD_RE =
  /hotel|resort|\binn\b|suites?|hostel|residence|apartments?|lodge|marriott|hilton|hyatt|ibis|novotel|radisson|sheraton|wyndham|rove|premier|holiday inn|citymax|ramada|best western|mercure|pullman|sofitel|accor|guest ?house|riad|ryokan|capsule|motel|b&b/i;

function extractTavilySources(text) {
  const sources = [];
  const t = String(text || "");
  let m;
  const plain = /Title:\s*(.+?)\s*\n\s*URL:\s*(\S+)/g;
  while ((m = plain.exec(t)) !== null) sources.push({ title: stripMd(m[1]), url: m[2] });
  const json = /\\?["']title\\?["']\s*:\s*\\?["']([^"'\\]{3,200})\\?["']\s*,\s*\\?["']url\\?["']\s*:\s*\\?["'](https?:[^"'\\\s]+)/g;
  while ((m = json.exec(t)) !== null) sources.push({ title: stripMd(m[1]), url: m[2] });
  const jsonRev = /\\?["']url\\?["']\s*:\s*\\?["'](https?:[^"'\\\s]+)\\?["']\s*,\s*\\?["']title\\?["']\s*:\s*\\?["']([^"'\\]{3,200})/g;
  while ((m = jsonRev.exec(t)) !== null) sources.push({ title: stripMd(m[2]), url: m[1] });
  return uniqueBy(sources.filter((s) => /^https?:\/\//.test(s.url)), (s) => s.url).slice(0, 8);
}

function hotelOptionsFromTables(tables) {
  const table = tables.find((t) =>
    t.headers.some((h) => /hotel|property/i.test(h)) ||
    (t.headers.some((h) => /\bname\b/i.test(h)) && t.headers.some((h) => /night|price|rate|area|location/i.test(h)))
  );
  if (!table) return [];
  const h = table.headers;
  const nameCol = Math.max(0, columnIndex(h, /hotel|property|name|accommodation/i));
  const areaCol = columnIndex(h, /area|location|neighbou?rhood|district|zone/i);
  const priceCol = columnIndex(h, /price|rate|night|cost/i, /total/i);
  const totalCol = columnIndex(h, /total/i);
  const ratingCol = columnIndex(h, /rating|stars?|score|review/i);
  const whyCol = columnIndex(h, /why|note|highlight|reason|feature|pros|comment|best for/i);
  const currencyHint = h.map((x) => (x.match(new RegExp(CUR_TOKEN)) || [])[1]).find(Boolean) || null;

  return table.rows
    .map((row) => {
      const cell = (i) => (i >= 0 ? stripMd(row[i] || "") : "");
      const price = priceCol >= 0 ? parseMoney(cell(priceCol), { defaultCurrency: currencyHint }) : null;
      const total = totalCol >= 0 ? parseMoney(cell(totalCol), { defaultCurrency: currencyHint }) : null;
      return {
        name: cell(nameCol),
        area: cell(areaCol) || null,
        price,
        priceText: priceCol >= 0 ? cell(priceCol) : "",
        total,
        rating: cell(ratingCol) || null,
        why: cell(whyCol) || null
      };
    })
    .filter((o) => o.name && !TOTAL_RE.test(o.name));
}

function hotelOptionsFromBullets(section) {
  return parseBulletPairs(section)
    .filter((b) => b.bold && b.label.length <= 80)
    .filter((b) => !/^(check|area|neighbou?rhood|location|budget|total|price|cost|tip|note|recommend|why|nights?|average)/i.test(b.label))
    .filter((b) => HOTEL_WORD_RE.test(b.label) || parseMoney(b.value))
    .map((b) => {
      const value = stripMd(b.value);
      const price = parseMoney(value);
      const areaMatch = value.match(/\bin\s+([A-Z][\w'’ -]{2,30}?)(?=[,.;(]|\s[–—-]\s|$)/);
      return {
        name: b.label,
        area: areaMatch ? areaMatch[1].trim() : null,
        price,
        priceText: price ? price.text : "",
        total: null,
        rating: (value.match(/(\d(?:\.\d)?\s*(?:★|stars?|\/\s*5|\/\s*10))/i) || [])[1] || null,
        why: truncate(value.replace(/^[\s,–—:-]+/, ""), 160) || null
      };
    });
}

function extractHotelData(response, context, budget) {
  const selected = context.agents.includes("hotel_agent");
  const tavily = String(response.hotel_results || "");
  const plan = context.planText;
  const accSection = findSection(plan, [/accommodat|hotel|where to stay|lodging|\bstay\b/i], {
    exclude: [/day\s*\d/i]
  });

  let status = "generated";
  if (!selected) status = "not_selected";
  else if (!tavily.trim() && !accSection) status = "no_data";
  else if (isDegraded(tavily)) status = "unavailable";

  const tables = parseMarkdownTables(accSection);
  let options = hotelOptionsFromTables(tables);
  if (!options.length) options = hotelOptionsFromTables(parseMarkdownTables(plan));
  if (!options.length) options = hotelOptionsFromBullets(accSection);
  options = uniqueBy(options, (o) => o.name.toLowerCase()).slice(0, 10);

  const nightsMatch =
    stripMd(accSection).match(/\b(\d{1,2})\s*nights?\b/i) ||
    String(context.request).match(/\b(\d{1,2})\s*nights?\b/i);

  const areaLabel = findLabeled(accSection, /^(?:recommended\s+)?(?:area|neighbou?rhood|location|district|where to stay|base)\b/i);

  const recommendedLabel = findLabeled(accSection, /recommended hotel|top pick|best (?:value|choice|option|pick)|our pick/i);

  /* Nightly range across listed options (same currency only). */
  const priced = options.filter((o) => o.price);
  let nightly = null;
  if (priced.length) {
    const cur = priced[0].price.currency;
    const same = priced.filter((o) => o.price.currency === cur);
    const low = Math.min(...same.map((o) => o.price.low));
    const high = Math.max(...same.map((o) => moneyHigh(o.price)));
    nightly = { currency: cur, low, high: high > low ? high : null };
  }

  let total = null;
  let totalSource = "not_available";
  const totalLabel = findLabeled(plan, /total accommodation|accommodation total|total (?:hotel|stay|lodging)|accommodation \(total\)/i);
  if (totalLabel && parseMoney(totalLabel)) {
    total = parseMoney(totalLabel);
    totalSource = "itinerary_agent";
  } else if (budget.categories.hotels && budget.categories.hotels.money) {
    total = budget.categories.hotels.money;
    totalSource = budget.source;
  }

  return {
    selected,
    status,
    destination: field(context.destination.value, context.destination.source),
    nights: field(nightsMatch ? `${parseInt(nightsMatch[1], 10)} nights` : "", "itinerary_agent"),
    area: field(areaLabel ? truncate(stripMd(areaLabel), 60) : "", "itinerary_agent"),
    recommended: field(
      recommendedLabel ? truncate(stripMd(recommendedLabel), 70) : options[0] ? options[0].name : "",
      "itinerary_agent"
    ),
    nightly: field(nightly ? formatMoney(nightly) : "", "itinerary_agent"),
    total: field(formatMoney(total), totalSource),
    optionsCount: field(options.length ? String(options.length) : "", "itinerary_agent"),
    options,
    sources: extractTavilySources(tavily),
    section: accSection,
    raw: tavily
  };
}


/* =========================================================================
   9. NORMALIZATION — WEATHER
   ========================================================================= */

function weatherKey(text, key) {
  const re = new RegExp(`\\\\?["']${key}\\\\?["']\\s*:\\s*(?:\\\\?["'])?([^,}\\\\"']+)`, "i");
  const m = String(text || "").match(re);
  return m ? m[1].trim() : "";
}

function extractForecast(text) {
  const re = /datetime\\?["']\s*:\s*\\?["']([^"'\\]+)\\?["'][\s\S]{0,60}?temperature_c\\?["']\s*:\s*(-?[\d.]+)[\s\S]{0,60}?condition\\?["']\s*:\s*\\?["']([^"'\\]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    out.push({ datetime: m[1], temperature: parseFloat(m[2]), condition: m[3] });
  }
  return out;
}

/* Daily summary from the remote weather MCP: {date, min_c, max_c, condition, rain_chance} */
function extractDailyForecast(text) {
  const re = /["']date\\?["']\s*:\s*\\?["'](\d{4}-\d{2}-\d{2})\\?["'][\s\S]{0,40}?min_c\\?["']\s*:\s*(-?[\d.]+)[\s\S]{0,40}?max_c\\?["']\s*:\s*(-?[\d.]+)[\s\S]{0,40}?condition\\?["']\s*:\s*\\?["']([^"'\\]+)\\?["'](?:[\s\S]{0,30}?rain_chance\\?["']\s*:\s*(\d+))?/g;
  const out = [];
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    out.push({
      date: m[1],
      min: parseFloat(m[2]),
      max: parseFloat(m[3]),
      condition: m[4],
      rain: m[5] !== undefined ? parseInt(m[5], 10) : null
    });
  }
  return uniqueBy(out, (d) => d.date);
}

function extractWeatherData(response, context) {
  const selected = context.agents.includes("weather_agent");
  const text = String(response.weather_results || "");
  const plan = context.planText;
  const section = findSection(plan, [/weather|climate|forecast|packing|what to wear/i], { exclude: [/day\s*\d/i] });

  let status = "generated";
  if (!selected) status = "not_selected";
  else if (!text.trim()) status = "no_data";
  else if (isDegraded(text)) status = "unavailable";

  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const temp = num(weatherKey(text, "temperature_c"));
  const feels = num(weatherKey(text, "feels_like_c"));
  const humidity = num(weatherKey(text, "humidity"));
  const wind = num(weatherKey(text, "wind_speed"));
  const condition = weatherKey(text, "condition");
  const city = weatherKey(text, "city");
  const country = weatherKey(text, "country");
  const forecast = extractForecast(text);
  const daily = extractDailyForecast(text);

  /* Fallback temperature mentioned in the itinerary's weather section. */
  let textTemp = "";
  const tm = stripMd(section).match(/(-?\d{1,2})\s*(?:–|-|to)\s*(-?\d{1,2})\s*°\s*C|(-?\d{1,2})\s*°\s*C/i);
  if (tm) textTemp = tm[3] ? `${tm[3]}°C` : `${tm[1]}–${tm[2]}°C`;

  const sectionSentences = sentences(section);

  /* Tips written inside a weather table ("Practical tip" column). */
  const tableTips = [];
  parseMarkdownTables(section).forEach((t) => {
    const col = columnIndex(t.headers, /tip|advice|pack|wear|recommend/i);
    if (col >= 0) t.rows.forEach((row) => { const tip = stripMd(row[col] || ""); if (tip) tableTips.push(tip); });
  });

  const packRe = /\bpack|bring|wear|clothing|sunscreen|umbrella|jacket|layer|hat\b/i;
  const outdoorRe = /early morning|late afternoon|evening|best time|outdoor|midday|avoid .*heat/i;
  const packing = sectionSentences.find((s) => packRe.test(s)) || tableTips.find((s) => packRe.test(s)) || "";
  const outdoor = sectionSentences.find((s) => outdoorRe.test(s)) || tableTips.find((s) => outdoorRe.test(s) && s !== packing) || "";

  return {
    selected,
    status,
    destination: field(context.destination.value, context.destination.source),
    city: field(city ? (country ? `${city}, ${country}` : city) : "", "openweather_mcp"),
    cityName: city,
    temperature: temp !== null
      ? field(`${Math.round(temp * 10) / 10}°C`, "openweather_mcp")
      : field(textTemp, "itinerary_agent"),
    feelsLike: field(feels !== null ? `${Math.round(feels * 10) / 10}°C` : "", "openweather_mcp"),
    humidity: field(humidity !== null ? `${humidity}%` : "", "openweather_mcp"),
    wind: field(wind !== null ? `${wind} m/s` : "", "openweather_mcp"),
    condition: field(condition ? condition.charAt(0).toUpperCase() + condition.slice(1) : "", "openweather_mcp"),
    outdoor: field(truncate(outdoor, 180), "itinerary_agent"),
    packing: field(truncate(packing, 180), "itinerary_agent"),
    forecast,
    daily,
    section,
    raw: text
  };
}


/* =========================================================================
   10. NORMALIZATION — BUDGET
   ========================================================================= */

function categorize(label) {
  if (TOTAL_RE.test(label)) return "total";
  const cat = BUDGET_CATEGORIES.find((c) => c.re.test(label));
  return cat ? cat.key : "other";
}

function budgetRowsFromTables(tables) {
  for (const t of tables) {
    const h = t.headers;
    const amountCols = h
      .map((name, i) => ({ name, i }))
      .filter(({ name, i }) => i > 0 && /cost|amount|price|estimate|usd|eur|bdt|aed|total|budget|low|mid|high|\$|€|£|৳|range|approx/i.test(name) && !/note|detail|description|tip|comment|assumption|basis/i.test(name));
    if (!amountCols.length) continue;

    const preferred =
      amountCols.find((c) => /mid|moderate|estimate|average|typical|approx/i.test(c.name)) || amountCols[0];
    const headerCurrency = h.map((x) => (x.match(new RegExp(CUR_TOKEN)) || [])[1]).find(Boolean) || null;

    const rows = t.rows
      .map((row) => {
        const label = stripMd(row[0] || "");
        const values = amountCols.map((c) => ({
          column: c.name,
          text: stripMd(row[c.i] || ""),
          money: parseMoney(stripMd(row[c.i] || ""), { allowPlain: Boolean(headerCurrency) || /cost|amount|price|total/i.test(c.name), defaultCurrency: headerCurrency })
        }));
        const main = values[amountCols.indexOf(preferred)];
        return { label, category: categorize(label), money: main.money, text: main.text, values };
      })
      .filter((r) => r.label && (r.money || r.text));

    if (rows.filter((r) => r.money).length >= 2) {
      return { rows, columns: amountCols.map((c) => c.name), barColumn: preferred.name, table: t };
    }
  }
  return null;
}

function budgetRowsFromBullets(markdown) {
  const rows = parseBulletPairs(markdown)
    .map((b) => {
      const category = categorize(b.label);
      const money = parseMoney(stripMd(b.value));
      return { label: b.label, category, money, text: stripMd(b.value), values: null };
    })
    .filter((r) => r.category !== "other" && r.money && r.label.length <= 60);
  return rows.length >= 2 ? { rows, columns: null, barColumn: null, table: null } : null;
}

function classifyFeasibility(text) {
  if (!text) return { tone: "muted", label: NA, summary: "" };
  const section = findSection(text, [/feasib|overall|verdict|conclusion|summary/i]) || text;
  const sentence =
    sentences(section).find((s) => /feasib|realistic|within|exceed|over budget|afford|achievable|tight/i.test(s)) || "";
  const t = sentence || stripMd(section).slice(0, 300);
  let tone = "muted";
  let label = "See analysis";
  if (/not (?:feasible|realistic|achievable)|unrealistic|exceed|over[- ]budget|insufficient|unaffordable|too (?:low|tight)/i.test(t)) {
    tone = "bad"; label = "At risk";
  } else if (/tight|stretch|borderline|challenging|possible but/i.test(t)) {
    tone = "warn"; label = "Tight";
  } else if (/feasible|realistic|within|comfortabl|achievable|affordable/i.test(t)) {
    tone = "ok"; label = "Feasible";
  }
  return { tone, label, summary: truncate(sentence, 240) };
}

function extractBudgetData(response, context) {
  const selected = context.agents.includes("budget_agent");
  const budgetText = String(response.budget_results || "");
  const planBudget = findSection(context.planText, [/budget|cost|expense|price/i], { exclude: [/day\s*\d/i] });

  /* Prefer the Budget Agent output, then the itinerary budget section. */
  const attempts = [
    { text: findSection(budgetText, [/cost|categor|estimate|breakdown/i]) || budgetText, source: "budget_agent" },
    { text: budgetText, source: "budget_agent" },
    { text: planBudget, source: "itinerary_agent" }
  ];

  let parsed = null;
  let source = "not_available";
  for (const attempt of attempts) {
    if (!attempt.text) continue;
    parsed = budgetRowsFromTables(parseMarkdownTables(attempt.text)) || budgetRowsFromBullets(attempt.text);
    if (parsed) {
      source = attempt.source;
      break;
    }
  }

  const rows = parsed ? parsed.rows : [];
  const currencies = [...new Set(rows.filter((r) => r.money).map((r) => r.money.currency).filter(Boolean))];
  const singleCurrency = currencies.length <= 1;

  /* Per-category sums (same currency only). */
  const categories = {};
  BUDGET_CATEGORIES.forEach((c) => {
    const items = rows.filter((r) => r.category === c.key && r.money);
    if (!items.length || !singleCurrency) {
      categories[c.key] = { key: c.key, label: c.label, money: null, items };
      return;
    }
    const low = items.reduce((s, r) => s + r.money.low, 0);
    const high = items.reduce((s, r) => s + moneyHigh(r.money), 0);
    categories[c.key] = {
      key: c.key,
      label: c.label,
      money: { currency: items[0].money.currency, low, high: high > low ? high : null },
      items
    };
  });

  const totalRow = rows.find((r) => r.category === "total" && r.money);
  let total = null;
  let totalKind = "not_available";
  if (totalRow) {
    total = totalRow.money;
    totalKind = "stated";
  } else if (singleCurrency && rows.filter((r) => r.category !== "total" && r.money).length >= 2) {
    const items = rows.filter((r) => r.category !== "total" && r.money);
    const low = items.reduce((s, r) => s + r.money.low, 0);
    const high = items.reduce((s, r) => s + moneyHigh(r.money), 0);
    total = { currency: items[0].money.currency, low, high: high > low ? high : null };
    totalKind = "computed";
  }

  let status = "generated";
  if (!selected && !rows.length) status = "not_selected";
  else if (!budgetText.trim() && !planBudget) status = "no_data";

  return {
    selected,
    status,
    source,
    rows,
    columns: parsed ? parsed.columns : null,
    barColumn: parsed ? parsed.barColumn : null,
    currencies,
    singleCurrency,
    categories,
    total: field(formatMoney(total), source),
    totalKind,
    totalMoney: total,
    userBudget: field(context.userBudget, "supervisor"),
    feasibility: classifyFeasibility(budgetText),
    analysis: budgetText,
    planSection: planBudget
  };
}


/* =========================================================================
   11. NORMALIZATION — ITINERARY
   ========================================================================= */

const SLOT_RE =
  /^\s*(?:[-*•+]\s*)?(?:\*\*|__)?\s*(Early morning|Morning|Late morning|Midday|Noon|Afternoon|Late afternoon|Evening|Night|Transport(?:ation)?|Getting around|Meals?|Breakfast|Lunch|Dinner|Tips?|Notes?|Stay|Accommodation|Overnight|Estimated cost|Cost|Budget)\b[^:\n*]{0,30}?(?:\*\*|__)?\s*[:\-–—]\s*(?:\*\*|__)?\s*(.*)$/i;

function slotKey(label) {
  const l = label.toLowerCase();
  if (/morning/.test(l)) return "Morning";
  if (/midday|noon|afternoon/.test(l)) return "Afternoon";
  if (/evening|night/.test(l)) return "Evening";
  if (/transport|getting around/.test(l)) return "Transport";
  if (/meal|breakfast|lunch|dinner/.test(l)) return "Meals";
  if (/stay|accommodation|overnight/.test(l)) return "Stay";
  if (/cost|budget/.test(l)) return "Cost";
  return "Notes";
}

function parseDaySlots(content) {
  const lines = String(content || "").split(/\r?\n/);
  const slots = [];
  const intro = [];
  let current = null;
  lines.forEach((line) => {
    const m = line.match(SLOT_RE);
    if (m) {
      current = { key: slotKey(m[1]), label: stripMd(m[1]), lines: [m[2]] };
      slots.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  });
  return {
    intro: intro.join("\n").trim(),
    slots: slots
      .map((s) => ({ key: s.key, label: s.label, markdown: s.lines.join("\n").trim() }))
      .filter((s) => s.markdown)
  };
}

function daysFromTable(markdown) {
  const table = parseMarkdownTables(markdown).find(
    (t) => /day/i.test(t.headers[0]) && t.rows.some((r) => /day\s*\d+|^\s*\d+\s*$/i.test(stripMd(r[0] || "")))
  );
  if (!table) return [];
  const h = table.headers;
  const titleCol = columnIndex(h, /theme|title|focus|highlight|plan|summary|area/i);
  return table.rows
    .map((row) => {
      const num = (stripMd(row[0]).match(/\d+/) || [])[0];
      if (!num) return null;
      const slots = [];
      h.forEach((name, i) => {
        if (i === 0 || i === titleCol || !row[i]) return;
        slots.push({ key: slotKey(name), label: name, markdown: row[i].replace(/<br\s*\/?>/gi, "\n") });
      });
      return {
        number: parseInt(num, 10),
        date: null,
        title: titleCol >= 0 ? stripMd(row[titleCol]) : `Day ${num}`,
        intro: "",
        slots,
        markdown: ""
      };
    })
    .filter(Boolean);
}

function daysFromHeadings(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const dayRe = /^\s*(#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*|__)?\s*Day\s*(\d{1,2})\b\s*(?:\(([^)]{1,40})\))?\s*(?:[:\-–—|.]\s*)?(.*?)\s*(?:\*\*|__)?\s*:?\s*$/i;
  const marks = [];
  lines.forEach((line, i) => {
    const m = line.match(dayRe);
    if (!m) return;
    if (line.length > 160) return; // a sentence that merely starts with "Day 1", not a header
    marks.push({
      line: i,
      level: m[1] ? m[1].trim().length : 7,
      number: parseInt(m[2], 10),
      date: m[3] ? stripMd(m[3]) : null,
      title: stripMd(m[4]).replace(/^[-–—:|.\s]+/, "")
    });
  });
  if (!marks.length) return [];

  return marks.map((mark, idx) => {
    let end = idx + 1 < marks.length ? marks[idx + 1].line : lines.length;
    /* The last day ends at the next heading of the same or higher level. */
    if (idx + 1 === marks.length) {
      for (let k = mark.line + 1; k < lines.length; k++) {
        const hm = lines[k].match(/^\s{0,3}(#{1,6})\s+/);
        if (hm && hm[1].length <= Math.min(mark.level, 6)) {
          end = k;
          break;
        }
      }
    }
    const content = lines.slice(mark.line + 1, end).join("\n").replace(/^\s*-{3,}\s*$/gm, "").trim();
    const { intro, slots } = parseDaySlots(content);
    return {
      number: mark.number,
      date: mark.date,
      title: mark.title || `Day ${mark.number}`,
      intro,
      slots,
      markdown: content
    };
  });
}

function extractItineraryData(response, context) {
  const text = context.planText;
  let days = daysFromHeadings(text);
  let method = "headings";
  if (days.length < 2) {
    const tableDays = daysFromTable(text);
    if (tableDays.length > days.length) {
      days = tableDays;
      method = "table";
    }
  }
  /* Keep the first occurrence of each day number (drafts sometimes repeat). */
  days = uniqueBy(days, (d) => d.number).sort((a, b) => a.number - b.number);

  return {
    status: text.trim() ? "generated" : "no_data",
    method: days.length ? method : "markdown",
    days,
    summary: findSection(text, [/summary|overview|at a glance/i], { exclude: [/budget|cost/i] }),
    recommendations: findSection(text, [/practical|recommendation|tips|advice|notes/i], { exclude: [/day\s*\d/i] }),
    transport: findSection(text, [/^transport|getting there|getting around|transportation/i], { exclude: [/day\s*\d/i] }),
    raw: text
  };
}


/* =========================================================================
   12. NORMALIZATION — ENTRY POINT
   ========================================================================= */

/**
 * Transform a stored session record (raw backend payload + metadata)
 * into a UI-friendly TripSession.
 */
/* Older backend versions cut agent output and appended "...[truncated]". */
function cleanAgentText(value) {
  return String(value || "").replace(/\s*\.{3}\s*\[truncated\]\s*$/i, "").replace(/\.{3}\[truncated\]/gi, "").trimEnd();
}

function normalizeTravelResponse(record) {
  const raw = record.response || {};
  const response = { ...raw };
  ["flight_results", "hotel_results", "weather_results", "budget_results", "itinerary", "answer"].forEach((key) => {
    if (typeof response[key] === "string") response[key] = cleanAgentText(response[key]);
  });
  const constraints = response.trip_constraints || record.constraints || {};
  const request = record.request || response.user_query || "";
  const agents = Array.isArray(response.selected_agents)
    ? response.selected_agents
    : Array.isArray(record.selected_agents) ? record.selected_agents : [];
  const status = record.status || deriveStatus(response);

  const fromText = parseRouteFromText(request);
  const originValue = cleanPlace(constraints.origin) || cleanPlace(fromText.origin);
  const destinationValue = cleanPlace(constraints.destination) || cleanPlace(fromText.destination);
  const durationValue = cleanPlace(constraints.duration) || parseDuration(request);

  const origin = field(originValue, cleanPlace(constraints.origin) ? "supervisor" : "request");
  const destination = field(destinationValue, cleanPlace(constraints.destination) ? "supervisor" : "request");
  const duration = field(
    /^\d+$/.test(durationValue) ? `${durationValue} days` : durationValue,
    cleanPlace(constraints.duration) ? "supervisor" : "request"
  );

  const planText = String(response.answer || response.itinerary || "");

  const context = {
    request,
    agents,
    origin,
    destination,
    planText,
    userBudget: cleanPlace(constraints.budget)
  };

  const blocked = status === "blocked" || response.guardrail_allowed === false;

  const budget = blocked ? extractBudgetData({}, { ...context, planText: "" }) : extractBudgetData(response, context);
  const flights = blocked ? extractFlightData({}, { ...context, agents: [] }) : extractFlightData(response, context);
  const hotels = blocked
    ? extractHotelData({}, { ...context, agents: [], planText: "" }, budget)
    : extractHotelData(response, context, budget);
  const weather = blocked
    ? extractWeatherData({}, { ...context, agents: [], planText: "" })
    : extractWeatherData(response, context);
  const itinerary = blocked
    ? extractItineraryData({}, { ...context, planText: "" })
    : extractItineraryData(response, context);

  return {
    thread_id: record.thread_id,
    created_at: record.created_at || null,
    updated_at: record.updated_at || null,
    request,
    origin,
    destination,
    duration,
    status,
    hydrated: Boolean(record.response),

    agents,
    guardrail: {
      allowed: !blocked,
      reason: response.guardrail_reason || (blocked ? response.answer || "" : "")
    },
    supervisor_reasoning: response.supervisor_reasoning || "",
    llm_calls: Number.isFinite(response.llm_calls) ? response.llm_calls : null,
    constraints,

    flights,
    hotels,
    weather,
    budget,
    itinerary,

    raw_answer: response.answer || "",
    raw_itinerary: response.itinerary || "",
    raw_agents: {
      flight_agent: response.flight_results || "",
      hotel_agent: response.hotel_results || "",
      weather_agent: response.weather_results || "",
      budget_agent: response.budget_results || ""
    },

    approval: {
      required: status === "draft",
      status: status === "draft" ? "pending" : status === "finalized" ? "approved" : status === "revised" ? "revision_applied" : "n/a",
      request: response.approval_request || "",
      feedback: record.feedback || response.human_feedback || ""
    }
  };
}


/* =========================================================================
   13. SESSION STORE
   ========================================================================= */

function sessionStamp(record) {
  return `${record.status}|${record.updated_at}|${record.response ? "1" : "0"}`;
}

function getRecord(threadId) {
  return appState.sessions.find((s) => s.thread_id === threadId) || null;
}

function getTrip(threadId) {
  const record = getRecord(threadId);
  if (!record) return null;
  const stamp = sessionStamp(record);
  const cached = tripCache.get(threadId);
  if (cached && cached.stamp === stamp) return cached.trip;
  const trip = normalizeTravelResponse(record);
  tripCache.set(threadId, { stamp, trip });
  return trip;
}

function getCurrentTrip() {
  return appState.currentThreadId ? getTrip(appState.currentThreadId) : null;
}

function sortSessions() {
  appState.sessions.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

function persistSessions() {
  try {
    let list = appState.sessions.slice(-MAX_STORED_SESSIONS);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        return;
      } catch (err) {
        /* Quota: drop the payload of the oldest sessions (backend still has them). */
        const withPayload = list.filter((s) => s.response);
        withPayload.slice(0, Math.ceil(withPayload.length / 2)).forEach((s) => {
          list = list.map((x) => (x.thread_id === s.thread_id ? { ...x, response: null, hydrated: false } : x));
        });
      }
    }
  } catch (err) {
    /* Storage unavailable (private mode, disabled): in-memory only. */
  }
}

function persistUiState() {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
      currentThreadId: appState.currentThreadId,
      activeView: appState.activeView
    }));
  } catch (err) {
    /* ignore */
  }
}

/** Insert or update a session record, keyed by thread_id. */
function saveSession(record) {
  const index = appState.sessions.findIndex((s) => s.thread_id === record.thread_id);
  if (index >= 0) {
    appState.sessions[index] = { ...appState.sessions[index], ...record };
  } else {
    appState.sessions.push(record);
  }
  sortSessions();
  persistSessions();
}

/** Restore session history from the browser cache. */
function loadSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(parsed)) {
      appState.sessions = parsed.filter((s) => s && typeof s.thread_id === "string");
      sortSessions();
    }
    const ui = JSON.parse(localStorage.getItem(UI_STORAGE_KEY) || "{}");
    if (ui && ui.currentThreadId && getRecord(ui.currentThreadId)) {
      appState.currentThreadId = ui.currentThreadId;
    }
    if (ui && VIEWS.includes(ui.activeView)) appState.activeView = ui.activeView;
  } catch (err) {
    appState.sessions = [];
  }
}

/** Select a trip and refresh it from the backend in the background. */
function selectSession(threadId, view) {
  if (!getRecord(threadId)) return;
  appState.currentThreadId = threadId;
  if (view) appState.activeView = view;
  hideError();
  closeSidebar();
  renderAll();
  persistUiState();

  const record = getRecord(threadId);
  if (!record.response || record.status === "draft") {
    hydrateSession(threadId);
  }
}

/* --- Optional backend persistence (GET endpoints) ----------------------- */

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    data = null;
  }
  return { response, data };
}

/** Pull one thread from PostgreSQL via the backend (authoritative). */
async function hydrateSession(threadId) {
  if (appState.backend.sessionsEndpoint === "unsupported" || appState.syncing.has(threadId)) return;
  appState.syncing.add(threadId);
  renderSidebar();
  try {
    const { response, data } = await fetchJson(API.session(threadId));
    if (response.status === 404 && !(data && data.success === false && data.error)) {
      appState.backend.sessionsEndpoint = "unsupported";
      return;
    }
    if (!response.ok || !data || !data.success) return;
    appState.backend.sessionsEndpoint = "supported";
    const record = getRecord(threadId);
    saveSession({
      thread_id: threadId,
      request: (record && record.request) || data.user_query || "",
      status: deriveStatus(data, record && record.status),
      updated_at: data.updated_at || (record && record.updated_at) || null,
      response: data,
      hydrated: true
    });
  } catch (err) {
    /* Network error: keep the cached copy. */
  } finally {
    appState.syncing.delete(threadId);
    renderAll();
  }
}

/** Merge the list of threads known to the backend into the local index. */
async function syncSessionsFromBackend() {
  try {
    const { response, data } = await fetchJson(API.sessions);
    if (response.status === 404 || response.status === 405) {
      appState.backend.sessionsEndpoint = "unsupported";
      return;
    }
    if (!response.ok || !data || !data.success || !Array.isArray(data.sessions)) return;
    appState.backend.sessionsEndpoint = "supported";

    data.sessions.forEach((s) => {
      if (!s || !s.thread_id) return;
      const existing = getRecord(s.thread_id);
      if (existing) {
        if (s.status && s.status !== existing.status) {
          saveSession({ thread_id: s.thread_id, status: s.status, updated_at: s.updated_at || existing.updated_at, response: null, hydrated: false });
        }
        return;
      }
      saveSession({
        thread_id: s.thread_id,
        request: s.user_query || "",
        created_at: s.created_at || s.updated_at || null,
        updated_at: s.updated_at || null,
        status: s.status || "unknown",
        constraints: s.trip_constraints || {},
        selected_agents: s.selected_agents || [],
        response: null,
        hydrated: false
      });
    });
  } catch (err) {
    /* Backend unreachable: local cache only. */
  } finally {
    renderAll();
    const current = appState.currentThreadId && getRecord(appState.currentThreadId);
    if (current && !current.response) hydrateSession(current.thread_id);
  }
}

async function checkHealth() {
  try {
    const response = await fetch(API.health, { cache: "no-store" });
    appState.backend.online = response.ok;
  } catch (err) {
    appState.backend.online = false;
  }
  renderStatusIndicators();
}


/* =========================================================================
   14. UI PRIMITIVES (HTML builders)
   ========================================================================= */

/* Inline SVG icon from the sprite in index.html. */
function icon(name, cls = "") {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function chip(text, tone = "muted") {
  return `<span class="chip chip-${tone}">${escapeHtml(text)}</span>`;
}

function statusChip(status) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  return chip(meta.label, meta.tone);
}

function sourceLabel(source) {
  return {
    supervisor: "your request",
    request: "your request",
    flight_agent: "flight data",
    flight_agent_estimate: "typical fares",
    itinerary_agent: "your itinerary",
    budget_agent: "the cost estimate",
    openweather_mcp: "live weather",
    not_available: ""
  }[source] ?? "";
}

function kpi({ label, value, sub = "", tone = "", src = "" }) {
  const isNa = !value;
  return `
    <div class="kpi ${tone ? `kpi-${tone}` : ""}">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value ${isNa ? "is-na" : ""}">${escapeHtml(value || NA)}</div>
      ${sub ? `<div class="kpi-sub">${escapeHtml(sub)}</div>` : ""}
      ${src && !isNa ? `<div class="kpi-src">From ${escapeHtml(src)}</div>` : ""}
    </div>`;
}

function kpiFromField(label, f, opts = {}) {
  return kpi({ label, value: f && f.value, src: f ? sourceLabel(f.source) : "", ...opts });
}

function panel({ title = "", body = "", actions = "", cls = "" }) {
  return `
    <section class="panel ${cls}">
      ${title || actions ? `
      <header class="panel-head">
        ${title ? `<h2 class="panel-title">${escapeHtml(title)}</h2>` : "<span></span>"}
        ${actions ? `<div class="panel-actions">${actions}</div>` : ""}
      </header>` : ""}
      <div class="panel-body">${body}</div>
    </section>`;
}

function notice(text, tone = "info") {
  const name = tone === "warn" ? "alert" : tone === "bad" ? "block" : "info";
  return `<div class="notice notice-${tone}">${icon(name)}<div>${text}</div></div>`;
}

function emptyState(iconName, title, text, action = "") {
  return `
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">${icon(iconName)}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text)}</p>
      ${action}
    </div>`;
}

function viewHeader({ title, sub = "", right = "" }) {
  return `
    <div class="view-head">
      <div>
        <h1>${escapeHtml(title)}</h1>
        ${sub ? `<p class="view-sub">${sub}</p>` : ""}
      </div>
      ${right ? `<div class="view-head-right">${right}</div>` : ""}
    </div>`;
}

function tableHtml(headers, rows, opts = {}) {
  if (!rows.length) return "";
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map((row) => `<tr>${headers.map((_, i) => {
            const cell = row[i] ?? "";
            const html = opts.rawHtml ? cell : escapeHtml(stripMd(cell));
            return `<td${i === 0 ? " class=\"strong\"" : ""}>${html || "—"}</td>`;
          }).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function markdownBlock(md, cls = "") {
  return md ? `<div class="md ${cls}">${markdownToHtml(md)}</div>` : "";
}

function details(summary, body, open = false) {
  return `<details class="disclosure" ${open ? "open" : ""}><summary>${escapeHtml(summary)}</summary><div class="disclosure-body">${body}</div></details>`;
}

function tripRouteLabel(trip, fallbackIndex) {
  if (has(trip.origin) && has(trip.destination)) return `${trip.origin.value} to ${trip.destination.value}`;
  if (has(trip.destination)) return trip.destination.value;
  if (trip.request) return truncate(trip.request, 42);
  return `Trip ${fallbackIndex}`;
}

function tripNumber(threadId) {
  return appState.sessions.findIndex((s) => s.thread_id === threadId) + 1;
}

/* Shared states for domain views. */
function noTripState() {
  return emptyState(
    "plane",
    "No trip open",
    "Plan a new trip, or pick one from Your trips in the sidebar.",
    `<button class="btn btn-primary" onclick="startNewTrip()">Plan a trip</button>`
  );
}

function notHydratedState(trip) {
  const syncing = appState.syncing.has(trip.thread_id);
  return emptyState(
    "refresh",
    syncing ? "Loading this trip" : "This trip isn't loaded in this browser",
    syncing
      ? "Getting your saved plan."
      : "This trip was planned in another session. Load it to see the details.",
    syncing ? "" : `<button class="btn" onclick="hydrateSession('${escapeHtml(trip.thread_id)}')">Load trip</button>`
  );
}

function agentNotSelected(agentLabel) {
  const topic = {
    "Flight Agent": "flights",
    "Hotel Agent": "hotels",
    "Weather Agent": "the weather",
    "Budget Agent": "costs"
  }[agentLabel] || "this";
  return emptyState(
    "info",
    `Nothing about ${topic} for this trip`,
    `Your request didn't ask about ${topic}, so this part wasn't planned. Start a new trip and mention it if you'd like it included.`
  );
}

function blockedState(trip) {
  return emptyState(
    "block",
    "This request wasn't planned",
    "SafrMrtah plans trips. Try something like “5 days in Lisbon from Casablanca with hotels and sightseeing”.",
    `<button class="btn btn-primary" onclick="startNewTrip()">Plan a new trip</button>`
  );
}

/** Common guard for domain views. Returns HTML to show instead, or null. */
function domainGuard(trip) {
  if (!trip) return noTripState();
  if (!trip.hydrated) return notHydratedState(trip);
  if (trip.status === "blocked") return blockedState(trip);
  return null;
}


/* =========================================================================
   15. RENDERING — SHELL (sidebar, topbar, status)
   ========================================================================= */

function domainAvailability(trip) {
  if (!trip || !trip.hydrated || trip.status === "blocked") {
    return { flights: "off", hotels: "off", weather: "off", budget: "off", itinerary: "off" };
  }
  const st = (d) => (d.status === "not_selected" ? "off" : d.status === "generated" ? "ok" : "warn");
  return {
    flights: st(trip.flights),
    hotels: st(trip.hotels),
    weather: st(trip.weather),
    budget: trip.budget.rows.length ? "ok" : trip.budget.status === "not_selected" ? "off" : trip.budget.analysis ? "warn" : "off",
    itinerary: trip.itinerary.days.length ? "ok" : trip.itinerary.raw ? "warn" : "off"
  };
}

function renderSidebar() {
  const trip = getCurrentTrip();
  const avail = domainAvailability(trip);

  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    const view = btn.dataset.view;
    btn.classList.toggle("active", view === appState.activeView);
    btn.setAttribute("aria-current", view === appState.activeView ? "page" : "false");
    const dot = btn.querySelector(".nav-dot");
    if (dot) {
      dot.className = `nav-dot ${avail[view] ? `dot-${avail[view]}` : trip ? "dot-ok" : "dot-off"}`;
      dot.title = avail[view] === "off" ? "No data for this trip" : avail[view] === "warn" ? "Partial data" : "Data available";
    }
  });

  /* Current trip card */
  const card = $("sidebarTrip");
  if (card) {
    if (!trip) {
      card.innerHTML = `<div class="side-trip-empty">No trip selected</div>`;
    } else {
      card.innerHTML = `
        <div class="side-trip-label">Trip ${tripNumber(trip.thread_id)}</div>
        <div class="side-trip-route">${escapeHtml(tripRouteLabel(trip, tripNumber(trip.thread_id)))}</div>
        <div class="side-trip-meta">${has(trip.duration) ? `<span>${escapeHtml(trip.duration.value)}</span>` : ""}${statusChip(trip.status)}</div>`;
    }
  }

  /* Sessions list */
  const list = $("sessionList");
  if (list) {
    if (!appState.sessions.length) {
      list.innerHTML = `<div class="session-empty">No trips yet. Generated plans appear here.</div>`;
    } else {
      list.innerHTML = appState.sessions.map((record, index) => {
        const t = getTrip(record.thread_id);
        const active = record.thread_id === appState.currentThreadId;
        const syncing = appState.syncing.has(record.thread_id);
        const meta = [show(t.duration, ""), formatDate(t.created_at)].filter(Boolean).join(", ");
        return `
          <button class="session-item ${active ? "active" : ""}" onclick="selectSession('${escapeHtml(record.thread_id)}')" title="${escapeHtml(t.request)}">
            <div class="session-row">
              <span class="session-num">Trip ${index + 1}</span>
              ${syncing ? `<span class="session-sync">sync…</span>` : statusChip(t.status)}
            </div>
            <div class="session-route">${escapeHtml(tripRouteLabel(t, index + 1))}</div>
            ${meta ? `<div class="session-meta">${escapeHtml(meta)}</div>` : ""}
          </button>`;
      }).join("");
    }
  }

  /* System panel */
  const sys = $("systemList");
  if (sys) {
    const mcpAgents = trip ? trip.agents.filter((a) => ["flight_agent", "hotel_agent", "weather_agent"].includes(a)).length : 0;
    const rows = [
      ["Supervisor", trip && trip.hydrated ? (trip.status === "blocked" ? "Blocked" : "Routed") : "Idle", trip && trip.hydrated ? (trip.status === "blocked" ? "bad" : "ok") : "off"],
      ["MCP", trip && trip.hydrated ? (mcpAgents ? `${mcpAgents} agent${mcpAgents > 1 ? "s" : ""}` : "Not used") : "Idle", trip && mcpAgents ? "ok" : "off"],
      ["LangGraph", trip ? "Checkpointed" : "Ready", trip ? "ok" : "off"],
      ["Human Approval", trip ? (trip.status === "draft" ? "Awaiting" : trip.status === "finalized" ? "Approved" : trip.status === "revised" ? "Revised" : "—") : "—", trip ? (trip.status === "draft" ? "warn" : ["finalized", "revised"].includes(trip.status) ? "ok" : "off") : "off"],
      ["Persistence", appState.backend.sessionsEndpoint === "supported" ? "PostgreSQL" : appState.backend.sessionsEndpoint === "unsupported" ? "Browser cache" : "Checking…", appState.backend.sessionsEndpoint === "supported" ? "ok" : "warn"]
    ];
    sys.innerHTML = rows.map(([name, state, tone]) => `
      <div class="sys-row"><span class="sys-name">${name}</span><span class="sys-state"><i class="nav-dot dot-${tone}"></i>${escapeHtml(state)}</span></div>`).join("");
  }
}

function renderTopbar() {
  const trip = getCurrentTrip();
  const crumb = $("topbarTrip");
  if (!crumb) return;
  if (!trip) {
    crumb.innerHTML = `<span class="crumb-muted">New trip</span>`;
    return;
  }
  crumb.innerHTML = `
    <span class="crumb-num">Trip ${tripNumber(trip.thread_id)}</span>
    <span class="crumb-route">${escapeHtml(tripRouteLabel(trip, tripNumber(trip.thread_id)))}</span>
    ${statusChip(trip.status)}`;
}

function renderStatusIndicators() {
  const online = appState.backend.online;
  document.querySelectorAll("[data-online]").forEach((node) => {
    node.classList.toggle("hidden", online !== false);
    node.innerHTML = `<i class="nav-dot dot-bad"></i>Can't reach SafrMrtah. Check that the app is running.`;
    node.className = `online-pill online-bad${online !== false ? " hidden" : ""}`;
  });
}

function applyView() {
  VIEWS.forEach((view) => {
    const section = $(`view-${view}`);
    if (section) section.classList.toggle("active", view === appState.activeView);
  });
}

/** Navigate to a view (sidebar item). */
function switchView(view) {
  if (!VIEWS.includes(view)) return;
  appState.activeView = view;
  const approval = $("approvalSection");
  if (approval) delete approval.dataset.expanded;
  applyView();
  renderSidebar();
  renderApproval();
  closeSidebar();
  persistUiState();
  const main = $("mainScroll");
  if (main) main.scrollTo({ top: 0, behavior: "smooth" });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* Compatibility alias with the previous frontend. */
function switchPage(page) {
  switchView(page);
}

function toggleSidebar() {
  document.body.classList.toggle("sidebar-open");
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
}


/* =========================================================================
   16. RENDERING — DASHBOARD
   ========================================================================= */

function renderAgentOrchestration(trip) {
  const steps = [
    { id: "flight_agent",    name: "Flights",          detail: "Airports, airlines and typical fares", domain: trip.flights },
    { id: "hotel_agent",     name: "Hotels",           detail: "Where to stay and nightly prices",     domain: trip.hotels },
    { id: "weather_agent",   name: "Weather",          detail: "Live conditions and the next days",    domain: trip.weather },
    { id: "budget_agent",    name: "Costs",            detail: "What the trip is likely to cost" },
    { id: "itinerary_agent", name: "Day-by-day plan",  detail: "Things to do each day" }
  ];

  const rows = [{ name: "Your request", detail: "Understood as a travel request", state: "Done", tone: "ok" }];

  steps.forEach((step) => {
    const selected = trip.agents.includes(step.id);
    let state = selected ? "Done" : "Not asked for";
    let tone = selected ? "ok" : "off";
    if (selected && step.domain && ["unavailable", "unresolved"].includes(step.domain.status)) {
      state = "Partly found";
      tone = "warn";
    }
    if (selected && step.id === "budget_agent" && !trip.budget.analysis) { state = "Not found"; tone = "warn"; }
    if (selected && step.id === "itinerary_agent" && !trip.itinerary.raw) { state = "Not found"; tone = "warn"; }
    rows.push({ name: step.name, detail: step.detail, state, tone });
  });

  rows.push({
    name: "Your approval",
    detail: trip.status === "draft" ? "Check the plan, then approve it or ask for changes" : "You reviewed this plan",
    state: trip.status === "draft" ? "Waiting for you" : trip.status === "finalized" ? "Approved" : trip.status === "revised" ? "Updated" : "—",
    tone: trip.status === "draft" ? "warn" : ["finalized", "revised"].includes(trip.status) ? "ok" : "off"
  });

  const list = rows.map((r) => `
    <li class="agent-row state-${r.tone} ${r.tone === "off" ? "is-off" : ""}">
      <span class="agent-icon" aria-hidden="true"></span>
      <div class="agent-info"><strong>${escapeHtml(r.name)}</strong><span>${escapeHtml(r.detail)}</span></div>
      <span class="agent-state ${r.tone === "ok" ? "sr-only" : ""}">${escapeHtml(r.state)}</span>
    </li>`).join("");

  return panel({ title: "What we checked", body: `<ol class="agent-list">${list}</ol>` });
}

function renderRouteBlock(trip, large = false) {
  const f = trip.flights;
  const end = (code, name, airport, label, right) => `
    <div class="route-end ${right ? "route-end-right" : ""}">
      <div class="route-tag">${label}</div>
      <div class="route-code ${has(code) ? "" : "is-na"}">${escapeHtml(show(code, "———"))}</div>
      <div class="route-name">${escapeHtml(show(name, NA))}</div>
      ${has(airport) ? `<div class="route-airport">${escapeHtml(airport.value)}</div>` : ""}
    </div>`;
  return `
    <div class="route ${large ? "route-lg" : ""}">
      ${end(f.originCode, trip.origin, f.originAirport, "From", false)}
      <div class="route-line" aria-hidden="true">${icon("plane")}</div>
      ${end(f.destinationCode, trip.destination, f.destinationAirport, "To", true)}
    </div>`;
}

const FLIGHT_STATUS_TEXT = {
  generated: ["Data returned", "ok"],
  unresolved: ["Airports unresolved", "warn"],
  unavailable: ["Unavailable", "warn"],
  no_data: ["No data", "off"],
  not_selected: ["Not requested", "off"]
};

function renderAviationCard(trip) {
  const f = trip.flights;
  const [statusText, tone] = FLIGHT_STATUS_TEXT[f.status] || ["—", "off"];
  const body = `
    ${renderRouteBlock(trip)}
    <div class="spec-grid">
      <div><span>Data provider</span><strong>${f.selected ? "AviationStack" : "—"}</strong></div>
      <div><span>Status</span><strong class="text-${tone}">${statusText}</strong></div>
      <div><span>Source</span><strong>${f.selected ? "MCP" : "—"}</strong></div>
      <div><span>Est. fare</span><strong>${escapeHtml(show(f.fare))}</strong></div>
    </div>`;
  return panel({
    eyebrow: "AVIATION INTELLIGENCE",
    title: "Flight operations",
    body,
    actions: `<button class="btn btn-ghost" onclick="switchView('flights')">Flights</button>`
  });
}

function budgetBarsHtml(budget, compact = false) {
  const cats = BUDGET_CATEGORIES.map((c) => budget.categories[c.key]).filter((c) => c && c.money);
  if (!cats.length || !budget.singleCurrency) return "";
  const max = Math.max(...cats.map((c) => moneyHigh(c.money)), 1);
  return `
    <div class="bars ${compact ? "bars-compact" : ""}" role="list">
      ${cats.map((c) => {
        const lowPct = Math.max(1.5, (c.money.low / max) * 100);
        const highPct = Math.max(lowPct, (moneyHigh(c.money) / max) * 100);
        const value = formatMoney(c.money);
        const tip = c.money.high
          ? `${c.label}: between ${formatMoney({ ...c.money, high: null })} and ${formatMoney({ ...c.money, low: c.money.high, high: null })}`
          : `${c.label}: ${value}`;
        return `
          <div class="bar-row" role="listitem" tabindex="0" aria-label="${escapeHtml(tip)}">
            <span class="bar-label">${escapeHtml(c.label)}</span>
            <span class="bar-track">
              ${c.money.high ? `<span class="bar-fill bar-range" style="width:${highPct.toFixed(1)}%"></span>` : ""}
              <span class="bar-fill" style="width:${lowPct.toFixed(1)}%"></span>
            </span>
            <span class="bar-value">${escapeHtml(value)}</span>
            <span class="bar-tip" aria-hidden="true">${escapeHtml(tip)}${c.items.length > 1 ? `, ${c.items.length} items` : ""}</span>
          </div>`;
      }).join("")}
    </div>`;
}

function renderBudgetSummaryCard(trip) {
  const b = trip.budget;
  let body;
  if (!b.rows.length) {
    body = b.analysis || b.planSection
      ? `<p class="muted" style="margin:0">The budget came back as text, without amounts that can be charted. Read it on the Budget page.</p>`
      : `<p class="muted" style="margin:0">${b.status === "not_selected" ? "No budget was requested for this trip." : NO_DATA}</p>`;
  } else {
    body = `
      ${budgetBarsHtml(b, true) || `<p class="muted" style="margin:0">The amounts use different currencies, so they aren't charted together.</p>`}
      <div class="total-line">
        <span>${b.totalKind === "computed" ? "Listed items added up" : "Estimated total"}</span>
        <strong>${escapeHtml(show(b.total))}</strong>
      </div>`;
  }
  return panel({
    title: "Estimated costs",
    body,
    actions: `<button class="btn btn-ghost" onclick="switchView('budget')">Budget details</button>`
  });
}

function firstSlotSummary(day) {
  const text = day.slots.length ? day.slots[0].markdown : day.intro || day.markdown;
  return truncate(stripMd(proseOnly(text)), 120);
}

function renderItineraryPreviewCard(trip) {
  const days = trip.itinerary.days;
  const body = days.length
    ? `<ol class="day-preview">${days.slice(0, 7).map((d) => `
        <li>
          <span class="day-badge">Day ${d.number}</span>
          <div><strong>${escapeHtml(d.title)}</strong><span>${escapeHtml(firstSlotSummary(d))}</span></div>
        </li>`).join("")}</ol>
       ${days.length > 7 ? `<p class="muted small">and ${days.length - 7} more days</p>` : ""}`
    : `<p class="muted" style="margin:0">${trip.itinerary.raw ? "The plan couldn't be split into days. Read it as written on the Itinerary page." : NO_DATA}</p>`;
  return panel({
    title: days.length ? `${days.length} days, day by day` : "Day by day",
    body,
    actions: `<button class="btn btn-ghost" onclick="switchView('itinerary')">Open itinerary</button>`
  });
}

function renderDashboard() {
  const trip = getCurrentTrip();
  const planner = $("plannerCard");
  const content = $("dashboardContent");
  if (!planner || !content) return;

  const generating = appState.isLoading && appState.loadingKind === "generate";
  planner.classList.toggle("hidden", Boolean(trip));
  $("runningPanel").classList.toggle("hidden", !generating);

  if (!trip) {
    content.innerHTML = generating ? "" : `
      <div class="capability-grid">
        ${[
          ["plane", "Flights", "Airports, airlines and typical fares"],
          ["bed", "Hotels", "Good areas and places to stay"],
          ["cloud", "Weather", "Current conditions and a 5-day forecast"],
          ["wallet", "Budget", "Cost per category and whether it fits your budget"],
          ["calendar", "Itinerary", "Morning, afternoon and evening for each day"]
        ].map(([ic, name, text]) => `
          <div class="capability">
            <span class="capability-icon">${icon(ic)}</span>
            <strong>${name}</strong>
            <span>${text}</span>
          </div>`).join("")}
      </div>`;
    return;
  }

  if (!trip.hydrated) {
    content.innerHTML = notHydratedState(trip);
    return;
  }

  if (trip.status === "blocked") {
    content.innerHTML = notice(
      `<strong>This request wasn't planned.</strong> SafrMrtah plans trips. Try something like “5 days in Lisbon from Casablanca with hotels and sightseeing”.`,
      "bad"
    ) + `<div class="center-row"><button class="btn btn-primary" onclick="startNewTrip()">Plan a new trip</button></div>`;
    return;
  }

  const h = trip.hotels;
  const w = trip.weather;
  const b = trip.budget;

  const hotelValue = h.status === "not_selected"
    ? "Not asked for"
    : has(h.recommended) ? h.recommended.value : has(h.optionsCount) ? `${h.optionsCount.value} options` : "";
  const weatherValue = w.status === "not_selected" ? "Not asked for" : show(w.temperature, "");

  const figures = `
    <div class="kpi-grid kpi-grid-4">
      ${kpi({ label: "Destination", value: show(trip.destination, ""), sub: has(trip.duration) ? trip.duration.value : "" })}
      ${kpi({ label: "Where to stay", value: hotelValue, sub: has(h.nightly) ? `${h.nightly.value} a night` : has(h.nights) ? h.nights.value : "" })}
      ${kpi({ label: "Weather now", value: weatherValue, sub: has(w.condition) ? w.condition.value : "" })}
      ${kpi({ label: "Estimated total", value: b.status === "not_selected" && !b.rows.length ? "Not asked for" : show(b.total, ""), sub: b.feasibility.label !== NA ? b.feasibility.label : "", tone: b.feasibility.tone === "bad" ? "bad" : "" })}
    </div>`;

  content.innerHTML = `
    ${renderTripHeader(trip)}
    ${figures}
    <div class="grid-2">
      <div>
        ${renderItineraryPreviewCard(trip)}
        ${renderBudgetSummaryCard(trip)}
      </div>
      <div>
        ${renderAgentOrchestration(trip)}
      </div>
    </div>`;
}

/* The boarding pass: the one bold element of the interface. */
function renderTripHeader(trip) {
  const n = tripNumber(trip.thread_id);
  const f = trip.flights;
  const code = (fld) => `<div class="pass-code ${has(fld) ? "" : "is-na"}">${escapeHtml(show(fld, "———"))}</div>`;
  return `
    <div class="pass">
      <div class="pass-main">
        <div class="pass-top">
          <span>Trip ${n}, planned ${escapeHtml(formatDateTime(trip.created_at) || "in this session")}</span>
          ${statusChip(trip.status)}
        </div>
        <div class="pass-route">
          <div class="pass-end">
            ${code(f.originCode)}
            <div class="pass-city">${escapeHtml(show(trip.origin, "Origin not given"))}</div>
            ${has(f.originAirport) ? `<div class="pass-airport">${escapeHtml(f.originAirport.value)}</div>` : ""}
          </div>
          <div class="pass-line" aria-hidden="true">${icon("plane")}</div>
          <div class="pass-end pass-end-right">
            ${code(f.destinationCode)}
            <div class="pass-city">${escapeHtml(show(trip.destination, "Destination not given"))}</div>
            ${has(f.destinationAirport) ? `<div class="pass-airport">${escapeHtml(f.destinationAirport.value)}</div>` : ""}
          </div>
        </div>
        ${trip.request ? `<p class="pass-request">You asked: “${escapeHtml(truncate(trip.request, 200))}”</p>` : ""}
      </div>
      <div class="pass-stub">
        <div class="stub-row"><span>Length</span><strong>${escapeHtml(show(trip.duration))}</strong></div>
        <div class="stub-row"><span>Typical fare</span><strong>${escapeHtml(f.selected ? show(f.fare) : "Not asked for")}</strong></div>
        <div class="stub-row"><span>Flight time</span><strong>${escapeHtml(f.selected ? show(f.duration) : "Not asked for")}</strong></div>
        <button class="btn btn-sm" onclick="switchView('report')">Read the full plan</button>
      </div>
    </div>`;
}


/* =========================================================================
   17. RENDERING — FLIGHTS
   ========================================================================= */

function renderFlights() {
  const root = $("flightsContent");
  if (!root) return;
  const trip = getCurrentTrip();
  const head = viewHeader({
    eyebrow: "FLIGHT INTELLIGENCE",
    title: "Flights",
    sub: "Airports, airlines and typical fares for your route. Fares are a guide, so check the airline before booking.",
    right: trip ? statusChip(trip.status) : ""
  });

  const guard = domainGuard(trip);
  if (guard) {
    root.innerHTML = head + guard;
    return;
  }
  const f = trip.flights;
  if (f.status === "not_selected") {
    root.innerHTML = head + agentNotSelected("Flight Agent");
    return;
  }

  let banner = "";
  if (f.status === "unresolved") {
    banner = notice("The airport codes for this route couldn't be confirmed, so no flight schedule was fetched. Try naming the cities or airports more precisely.", "warn", "!");
  } else if (f.status === "unavailable") {
    banner = notice("Live flight information couldn't be reached for this trip. Try again in a few minutes.", "warn");
  } else if (f.status === "no_data") {
    banner = notice(NO_DATA, "info");
  }

  const kpis = `
    <div class="kpi-grid kpi-grid-5">
      ${kpi({ label: "Route", value: has(f.originCode) && has(f.destinationCode) ? `${f.originCode.value}–${f.destinationCode.value}` : "", sub: has(f.origin) && has(f.destination) ? `${f.origin.value} to ${f.destination.value}` : "" })}
      ${kpi({ label: "Airlines", value: f.airlines.length ? `${f.airlines.length} airline${f.airlines.length > 1 ? "s" : ""}` : "", sub: f.airlines.slice(0, 3).join(", ") })}
      ${kpi({ label: "Stops", value: show(f.stops, "") })}
      ${kpi({ label: "Flight time", value: show(f.duration, "") })}
      ${kpi({ label: "Typical fare", value: show(f.fare, ""), sub: has(f.fare) ? "A guide, not a live price" : "" })}
    </div>`;

  const options = f.optionsTable
    ? panel({ eyebrow: "FLIGHT OPTIONS", title: "Flight options", body: tableHtml(f.optionsTable.headers, f.optionsTable.rows) })
    : panel({ eyebrow: "FLIGHT OPTIONS", title: "Flight options", body: `<p class="muted">No specific flights were listed for this route. The advice below explains your options.</p>` });

  const airlines = f.airlines.length
    ? panel({ eyebrow: "AIRLINES", title: "Airlines on this route", body: `<div class="tag-row">${f.airlines.map((a) => chip(a, "info")).join("")}</div>` })
    : "";

  root.innerHTML = `
    ${head}
    ${banner}
    ${panel({ eyebrow: "ROUTE", title: has(f.origin) && has(f.destination) ? `${f.origin.value} to ${f.destination.value}` : "Route", body: renderRouteBlock(trip, true) })}
    ${kpis}
    ${options}
    ${airlines}
    ${panel({
      eyebrow: "FLIGHT AGENT OUTPUT",
      title: "Flight advice",
      body: markdownBlock(f.raw) || `<p class="muted">${NO_DATA}</p>`,
      actions: ""
    })}`;
}


/* =========================================================================
   18. RENDERING — HOTELS
   ========================================================================= */

function renderHotels() {
  const root = $("hotelsContent");
  if (!root) return;
  const trip = getCurrentTrip();
  const head = viewHeader({
    eyebrow: "HOTEL INTELLIGENCE",
    title: "Hotels",
    sub: "Where to stay, what it costs, and links to look at the places yourself.",
    right: trip ? statusChip(trip.status) : ""
  });

  const guard = domainGuard(trip);
  if (guard) {
    root.innerHTML = head + guard;
    return;
  }
  const h = trip.hotels;
  if (h.status === "not_selected") {
    root.innerHTML = head + agentNotSelected("Hotel Agent");
    return;
  }

  const banner = h.status === "unavailable"
    ? notice("The live hotel search didn't respond, so these suggestions come from the itinerary only.", "warn", "!")
    : "";

  const summary = `
    <div class="kpi-grid kpi-grid-3">
      ${kpiFromField("Destination", h.destination, { icon: "⌖" })}
      ${kpiFromField("Nights", h.nights, { icon: "☾" })}
      ${kpiFromField("Recommended area", h.area, { icon: "◫" })}
    </div>
    <div class="kpi-grid kpi-grid-4">
      ${kpiFromField("Recommended hotel", h.recommended, { icon: "★" })}
      ${kpiFromField("Nightly price", h.nightly, { icon: "$", sub: has(h.nightly) ? "Range across listed options" : "" })}
      ${kpiFromField("Total accommodation", h.total, { icon: "Σ" })}
      ${kpiFromField("Options", h.optionsCount, { icon: "▤" })}
    </div>`;

  const optionsTable = h.options.length
    ? tableHtml(
        ["Hotel", "Area", "Price / night", "Total", "Rating", "Why recommended"],
        h.options.map((o) => [
          escapeHtml(o.name),
          escapeHtml(o.area || NA),
          escapeHtml(o.price ? formatMoney(o.price) : o.priceText || NA),
          escapeHtml(o.total ? formatMoney(o.total) : NA),
          escapeHtml(o.rating || NA),
          escapeHtml(o.why || NA)
        ]),
        { rawHtml: true }
      )
    : `<p class="muted">No list of specific hotels was generated. The advice below covers where to stay.</p>`;

  const sources = h.sources.length
    ? `<ul class="source-list">${h.sources.map((s) => `
        <li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(s.title, 90))}</a>
        <span>${escapeHtml((s.url.match(/^https?:\/\/([^/]+)/) || [])[1] || "")}</span></li>`).join("")}</ul>`
    : `<p class="muted">No links were found.</p>`;

  root.innerHTML = `
    ${head}
    ${banner}
    ${summary}
    ${panel({ eyebrow: "HOTEL OPTIONS", title: "Hotels to consider", body: optionsTable })}
    <div class="grid-2">
      ${panel({ eyebrow: "ACCOMMODATION GUIDANCE", title: "Where to stay", body: markdownBlock(h.section) || `<p class="muted">${NO_DATA}</p>` })}
      ${panel({ eyebrow: "SEARCH SOURCES", title: "See them online", body: sources, actions: "" })}
    </div>
`;
}


/* =========================================================================
   19. RENDERING — WEATHER
   ========================================================================= */

function renderWeather() {
  const root = $("weatherContent");
  if (!root) return;
  const trip = getCurrentTrip();
  const head = viewHeader({
    eyebrow: "WEATHER INTELLIGENCE",
    title: "Weather",
    sub: "Today's weather at your destination and the next few days.",
    right: trip ? statusChip(trip.status) : ""
  });

  const guard = domainGuard(trip);
  if (guard) {
    root.innerHTML = head + guard;
    return;
  }
  const w = trip.weather;
  if (w.status === "not_selected") {
    root.innerHTML = head + agentNotSelected("Weather Agent");
    return;
  }

  const banner = w.status === "unavailable"
    ? notice("Live weather couldn't be fetched for this destination. OpenWeather didn't recognise the city, or the service didn't answer.", "warn", "!")
    : "";

  const cityName = (w.cityName || "").toLowerCase();
  const cityMismatch = Boolean(cityName) && has(w.destination) && !w.destination.value.toLowerCase().includes(cityName) && !cityName.includes(w.destination.value.toLowerCase());

  const hero = `
    <div class="weather-hero">
      <div>
        <div class="weather-city">${escapeHtml(show(w.destination))}</div>
        ${has(w.city) ? `<div class="muted small">Readings for ${escapeHtml(w.city.value)}</div>` : ""}
      </div>
      <div class="weather-now">
        <div class="weather-temp ${has(w.temperature) ? "" : "is-na"}">${escapeHtml(show(w.temperature))}</div>
        <div class="weather-cond">${escapeHtml(show(w.condition, ""))}</div>
        ${has(w.temperature) ? `<div class="kpi-src">From ${escapeHtml(sourceLabel(w.temperature.source))}</div>` : ""}
      </div>
    </div>
    ${cityMismatch ? notice(`The weather tool returned data for <strong>${escapeHtml(w.city.value)}</strong>, which differs from the trip destination. Treat these readings with caution.`, "warn", "!") : ""}`;

  const kpis = `
    <div class="kpi-grid kpi-grid-3">
      ${kpiFromField("Feels like", w.feelsLike, { icon: "≈" })}
      ${kpiFromField("Humidity", w.humidity, { icon: "◌" })}
      ${kpiFromField("Wind", w.wind, { icon: "➶" })}
    </div>
    <div class="kpi-grid kpi-grid-2">
      ${kpiFromField("Best time to be outside", w.outdoor, { tone: "text" })}
      ${kpiFromField("What to pack", w.packing, { tone: "text" })}
    </div>`;

  const fmtDay = (iso) => {
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
  };
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  /* Daily range chart: one bar per day from min to max on a shared scale. */
  let forecastChart = "";
  if (w.daily.length) {
    const lo = Math.min(...w.daily.map((d) => d.min));
    const hi = Math.max(...w.daily.map((d) => d.max));
    const span = Math.max(hi - lo, 1);
    forecastChart = `<div class="forecast" role="list">${w.daily.map((d) => {
      const left = ((d.min - lo) / span) * 100;
      const width = Math.max(3, ((d.max - d.min) / span) * 100);
      const label = `${fmtDay(d.date)}: ${Math.round(d.min)} to ${Math.round(d.max)}°C, ${d.condition}${d.rain === null ? "" : `, ${d.rain}% chance of rain`}`;
      return `
        <div class="fc-row" role="listitem" tabindex="0" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
          <span class="fc-day">${escapeHtml(fmtDay(d.date))}</span>
          <span class="fc-min">${Math.round(d.min)}°</span>
          <span class="fc-track"><span class="fc-bar" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span></span>
          <span class="fc-max">${Math.round(d.max)}°</span>
          <span class="fc-cond">${escapeHtml(cap(d.condition))}</span>
          <span class="fc-rain">${d.rain === null ? "" : `${d.rain}%`}</span>
        </div>`;
    }).join("")}</div>
    <p class="muted small" style="margin:12px 0 0">The next ${w.daily.length} days from today, not necessarily your travel dates.</p>
    ${details("Show as a table", tableHtml(
      ["Day", "Low", "High", "Condition", "Chance of rain"],
      w.daily.map((d) => [fmtDay(d.date), `${Math.round(d.min)}°C`, `${Math.round(d.max)}°C`, cap(d.condition), d.rain === null ? NA : `${d.rain}%`])
    ))}`;
  }

  const forecast = w.daily.length
    ? forecastChart
    : w.forecast.length
    ? tableHtml(
        ["Time", "Temperature", "Condition"],
        w.forecast.map((x) => [x.datetime, `${Math.round(x.temperature * 10) / 10}°C`, cap(x.condition)])
      ) + `<p class="muted small">The next few 3-hour readings from OpenWeather, not a forecast for your travel dates.</p>`
    : `<p class="muted">No forecast came back.</p>`;

  root.innerHTML = `
    ${head}
    ${banner}
    ${panel({ body: hero })}
    ${kpis}
    <div class="grid-2">
      ${panel({ eyebrow: "FORECAST", title: w.daily.length ? `Next ${w.daily.length} days` : "Next few hours", body: forecast })}
      ${panel({ eyebrow: "RECOMMENDATIONS", title: "Advice from your itinerary", body: markdownBlock(w.section) || `<p class="muted">${NO_DATA}</p>` })}
    </div>
`;
}


/* =========================================================================
   20. RENDERING — BUDGET
   ========================================================================= */

function renderBudget() {
  const root = $("budgetContent");
  if (!root) return;
  const trip = getCurrentTrip();
  const head = viewHeader({
    eyebrow: "BUDGET INTELLIGENCE",
    title: "Budget",
    sub: "Roughly what this trip will cost. Prices are estimates, not live quotes.",
    right: trip ? statusChip(trip.status) : ""
  });

  const guard = domainGuard(trip);
  if (guard) {
    root.innerHTML = head + guard;
    return;
  }
  const b = trip.budget;
  if (b.status === "not_selected") {
    root.innerHTML = head + agentNotSelected("Budget Agent");
    return;
  }

  const hero = `
    <div class="budget-hero">
      <div>
        <div class="budget-kicker">${b.totalKind === "computed" ? "Listed items added up" : "Estimated total"}</div>
        <div class="budget-total ${has(b.total) ? "" : "is-na"}">${escapeHtml(show(b.total))}</div>
        <div class="muted small">
          ${has(b.total) ? (b.totalKind === "computed" ? "The items below added together." : "Estimated for the whole trip.") : "No total was given for this trip."}
        </div>
      </div>
      <div class="budget-hero-side">
        <div><span>Your budget</span><strong>${escapeHtml(show(b.userBudget, "Not stated"))}</strong></div>
        <div><span>Does it fit?</span>${chip(b.feasibility.label, b.feasibility.tone)}</div>
      </div>
    </div>
    ${b.feasibility.summary ? `<p class="feasibility-note">${escapeHtml(b.feasibility.summary)}</p>` : ""}`;

  const cards = `
    <div class="kpi-grid kpi-grid-6">
      ${BUDGET_CATEGORIES.map((c) => {
        const cat = b.categories[c.key];
        return kpi({ label: c.label, value: cat && cat.money ? formatMoney(cat.money) : "", sub: cat && cat.items.length > 1 ? `${cat.items.length} items` : "" });
      }).join("")}
    </div>`;

  let breakdown;
  if (!b.rows.length) {
    breakdown = notice("The budget came back as text without amounts, so there is nothing to chart. It is shown in full below.", "info");
  } else if (!b.singleCurrency) {
    breakdown = notice(`Amounts are in several currencies (${escapeHtml(b.currencies.join(", "))}), so they are not charted together.`, "info");
  } else {
    breakdown = budgetBarsHtml(b) + `<div class="legend"><span><i class="lg lg-solid"></i>Low estimate</span><span><i class="lg lg-range"></i>Upper range</span></div>`;
  }

  const itemsTable = b.rows.length
    ? tableHtml(
        b.columns ? ["Item", "Category", ...b.columns] : ["Item", "Category", "Amount"],
        b.rows.map((r) => [
          r.label,
          r.category === "other" ? "Other" : r.category === "total" ? "Total" : (BUDGET_CATEGORIES.find((c) => c.key === r.category) || {}).label,
          ...(r.values ? r.values.map((v) => v.text || "—") : [r.money ? formatMoney(r.money) : r.text])
        ])
      )
    : "";

  root.innerHTML = `
    ${head}
    ${panel({ body: hero })}
    ${cards}
    <div class="grid-2">
      ${panel({ eyebrow: "BUDGET BREAKDOWN", title: "Cost by category", body: breakdown })}
      ${panel({ eyebrow: "LINE ITEMS", title: "Each cost", body: itemsTable || `<p class="muted">${NO_DATA}</p>` })}
    </div>
    ${panel({
      eyebrow: "BUDGET AGENT OUTPUT",
      title: "Risks and ways to save",
      body: markdownBlock(b.analysis) || markdownBlock(b.planSection) || `<p class="muted">${NO_DATA}</p>`
    })}`;
}


/* =========================================================================
   21. RENDERING — ITINERARY
   ========================================================================= */

const SLOT_ORDER = ["Morning", "Afternoon", "Evening", "Transport", "Meals", "Stay", "Cost", "Notes"];
const SLOT_ICON = { Morning: "◔", Afternoon: "◑", Evening: "◕", Transport: "⇄", Meals: "◍", Stay: "▣", Cost: "$", Notes: "✎" };

function renderDayCard(day) {
  const slots = [...day.slots].sort((a, b) => SLOT_ORDER.indexOf(a.key) - SLOT_ORDER.indexOf(b.key));
  const slotHtml = slots.length
    ? `<div class="slots">${slots.map((s) => `
        <div class="slot slot-${s.key.toLowerCase()}">
          <div class="slot-label">${escapeHtml(s.label)}</div>
          <div class="slot-body md">${markdownToHtml(s.markdown)}</div>
        </div>`).join("")}</div>`
    : "";
  const intro = day.intro ? `<div class="md day-intro">${markdownToHtml(day.intro)}</div>` : "";
  const fallback = !slots.length && !day.intro && day.markdown ? markdownBlock(day.markdown) : "";
  return `
    <article class="day-card">
      <div class="day-rail"><span class="day-num-label">Day</span><span class="day-num">${day.number}</span></div>
      <div class="day-main">
        <header class="day-head">
          <h3>${escapeHtml(day.title)}</h3>
          ${day.date ? `<div class="day-date">${escapeHtml(day.date)}</div>` : ""}
        </header>
        ${intro}
        ${slotHtml}
        ${fallback}
      </div>
    </article>`;
}

function renderItinerary() {
  const root = $("itineraryContent");
  if (!root) return;
  const trip = getCurrentTrip();
  const head = viewHeader({
    eyebrow: "AI GENERATED ITINERARY",
    title: "Itinerary",
    sub: "Your plan for each day.",
    right: trip ? statusChip(trip.status) : ""
  });

  const guard = domainGuard(trip);
  if (guard) {
    root.innerHTML = head + guard;
    return;
  }
  const it = trip.itinerary;

  const facts = `
    <div class="kpi-grid kpi-grid-4">
      ${kpi({ label: "Trip", value: has(trip.origin) && has(trip.destination) ? `${trip.origin.value} to ${trip.destination.value}` : show(trip.destination, ""), icon: "✈" })}
      ${kpiFromField("Duration", trip.duration, { icon: "◷" })}
      ${kpi({ label: "Days planned", value: it.days.length ? String(it.days.length) : "", icon: "☷", sub: "" })}
      ${kpi({ label: "Status", value: (STATUS_META[trip.status] || STATUS_META.unknown).label, icon: "◉", tone: (STATUS_META[trip.status] || STATUS_META.unknown).tone })}
    </div>`;

  if (!it.raw) {
    root.innerHTML = head + facts + emptyState("calendar", NO_DATA, "No day-by-day plan came back for this trip. Try planning it again.");
    return;
  }

  if (!it.days.length) {
    root.innerHTML = `
      ${head}
      ${facts}
      ${notice("This itinerary isn't split into clear days, so it is shown exactly as written.", "info")}
      ${panel({ eyebrow: "FULL ITINERARY", title: "Itinerary as written", body: markdownBlock(it.raw) })}`;
    return;
  }

  root.innerHTML = `
    ${head}
    ${facts}
    ${it.summary ? panel({ eyebrow: "TRIP SUMMARY", title: "Summary", body: markdownBlock(it.summary) }) : ""}
    <h2 class="section-title">Day by day</h2>
    <div class="timeline">${it.days.map(renderDayCard).join("")}</div>
    <div class="grid-2">
      ${it.transport ? panel({ eyebrow: "TRANSPORT", title: "Getting there & around", body: markdownBlock(it.transport) }) : ""}
      ${it.recommendations ? panel({ eyebrow: "RECOMMENDATIONS", title: "Practical tips", body: markdownBlock(it.recommendations) }) : ""}
    </div>
    <div class="center-row"><button class="btn" onclick="switchView('report')">Read the full plan as written</button></div>`;
}


/* =========================================================================
   22. RENDERING — FULL AI PLAN (raw answer, copy, PDF)
   ========================================================================= */

function renderReport() {
  const meta = $("reportMeta");
  const box = $("resultBox");
  const pdfHeader = $("pdfHeader");
  const empty = $("reportEmpty");
  const body = $("reportBody");
  if (!meta || !box) return;

  const trip = getCurrentTrip();
  if (!trip || !trip.hydrated || !trip.raw_answer) {
    empty.innerHTML = trip && !trip.hydrated ? notHydratedState(trip) : noTripState();
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");
  body.classList.remove("hidden");

  const isDraft = trip.status === "draft";
  $("resultTitle").textContent = isDraft ? "Draft plan" : trip.status === "blocked" ? "Request not planned" : "Full plan";
  meta.innerHTML = `
    ${statusChip(trip.status)}
    ${trip.approval.feedback ? `<span class="small muted">You asked for: “${escapeHtml(truncate(trip.approval.feedback, 120))}”</span>` : ""}`;

  pdfHeader.innerHTML = `
    <div class="pdf-brand">SafrMrtah travel plan</div>
    <h1 class="pdf-title">${escapeHtml(tripRouteLabel(trip, tripNumber(trip.thread_id)))}</h1>
    <div class="pdf-meta">
      ${escapeHtml([
        (STATUS_META[trip.status] || STATUS_META.unknown).label,
        show(trip.duration, ""),
        formatDate(trip.created_at) ? `planned ${formatDate(trip.created_at)}` : ""
      ].filter(Boolean).join(", "))}
    </div>`;

  box.innerHTML = markdownToHtml(trip.raw_answer);

}


/* =========================================================================
   23. RENDERING — HUMAN-IN-THE-LOOP
   ========================================================================= */

function renderApproval() {
  const section = $("approvalSection");
  if (!section) return;
  const trip = getCurrentTrip();
  const pending = Boolean(trip && trip.hydrated && trip.status === "draft");
  appState.waitingForApproval = pending;
  section.classList.toggle("hidden", !pending);
  if (!pending) return;
  const full = ["dashboard", "itinerary", "report"].includes(appState.activeView);
  if (full) section.classList.remove("is-compact");
  else if (!section.dataset.expanded) section.classList.add("is-compact");
  $("approvalRequest").textContent =
    "Approve it if it looks right, or tell us what to change and we'll update it.";
  $("approvalTrip").textContent = `Trip ${tripNumber(trip.thread_id)}, ${tripRouteLabel(trip, tripNumber(trip.thread_id))}`;
}

/** Full re-render of the shell and all views. */
function renderAll() {
  renderSidebar();
  renderTopbar();
  renderApproval();
  renderDashboard();
  renderFlights();
  renderHotels();
  renderWeather();
  renderBudget();
  renderItinerary();
  renderReport();
  renderStatusIndicators();
  applyView();
  setControlsDisabled(appState.isLoading);
}


/* =========================================================================
   24. LOADING / ERRORS
   ========================================================================= */

function setControlsDisabled(disabled) {
  ["sendBtn", "approveBtn", "reviseBtn"].forEach((id) => {
    const node = $(id);
    if (node) node.disabled = disabled;
  });
}

function setLoading(isLoading, label) {
  appState.isLoading = isLoading;
  appState.loadingKind = isLoading ? label || null : null;
  setControlsDisabled(isLoading);

  const btnText = $("btnText");
  const btnLoader = $("btnLoader");
  if (btnText && btnLoader) {
    btnText.classList.toggle("hidden", isLoading);
    btnLoader.classList.toggle("hidden", !isLoading);
  }

  const running = $("runningPanel");
  if (running) {
    running.classList.toggle("hidden", !isLoading || label !== "generate");
  }
  const approvalBusy = $("approvalBusy");
  if (approvalBusy) approvalBusy.classList.toggle("hidden", !(isLoading && label === "approve"));

  clearInterval(loadingTimer);
  if (isLoading) {
    appState.loadingStartedAt = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - appState.loadingStartedAt) / 1000);
      document.querySelectorAll("[data-elapsed]").forEach((n) => {
        n.textContent = `${Math.floor(s / 60)}:${pad2(s % 60)}`;
      });
    };
    tick();
    loadingTimer = setInterval(tick, 1000);
  }
}

function showError(message) {
  const box = $("errorBox");
  if (!box) return;
  box.innerHTML = `<span>✕</span><div>${escapeHtml(message)}</div><button class="error-close" onclick="hideError()" aria-label="Dismiss">×</button>`;
  box.classList.remove("hidden");
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideError() {
  const box = $("errorBox");
  if (box) {
    box.classList.add("hidden");
    box.innerHTML = "";
  }
}


/* =========================================================================
   25. PUBLIC ACTIONS (preserved API: sendMessage, submitApproval,
       copyResult, downloadPDF)
   ========================================================================= */

function setPrompt(text) {
  const input = $("userInput");
  input.value = text;
  input.focus();
}

/** Show the planner for a brand-new trip (next request = new thread). */
function startNewTrip() {
  appState.currentThreadId = null;
  appState.activeView = "dashboard";
  hideError();
  closeSidebar();
  renderAll();
  persistUiState();
  const input = $("userInput");
  if (input) input.focus();
}

/**
 * POST /api/travel
 * 1. read userInput  2. POST  3. receive JSON  4. store thread_id
 * 5. show workflow   6. show draft result      7. show approval if required
 */
async function sendMessage() {
  hideError();
  if (appState.isLoading) return;

  const input = $("userInput");
  const message = input.value.trim();
  if (!message) {
    showError("Please enter your travel request first.");
    input.focus();
    return;
  }

  /* Each request is a new trip → new LangGraph thread (thread_id: null).
     Reusing a finished thread would mix two trips in one checkpoint history. */
  appState.currentThreadId = null;
  appState.activeView = "dashboard";
  setLoading(true, "generate");
  renderAll();

  try {
    const response = await fetch(API.travel, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, thread_id: null })
    });

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }

    if (!response.ok || !data || !data.success) {
      throw new Error((data && data.error) || `Request failed (HTTP ${response.status}).`);
    }

    const now = new Date().toISOString();
    saveSession({
      thread_id: data.thread_id,
      request: message,
      created_at: now,
      updated_at: now,
      status: deriveStatus(data),
      response: data,
      hydrated: true
    });

    input.value = "";
    appState.currentThreadId = data.thread_id;
    appState.activeView = "dashboard";
    persistUiState();
  } catch (error) {
    showError(error.message || "Could not generate the travel plan.");
  } finally {
    setLoading(false);
    renderAll();
  }
}

/**
 * POST /api/travel/approve
 * Resumes the paused LangGraph thread of the CURRENT trip.
 */
async function submitApproval(approved) {
  hideError();
  const trip = getCurrentTrip();

  if (!trip || trip.status !== "draft" || !appState.currentThreadId) {
    showError("There is no draft waiting for approval for the selected trip.");
    return;
  }

  const feedbackInput = $("approvalFeedback");
  const feedback = feedbackInput.value.trim();

  /* In the compact bar, "Request changes" first opens the feedback field. */
  const section = $("approvalSection");
  if (!approved && section && section.classList.contains("is-compact")) {
    section.classList.remove("is-compact");
    section.dataset.expanded = "1";
    feedbackInput.focus();
    return;
  }

  if (!approved && !feedback) {
    showError("Please describe the revision you want before requesting changes.");
    feedbackInput.focus();
    return;
  }

  const threadId = appState.currentThreadId;
  setLoading(true, "approve");

  try {
    const response = await fetch(API.approve, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: threadId, approved, feedback })
    });

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }

    if (!response.ok || !data || !data.success) {
      throw new Error((data && data.error) || `Could not resume the travel workflow (HTTP ${response.status}).`);
    }

    const record = getRecord(threadId);
    let status = deriveStatus(data, "draft");
    if (!data.requires_approval) status = approved ? "finalized" : "revised";

    saveSession({
      thread_id: data.thread_id || threadId,
      request: record ? record.request : "",
      updated_at: new Date().toISOString(),
      status,
      feedback: approved ? "" : feedback,
      response: data,
      hydrated: true
    });

    feedbackInput.value = "";
  } catch (error) {
    showError(error.message || "Could not finalize the travel plan.");
  } finally {
    setLoading(false);
    renderAll();
  }
}

function copyResult() {
  const box = $("resultBox");
  const text = box ? box.innerText.trim() : "";
  if (!text) {
    showError("No travel plan available to copy.");
    return;
  }
  const button = document.querySelector(".copy-btn");
  const done = () => {
    if (!button) return;
    const old = button.textContent;
    button.textContent = "✓ Copied";
    setTimeout(() => { button.textContent = old; }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => showError("Could not copy result."));
  } else {
    showError("Clipboard is not available in this browser.");
  }
}

function downloadPDF() {
  const trip = getCurrentTrip();
  const pdfContent = $("pdfContent");
  if (!trip || !trip.raw_answer || !pdfContent) {
    showError("No travel plan available to download.");
    return;
  }
  if (typeof html2pdf === "undefined") {
    showError("PDF library failed to load.");
    return;
  }

  renderReport();

  const button = document.querySelector(".download-btn");
  const oldText = button ? button.textContent : "";
  if (button) {
    button.textContent = "Preparing PDF…";
    button.disabled = true;
  }

  const slug = tripRouteLabel(trip, tripNumber(trip.thread_id))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "travel-plan";

  const options = {
    margin: [0.5, 0.5, 0.6, 0.5],
    filename: `safrmrtah-${slug}.pdf`,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
    jsPDF: { unit: "in", format: "a4", orientation: "portrait" },
    pagebreak: { mode: ["css", "legacy"], avoid: ["tr", "h2", "h3", "li"] }
  };

  html2pdf()
    .set(options)
    .from(pdfContent)
    .save()
    .catch(() => showError("Could not download PDF."))
    .finally(() => {
      if (button) {
        button.textContent = oldText;
        button.disabled = false;
      }
    });
}


/* =========================================================================
   26. INITIALIZATION
   ========================================================================= */

function initializeApp() {
  loadSessions();

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      if (document.activeElement === $("userInput")) {
        event.preventDefault();
        sendMessage();
      } else if (document.activeElement === $("approvalFeedback") && appState.waitingForApproval) {
        event.preventDefault();
        submitApproval(false);
      }
    }
    if (event.key === "Escape") closeSidebar();
  });

  renderAll();
  checkHealth();
  syncSessionsFromBackend();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeApp);
  } else {
    initializeApp();
  }
}

/* Node test hook (ignored in the browser). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeTravelResponse, parseMoney, formatMoney, parseMarkdownTables, findSection,
    parseRouteFromText, parseDuration, extractFlightData, extractBudgetData, deriveStatus
  };
}
