import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import crypto from "crypto";
import webpush from "web-push";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load & parse example WhatsApp chat transcripts ──────────────────────────
// Format per line: [DD/MM/YY, HH:MM:SS AM/PM] Name: message
const CHATS_DIR = path.join(__dirname, "chats");
const KIDDOST_LABEL = "KidDost Tech Pvt Ltd";
const STOP_WORDS = new Set(["i","me","my","we","our","you","your","the","a","an","is","it","in","on","at","to","of","and","or","for","with","be","am","are","was","were","do","did","can","will","have","has","had","not","this","that","so","just","ok","okay","hi","hello","thank","thanks","please","sure","yes","no","get","let","us","know","if","would","could","also","he","she","they","them","what","when","how","why","who","its","any","all","now","up","more","but","by","as","from","been","then","than","there","about","after","before","may","might","use"]);

function parseChatFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const msgs = [];
  const lineRe = /^\[[\d\/]+,\s[\d:]+(?:\s[AP]M)?\]\s([^:]+):\s([\s\S]*)/;
  let cur = null;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (m) {
      if (cur) msgs.push(cur);
      const speaker = m[1].trim();
      const text = m[2].trim();
      // Skip system messages and media/call placeholders
      if (/end-to-end encrypted|omitted|Missed|This message was deleted|edited/i.test(text)) { cur = null; continue; }
      cur = { role: speaker === KIDDOST_LABEL ? "kiddost" : "customer", text };
    } else if (cur && line.trim()) {
      cur.text += " " + line.trim();
    }
  }
  if (cur) msgs.push(cur);
  return msgs;
}

function scoreKeywords(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// Load all chats at startup
const EXAMPLE_CHATS = [];
try {
  const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith(".txt"));
  for (const file of files) {
    const msgs = parseChatFile(path.join(CHATS_DIR, file));
    if (msgs.length > 2) {
      const fullText = msgs.map(m => m.text).join(" ");
      EXAMPLE_CHATS.push({ file, msgs, keywords: scoreKeywords(fullText) });
    }
  }
  console.log(`[chat-examples] Loaded ${EXAMPLE_CHATS.length} example conversations`);
} catch (e) {
  console.error("[chat-examples] Failed to load chats:", e.message);
}

// Fetch KidDost website content at startup for AI knowledge base
let KIDDOST_WEBSITE_CONTENT = "";
(async () => {
  try {
    const { data } = await axios.get("https://www.kiddost.com", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KidDostBot/1.0)" },
      timeout: 15000
    });
    let text = data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<[^>]+>/g, " ");
    text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    text = text.replace(/\s+/g, " ").trim();
    // Keep first 4000 chars of meaningful content (skip leading CSS junk)
    const idx = text.indexOf("KidDost");
    KIDDOST_WEBSITE_CONTENT = text.substring(idx >= 0 ? idx : 0, (idx >= 0 ? idx : 0) + 4000);
    console.log("[website] Loaded KidDost website content:", KIDDOST_WEBSITE_CONTENT.length, "chars");
  } catch (e) {
    console.error("[website] Failed to fetch website content:", e.message);
  }
})();

// Find the most relevant example conversation for a given customer message
function findBestExampleChat(customerMessage) {
  if (!EXAMPLE_CHATS.length) return null;
  const queryWords = new Set(scoreKeywords(customerMessage));
  if (!queryWords.size) return null;
  let best = null, bestScore = 0;
  for (const chat of EXAMPLE_CHATS) {
    const overlap = chat.keywords.filter(w => queryWords.has(w)).length;
    const score = overlap / Math.sqrt(chat.keywords.length || 1);
    if (score > bestScore) { bestScore = score; best = chat; }
  }
  return bestScore > 0 ? best : EXAMPLE_CHATS[0];
}

// Format an example chat into a readable block for the AI prompt
function sanitizeExampleText(text) {
  return text
    // Remove URLs
    .replace(/https?:\/\/\S+/g, "[link]")
    // Remove Indian rupee prices e.g. Rs 500, Rs. 1000, ₹500
    .replace(/(?:Rs\.?\s*|₹\s*)\d[\d,]*/gi, "[price]")
    // Remove time ranges e.g. 9:30 AM, 5:45-7:45 PM, 6-8pm
    .replace(/\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)/g, "[time]")
    .replace(/\d{1,2}(?::\d{2})?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)?/g, "[time range]")
    // Remove session/number counts e.g. "11 sessions", "3 hours"
    .replace(/\b\d+\s+(?:session|hour|hr)s?\b/gi, "[X sessions]")
    // Remove specific days/dates e.g. "coming Monday", "24/06/25"
    .replace(/\b(?:coming\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi, "[day]")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[date]")
    // Remove image omitted artifacts
    .replace(/\u200e\[.*?\]\s*KidDost Tech Pvt Ltd:.*?omitted/g, "")
    .replace(/image omitted/gi, "")
    // Remove timestamps inside text e.g. [24/06/25, 1:24:52 PM]
    .replace(/\[[\d\/]+,\s[\d:]+\s(?:AM|PM)\]/g, "")
    // Remove proper names (simple heuristic: standalone capitalized word not at start of line)
    .replace(/(?<=[A-Za-z,] )([A-Z][a-z]+)(?= ,|\?|!|\.|$)/g, "[name]")
    .trim();
}

function formatExampleChat(chat) {
  return chat.msgs.slice(0, 40).map(m =>
    `${m.role === "kiddost" ? "KidDost" : "Customer"}: ${sanitizeExampleText(m.text)}`
  ).join("\n");
}

// Extract the "we engage the child with..." program description line from an example chat.
// Strips the age prefix so the AI uses the age from the conversation, not the example.
function extractProgramDescription(chat) {
  const line = chat.msgs.find(m =>
    m.role === "kiddost" && /we engage the child with/i.test(m.text)
  );
  if (!line) return null;
  const text = sanitizeExampleText(line.text);
  return text.replace(/^(?:[\w]+,\s*)?[Ff]or\s+[\d.]+(?:\.5)?\s*(?:year|month)?(?:\s*(?:year|month))?\s*old\s+(?:age\s+category\s+)?/i, "").trim();
}

// Scan ALL example chats and return the program description whose stated age is
// closest to childAge. Falls back to any chat with an "engage" line if none match.
function findProgramDescriptionForAge(childAge) {
  let best = null;
  let bestDiff = Infinity;

  for (const chat of EXAMPLE_CHATS) {
    const line = chat.msgs.find(m =>
      m.role === "kiddost" && /we engage the child with/i.test(m.text)
    );
    if (!line) continue;

    // Try to extract the age from the line e.g. "For 4 year old..." → 4
    const ageMatch = line.text.match(/[Ff]or\s+([\d.]+)(?:\.5)?\s*(?:year|month)?(?:\s*(?:year|month))?\s*old/i);
    if (ageMatch) {
      const lineAge = parseFloat(ageMatch[1]);
      const diff = Math.abs(lineAge - childAge);
      if (diff < bestDiff) {
        bestDiff = diff;
        const text = sanitizeExampleText(line.text);
        best = text.replace(/^(?:[\w]+,\s*)?[Ff]or\s+[\d.]+(?:\.5)?\s*(?:year|month)?(?:\s*(?:year|month))?\s*old\s+(?:age\s+category\s+)?/i, "").trim();
      }
    }
  }

  // Fallback: use any chat with an engage line
  if (!best) {
    for (const chat of EXAMPLE_CHATS) {
      const desc = extractProgramDescription(chat);
      if (desc) { best = desc; break; }
    }
  }

  return best;
}
// ────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '95mb' }));
// Restrict CORS to the Vercel frontend origin
app.use(cors({
  origin: "https://kiddost-ai.vercel.app",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type"]
}));
const PORT = process.env.PORT || 10000;

// Keys
const BOTSPACE_API_KEY = process.env.BOTSPACE_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ── Location serviceability (Haversine + Google Geocoding) ──────────────
const SERVICE_HUBS = [
  { name: 'Marathahalli (East Bangalore)', lat: 12.95594, lng: 77.72582, radiusKm: 6 },
  { name: 'Jayanagar (Central/South Bangalore)', lat: 12.93257, lng: 77.58352, radiusKm: 10 },
  { name: 'Electronic City', lat: 12.84977, lng: 77.66629, radiusKm: 3 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Resolve Google Maps short-URLs (maps.app.goo.gl, goo.gl/maps) → lat,lng
async function resolveGoogleMapsUrl(shortUrl) {
  try {
    // Follow redirects to get the expanded URL
    const resp = await axios.get(shortUrl, { maxRedirects: 5, timeout: 8000 });
    const finalUrl = resp.request?.res?.responseUrl || resp.request?._redirectable?._currentUrl || shortUrl;
    console.log('[Maps URL] expanded:', finalUrl);
    // Try to extract @lat,lng from the expanded URL
    const atMatch = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) return { lat: parseFloat(atMatch[1]), lng: parseFloat(atMatch[2]) };
    // Try !3d...!4d... format
    const dMatch = finalUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (dMatch) return { lat: parseFloat(dMatch[1]), lng: parseFloat(dMatch[2]) };
    // Try query param q=lat,lng
    const qMatch = finalUrl.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (qMatch) return { lat: parseFloat(qMatch[1]), lng: parseFloat(qMatch[2]) };
    // Try place/ path
    const placeMatch = finalUrl.match(/\/place\/([^/@]+)/);
    if (placeMatch) return { placeName: decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ') };
    return null;
  } catch (e) {
    console.error('[Maps URL] resolve error:', e.message);
    return null;
  }
}

async function checkLocationServiceability(locationText) {
  if (!GOOGLE_MAPS_API_KEY) return null; // no API key, skip
  try {
    let lat, lng, formattedAddress;

    // Check if locationText is a Google Maps URL
    const mapsUrlMatch = locationText.match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps)\S+/i);
    if (mapsUrlMatch) {
      const resolved = await resolveGoogleMapsUrl(mapsUrlMatch[0]);
      if (resolved?.lat && resolved?.lng) {
        lat = resolved.lat;
        lng = resolved.lng;
        // Reverse-geocode to get a readable address
        const revUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`;
        const revRes = await axios.get(revUrl);
        formattedAddress = revRes.data.results?.[0]?.formatted_address || `${lat}, ${lng}`;
        console.log(`[Location Check] Maps URL resolved → ${lat},${lng} (${formattedAddress})`);
      } else if (resolved?.placeName) {
        // Fell back to place name extraction — forward-geocode it
        const query = encodeURIComponent(resolved.placeName + ', Bangalore, India');
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${GOOGLE_MAPS_API_KEY}`;
        const res = await axios.get(url);
        if (!res.data.results?.length) return null;
        lat = res.data.results[0].geometry.location.lat;
        lng = res.data.results[0].geometry.location.lng;
        formattedAddress = res.data.results[0].formatted_address;
      } else {
        console.log('[Location Check] Could not resolve Google Maps URL');
        return null;
      }
    } else {
      // Standard text-based geocoding
      const query = encodeURIComponent(locationText + ', Bangalore, India');
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${GOOGLE_MAPS_API_KEY}`;
      const res = await axios.get(url);
      if (!res.data.results || res.data.results.length === 0) return null;
      lat = res.data.results[0].geometry.location.lat;
      lng = res.data.results[0].geometry.location.lng;
      formattedAddress = res.data.results[0].formatted_address;
    }

    // Check against each hub
    let nearest = null;
    let nearestDist = Infinity;
    for (const hub of SERVICE_HUBS) {
      const dist = haversineKm(lat, lng, hub.lat, hub.lng);
      if (dist < nearestDist) { nearestDist = dist; nearest = hub; }
      if (dist <= hub.radiusKm) {
        return { serviceable: true, hub: hub.name, distance: Math.round(dist * 10) / 10, address: formattedAddress, lat, lng };
      }
    }
    return { serviceable: false, nearestHub: nearest?.name, distance: Math.round(nearestDist * 10) / 10, address: formattedAddress, lat, lng };
  } catch (e) {
    console.error('Geocoding error:', e.message);
    return null;
  }
}

// VAPID setup for Web Push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:support@kiddost.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// In-memory push subscription store { endpoint -> subscriptionObject }
const pushSubscriptions = new Map();

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function loadPushSubscriptionsFromDb() {
  try {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('endpoint, subscription, agent');
    if (error) {
      console.error('[push] failed loading subscriptions from DB:', error.message);
      return;
    }
    for (const row of (data || [])) {
      if (row?.endpoint && row?.subscription) {
        pushSubscriptions.set(row.endpoint, {
          subscription: row.subscription,
          agent: row.agent || null,
        });
      }
    }
    console.log(`[push] loaded ${pushSubscriptions.size} subscriptions from DB`);
  } catch (e) {
    console.error('[push] DB load error:', e.message);
  }
}

async function upsertPushSubscription(subscription, agent) {
  try {
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          endpoint: subscription.endpoint,
          subscription,
          agent: agent || null,
        },
        { onConflict: 'endpoint' }
      );
    if (error) console.error('[push] failed to persist subscription:', error.message);
  } catch (e) {
    console.error('[push] DB upsert error:', e.message);
  }
}

async function deletePushSubscription(endpoint) {
  try {
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint);
    if (error) console.error('[push] failed to delete subscription:', error.message);
  } catch (e) {
    console.error('[push] DB delete error:', e.message);
  }
}

// Service-role client for server-side uploads (requires SUPABASE_SERVICE_ROLE_KEY env)
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseService = null;
if (SUPABASE_SERVICE_ROLE_KEY) {
  supabaseService = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// In-memory buffering to combine fragmented user messages per phone
const MESSAGE_BUFFER_DELAY_MS = 100; // ← change this to adjust how long to wait before sending to AI (in milliseconds)
const messageBuffers = {};
const messageTimers = {};
const welcomeBackFlags = {};

// In-memory OTP store for agent creation: { token -> { otp, expiresAt } }
const otpStore = {};

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// Helper: generate AI response for a combined user message
async function handleAIResponse(fullPhone, combinedMessage, options = {}) {
  try {
    const { prependWelcomeBack = false, contactName = '' } = options;
    const displayContact = String(contactName || '').trim() || fullPhone;
    // Fetch last 10 messages for conversation memory
    const { data, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("phone", fullPhone)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      console.log("Supabase fetch error:", error);
    }

    const history = Array.isArray(data) ? data.reverse() : [];

    // Load conversation variables (child names/ages stored across messages)
    let convVars = {};
    try {
      const { data: convData } = await supabase
        .from('conversations')
        .select('vars')
        .eq('phone', fullPhone)
        .maybeSingle();
      convVars = convData?.vars || {};
    } catch (e) {
      console.log('[vars] failed to load:', e.message);
    }

    // Before generating AI response, check most recent message's ai_enabled flag
    const { data: last, error: lastErr } = await supabase
      .from("messages")
      .select("*")
      .eq("phone", fullPhone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastErr) console.log("Supabase fetch error:", lastErr);

    if (last && last.ai_enabled === false) {
      console.log("AI disabled for this conversation (buffered)");
      return;
    }

    // ── STEP 1: Intent extraction ────────────────────────────────────────────
    // A small, cheap AI call that reads the full conversation context and decides:
    // - what the user is actually asking about (handles follow-ups like "For 4?")
    // - whether they're asking about activities/programs
    // - a good search query to find the right example chat
    let intent = { isAskingAboutActivities: false, searchQuery: combinedMessage, children: [], notes: {} };
    try {
      const intentRes = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a query classifier for a childcare service chatbot. Given a conversation, extract what the user is currently asking.
Return ONLY valid JSON with these fields:
- "isAskingAboutActivities": true if the user is asking what programs or activities are offered (including follow-up questions like "For 4?" after a prior activities question)
- "children": array of children mentioned ANYWHERE in the FULL conversation. Each entry: { "name": string or null, "age": number or null }. If the same child is mentioned with both name and age, combine them into one entry. If a new age is mentioned for a different (second) child, add a separate entry. Example: [{"name":"Ram","age":4},{"name":null,"age":2}]
- "notes": an object of important facts/details about the customer mentioned ANYWHERE in the conversation. Extract things like:
  • "parentName": mother's/father's name if mentioned
  • "spouseName": husband/wife name if mentioned
  • "location": area, locality, address if mentioned (extract the PLACE NAME, not a URL — if user only shares a link, skip this field)
  • "school": child's school if mentioned
  • "preferences": any specific preferences for sessions (e.g. "only weekends", "no art")
  • "allergies": any allergies or health concerns
  • "referral": how they heard about us
  • Any other notable facts — use descriptive keys in camelCase
  Only include fields that are actually mentioned. Do NOT guess or infer.
- "searchQuery": a short keyword phrase (3-6 words) to search for relevant past conversations. If asking about activities, include the child's age.
Consider the FULL conversation history carefully — do not confuse one child's age with another's.`
            },
            ...history,
            { role: "user", content: combinedMessage }
          ],
          temperature: 0,
          response_format: { type: "json_object" }
        },
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" } }
      );
      intent = JSON.parse(intentRes.data.choices[0].message.content);
      if (!Array.isArray(intent.children)) intent.children = [];
      if (!intent.notes || typeof intent.notes !== 'object') intent.notes = {};
      console.log("[Intent]", intent);
    } catch (e) {
      console.log("[Intent] extraction failed, falling back:", e.message);
    }

    // ── Update conversation vars with any new child discoveries ─────────────
    // convVars.children = [{name, age}, ...] — merge by name or by position
    let varsUpdated = false;
    const storedChildren = Array.isArray(convVars.children) ? convVars.children : [];
    for (const ic of intent.children) {
      if (ic.name == null && ic.age == null) continue;
      // Try to find existing match: same name (if named), or a nameless child slot
      let matched = null;
      if (ic.name) {
        matched = storedChildren.find(c => c.name && c.name.toLowerCase() === ic.name.toLowerCase());
      }
      if (!matched) {
        // For unnamed children, see if there's an existing unnamed slot with same age or no age yet
        matched = storedChildren.find(c => !c.name && (c.age == null || c.age === ic.age));
      }
      if (matched) {
        if (ic.name && matched.name !== ic.name) { matched.name = ic.name; varsUpdated = true; }
        if (ic.age != null && matched.age !== ic.age) { matched.age = ic.age; varsUpdated = true; }
      } else {
        storedChildren.push({ name: ic.name || null, age: ic.age != null ? ic.age : null });
        varsUpdated = true;
      }
    }
    if (varsUpdated) {
      convVars.children = storedChildren;
      supabase.from('conversations').update({ vars: convVars }).eq('phone', fullPhone)
        .then(() => console.log('[vars] saved:', JSON.stringify(convVars)))
        .catch(e => console.log('[vars] save failed:', e.message));
    }

    // Merge extracted notes into convVars.notes 
    if (intent.notes && typeof intent.notes === 'object' && Object.keys(intent.notes).length > 0) {
      const storedNotes = (convVars.notes && typeof convVars.notes === 'object') ? convVars.notes : {};
      let notesUpdated = false;
      for (const [key, val] of Object.entries(intent.notes)) {
        if (val != null && val !== '' && storedNotes[key] !== val) {
          storedNotes[key] = val;
          notesUpdated = true;
        }
      }
      if (notesUpdated) {
        convVars.notes = storedNotes;
        supabase.from('conversations').update({ vars: convVars }).eq('phone', fullPhone)
          .then(() => console.log('[vars/notes] saved:', JSON.stringify(convVars.notes)))
          .catch(e => console.log('[vars/notes] save failed:', e.message));
      }
    }

    // ── STEP 2: Retrieve relevant example using the extracted search query ───
    const exampleChat = findBestExampleChat(intent.searchQuery || combinedMessage);
    // For activities, find the best age-matched description.
    // Use the age of the child being discussed — prefer named child if name appears in message.
    const allChildren = storedChildren.length > 0 ? storedChildren : intent.children;
    let activeChildAge = null;
    let activeChildName = null;
    if (allChildren.length === 1) {
      activeChildAge = allChildren[0].age;
      activeChildName = allChildren[0].name;
    } else if (allChildren.length > 1) {
      // Try to detect which child the current message is about
      const mentionedChild = allChildren.find(c => c.name && new RegExp(c.name, 'i').test(combinedMessage));
      const active = mentionedChild || allChildren[allChildren.length - 1];
      activeChildAge = active.age;
      activeChildName = active.name;
    }
    const programDescription = intent.isAskingAboutActivities && activeChildAge != null
      ? findProgramDescriptionForAge(activeChildAge)
      : null;
    const exampleBlock = exampleChat
      ? `\n\n---\nExample conversation (use for tone and style only):\n\`\`\`\n${formatExampleChat(exampleChat)}\n\`\`\`\n---`
      : "";

    // Build a known-facts block from conversation vars
    const childFacts = allChildren
      .filter(c => c.name || c.age != null)
      .map(c => {
        if (c.name && c.age != null) return `- ${c.name}: ${c.age} years old`;
        if (c.name) return `- Child named ${c.name} (age unknown)`;
        return `- Unnamed child: ${c.age} years old`;
      });
    const varsBlock = childFacts.length > 0 || (convVars.notes && Object.keys(convVars.notes).length > 0)
      ? `\n\nKNOWN FACTS about this family (do NOT ask for this again, use it naturally — do NOT mix up different children's ages):\n${childFacts.join('\n')}${
        convVars.notes && Object.keys(convVars.notes).length > 0
          ? '\n' + Object.entries(convVars.notes).map(([k, v]) => `- ${k}: ${v}`).join('\n')
          : ''
      }`
      : '';

    // ── Check if this customer has had any previous sessions ─────────────
    let sessionStatusBlock = '';
    try {
      const { data: pastEvents, error: evErr } = await supabase
        .from('calendar_events')
        .select('id, title, date, is_trial')
        .eq('phone', fullPhone)
        .order('date', { ascending: true });
      if (!evErr && pastEvents && pastEvents.length > 0) {
        const totalSessions = pastEvents.length;
        const trialDone = pastEvents.some(e => e.is_trial);
        sessionStatusBlock = `\n\nSESSION HISTORY for this customer:\n- Total sessions booked: ${totalSessions}\n- Introductory session completed: ${trialDone ? 'Yes' : 'No'}\nThis is a RETURNING customer — do NOT offer an introductory session again. Focus on scheduling regular sessions.`;
      } else {
        sessionStatusBlock = `\n\nSESSION HISTORY for this customer:\n- No previous sessions found.\n- This is a FIRST-TIME customer. Their first session will be an introductory session. When mentioning the first session price, use this exact line: "We suggest scheduling a one-hour introductory session at your convenience. For the first experience of our service, we are happy to offer it at a discounted price of ₹500 per hour." Treat the booking flow the same as a regular session after that.`;
      }
    } catch (e) {
      console.log('[session-check] failed:', e.message);
    }

    // The system prompt now has all exact age-based activity scripts.
    // Do NOT inject example activities — they conflict with the system prompt scripts.
    const userMessageForAI = combinedMessage;

    const messagesForAI = [
      {
        role: "system",
        content:
          `You are a WhatsApp assistant for KidDost, a child engagement and tutoring service in Bangalore for children aged 1 to 8 years (we also make exceptions for infants from 4 months).

Your tone:
- Friendly, warm, and human-like (like a real WhatsApp agent)
- Slightly sales-oriented but never pushy
- Clear and concise (2–5 short lines max)
- Never robotic or overly formal
- NO emojis — ever

CURRENT TIME: ${new Date(Date.now() + 5.5 * 60 * 60 * 1000).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} IST (24-hour format)

CRITICAL RULES:
- Always base your answer on the CURRENT conversation context
- Use ONLY the activities mentioned in the example conversation below — NEVER invent activities not found there
- DO NOT copy specific names, dates, prices, or availability from the example conversation
- If the user asks about availability (dates/tomorrow/etc), respond generally or ask for confirmation instead of assuming
- DO NOT use emojis in any response
- NEVER ask for the child's age if it was ALREADY mentioned earlier in the conversation or in KNOWN FACTS. Read the full history before responding.
- NEVER repeat information you have already given. If you already shared activities, pricing, or introductory session details earlier in the conversation, do NOT repeat them. Just answer the new question directly.
- If the child's name is shared voluntarily, remember it and use it naturally later.
- Only include "Feel free to let us know if you have any questions." when you are finishing a substantial info block (pricing/activities). Do NOT add it to every single message.
- ONLY answer questions that are explicitly covered in the RESPONSE PLAYBOOK below. If a question is not covered, reply UNSURE.
- Do NOT improvise, fabricate, assume, or fill gaps with your own knowledge. You only know what is written in this prompt and the conversation history.
- When in doubt, ALWAYS err on the side of saying UNSURE. A wrong answer is far worse than deferring to a human agent.

IMPORTANT — UNSURE threshold:
- If you are not 100% certain your answer is correct based on THIS prompt, reply with ONLY the single word: UNSURE
- Do NOT guess, speculate, or give a "probably" answer — just say UNSURE
- Do not add any other text when you reply UNSURE
- It is ALWAYS better to say UNSURE than to give an incorrect or made-up answer

---
RESPONSE PLAYBOOK — stick closely to these scripts. You may adjust phrasing slightly for natural conversation, but do NOT add information that isn't explicitly stated here. If the user asks something not covered below, reply UNSURE.

PRICING / SERVICES / QUOTATION:
- Check the conversation history first. If the child's age was already mentioned, use it — do NOT ask again.
- If age is not known yet, naturally ask for the child's age — phrase it conversationally, e.g. "Could you share your child's age?" or "May I know how old your child is?" — do NOT start with "Sure,"
- Once age is known, give the appropriate activities response (paraphrasing is fine, keep the core activities accurate):
  • Under 4 months: Explain this is too young and you might not be the right fit.
  • 4m–under 1 year: Explain the age category starts from 1 year, but on request of parents you have provided service for infants as young as 4 months. The team engages through verbal interaction, rhymes, flashcards etc. The aim is to give parents some free time. Clarify no massage/bathing. All members are female graduates, English interaction.
  • Age 1 to under 2 (including 1.5 years, 18 months): Verbal interaction, age-appropriate puzzles, flashcards, rhymes, storybook reading, park outings.
  • Age 2: Verbal interaction, puzzles, rhymes, simple art & craft, storybook reading, shapes/colours/numbers, park outings.
  • Age 3: Puzzles, memory games, art & craft, brain-boosting activities, storybook reading, phonics, writing practice, park outings.
  • Age 4 to 8: Puzzles, memory games, art & craft, brain-boosting activities, storybook reading, worksheets, study help if needed, park outings.
  • Age above 8: Apologise — services are for children aged 1 to 8 years, you are not the right fit.
- After the activities (for ages 8 and below), write [PRICING_IMAGE] on its own line so the pricing image is sent.
- After the image, include the pricing context — use judgment on how much to say based on what they asked:
  • If they asked about full pricing/services: use this exact line — "We suggest scheduling a one-hour introductory session at your convenience. For the first experience of our service, we are happy to offer it at a discounted price of ₹500 per hour."
  • If they just asked about pricing as a follow-up and age is already known: write [PRICING_IMAGE] then briefly say "Please refer to the pricing details above."
- IMPORTANT: ALWAYS send [PRICING_IMAGE] before referencing pricing. Never say "refer to the pricing above" without first writing [PRICING_IMAGE] on its own line.
- End with "Feel free to let us know if you have any questions." as a separate line.
- Do NOT add nanny disclaimer unless the user specifically asked about nanny services.
- Do NOT send [PRICING_IMAGE] unless the conversation is specifically about pricing, services, or packages.

NANNY SERVICES (only when user asks about nanny/caretaker/babysitter):
- Step 1: If child's age is not already known, send ONLY "May I know the age of the child?" and nothing else in that message. Stop there.
- Step 2: Once age is known, give the appropriate activities response (follow the age-based scripts above), then write [PRICING_IMAGE].
- Step 3: After the activities and pricing image, add on a new line: "Would like to clarify — we don't provide nanny services. Our team members are female graduates or students pursuing graduation, and our primary mode of interaction is in English."
- If age is already known, skip Step 1 and go straight to Step 2.

VALUE PACKAGES (only when user asks about packages/plans/bundles):
- IMPORTANT: We call them "value packages", NOT "monthly packages".
- Write [MONTH_IMAGE] on its own line, then explain the package flexibility (bundle of sessions, discounted rate, can be used over 1–3 months).
- If the user asks something like "I have twins, what will be the monthly package?" do NOT ask for children's names. First share the value package details, then tell them that we can customize a package for two kids once we have done the introductory session and confirmed that we are a good fit for your requirements.
- End with "Feel free to let us know if you have any questions."

SESSION LENGTH / DURATION:
- If the user asks "how long are the sessions" or similar, answer: "You can book as per your requirement."

MEMBER QUALIFICATIONS:
- Motivated, compassionate female graduates/students passionate about teaching. Comprehensive in-house training.

SAME MEMBER EVERY TIME:
- We keep 2–3 members per account for continuity, accounting for short and long leaves.

SAFETY / BACKGROUND CHECKS:
- All our members are on our salary roll and we do our internal background verification before taking them onboard.
- Parents do not need to be present during the session — our members are trained professionals and the child can be left with them comfortably.

OTHER BABY WORK (feeding, cleaning, bathing, diaper change, etc.):
- This is NOT about activities or pricing. Do NOT re-share activities or ask for age.
- Simply explain: our scope is limited to engaging children through fun and learning activities. We do not handle feeding, bathing, diaper changes, or other caretaking tasks. However, we can encourage light snacks if the child is not a fussy eater.

TOO EXPENSIVE / OUT OF BUDGET:
- If the user says something like "Ok. Prices are quite high", reply with EXACTLY:
"Hi, regarding discounts, we've already offered our most competitive pricing. Our pricing structure remains consistent for all clients, including long-term renewals. We are doing our annual adjustments in near future and the current pricing is available for limited time period. We appreciate your understanding."
- If after that it's still too expensive for them, thank them for considering and invite them to reach out for ad-hoc support.

BUSINESS HOURS:
- We are operational from 9:00 AM to 7:45 PM IST.
- If the CURRENT TIME is before 9:00 AM or after 7:45 PM, and the user asks for something that requires human help (booking, cancellation, rescheduling, availability check, location check, or anything you would normally reply UNSURE to), politely let them know: "Our team is available between 9:00 AM and 7:45 PM. We will get back to you first thing in the morning!" (or "shortly" if it's close to 9:00 AM). Do NOT reply UNSURE in this case — send the business hours message instead.
- If the CURRENT TIME is within business hours, follow the normal flow below.
- IMPORTANT: Only use the out-of-hours message when the requested time is unambiguously outside 9:00 AM-7:45 PM (examples: 7 AM, 8 PM, 9 PM, 6 AM). Treat 5 PM-6 PM as VALID and within operational hours. If the time is ambiguous or plausibly within the window, do NOT reject it; proceed normally and let the human agent confirm availability.
- If someone asks for a session on Sunday, say that we are operational Monday to Saturday currently.

BEFORE BOOKING:
- Before proceeding with booking or slot availability, the child's age MUST already be known.
- If the child's age is not known yet, ask for the child's age first before collecting booking details.

- NEVER ask for information that the user has already provided earlier in the conversation.
- Before asking booking questions, carefully check the full conversation history for:
  - Child's age
  - Parent/customer name
  - Preferred date/time
  - Area/locality
- Only ask for the missing information.

- If the user requests booking for Sunday or says "tomorrow" when tomorrow is Sunday, reply that we are currently operational Monday to Saturday only, and ask if they would like to schedule for another day instead.
- Do NOT proceed to slot-availability flow for Sunday requests.

- Before proceeding to check slot availability, you MUST gather ALL of the following:
  1. Parent's/customer's name — if not known, ask: "And may I know your name as well?"
  2. Preferred date and time — ask: "What date and time would work best for you?"
  3. Area/locality — if not already known, ask: "Could you also share your area or locality so I can confirm we service your location?"
- You can combine multiple missing questions into one message.
- Only proceed to check availability once all required details are already available.
- IMPORTANT: While gathering details/date/time, you are still in normal conversation mode. Reply normally to their answers. Do NOT reply UNSURE during this phase.

GROUP / SIBLING SESSIONS:
- Do NOT ask about same-or-separate sessions the moment the customer mentions multiple children. Continue the normal conversation (ages, interests, activities, pricing, etc.) first.
- Only ask the same-or-separate question when the customer is READY TO BOOK (i.e. they express booking intent like "I want to book", "let's schedule", "book sessions", etc.) AND you already know they have multiple children.
- At that point, as part of the BEFORE BOOKING flow, include the question: "Would you like both children in the same session, or would you prefer separate sessions for each child?"
- You can combine this with other BEFORE BOOKING questions (parent name, date/time) in one message.
- Once you have the same-or-separate answer AND all the standard booking info (parent name, date/time), say EXACTLY: "Great, allow me to check the slot availability and the best options for your children and come back to you."
- After saying this, you must STOP. If the user replies with ANYTHING after that, respond with ONLY the word: UNSURE
- A human agent will follow up with group/sibling session details.

TIME SLOT REQUEST:
- Once you have the parent's name AND preferred date/time, say EXACTLY: "Sure, allow me to check the slot availability and come back to you."
- CRITICAL: The UNSURE rule ONLY activates after you have sent this EXACT check-availability message. NOT before.
- After you have said "allow me to check the slot availability and come back to you", you must STOP. If the user replies with ANYTHING after that (e.g. "Sure", "Ok", "Thanks", a name, a time), respond with ONLY the word: UNSURE
- Do NOT fabricate availability confirmations. You cannot actually check calendars. A human agent will respond once they have checked.
- If the conversation history shows you already said "allow me to check the slot availability" and no human agent has confirmed yet, reply UNSURE.

LOCATION / SERVICEABILITY:
We operate in Bangalore only with 3 service hubs (Marathahalli ~6km, Jayanagar ~10km, Electronic City ~3km).
The system automatically geocodes the user's location and injects a LOCATION VERIFIED message above. Follow it:
- If you see "LOCATION VERIFIED ✅" → confirm to the user: "Yes, we do service in [area]! 😊" and continue normally.
- If you see "LOCATION VERIFIED ❌" → say EXACTLY: "Let me check if we can service your area and get back to you." Then STOP. If the user replies anything after that, respond UNSURE.
- If NO location check was injected (user didn't mention a place) and they ask "do you service in X?", ask them to share their area name and you will check.
- If the user mentions ANY city/area other than Bangalore (e.g. Mysore, Chennai, Mumbai, Pune, Hyderabad, etc.) → NEVER say "yes we service there". Say EXACTLY: "Currently we operate only in Bangalore. We're expanding soon — would you like us to notify you when we're available in your area?" — this is NON-NEGOTIABLE.
- During the BEFORE BOOKING flow, after collecting parent name / preferred time, also ask for their area/locality if not already known: "Could you also share your area or locality so I can confirm we service your location?"
- Do NOT fabricate serviceability. Only confirm when you see a LOCATION VERIFIED ✅ system message.
---

Goal: Make the user feel like they are chatting with a real human agent and move them towards booking an introductory session.` +
          (KIDDOST_WEBSITE_CONTENT ? `\n\n---\nKidDost background info (philosophy, contact, general info — do NOT use for listing activities):\n${KIDDOST_WEBSITE_CONTENT}\n---` : "") +
          varsBlock +
          sessionStatusBlock +
          exampleBlock
      },
      ...history,
      { role: "user", content: userMessageForAI }
    ];

    // ── Location serviceability check (geocoding) ────────────────────────
    // Detect if user is asking about location/area and inject verified result
    // First check if the message contains a Google Maps URL
    const mapsUrlInMsg = combinedMessage.match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps)\S+/i);
    let locationCheckResult = null;
    if (mapsUrlInMsg) {
      locationCheckResult = await checkLocationServiceability(mapsUrlInMsg[0]);
      if (locationCheckResult) {
        console.log(`[Location Check] Maps URL → ${JSON.stringify(locationCheckResult)}`);
      }
    } else {
      const locationPatterns = [
        /(?:do you|can you|are you).*(?:service|serve|cover|come to|operate|available)\s+(?:in|at|near|around)\s+(.+)/i,
        /(?:service|serve|cover|available).*(?:in|at|near)\s+(.+)/i,
        /(?:we are|we're|i am|i'm|i live|we live|located|staying|stay)\s+(?:in|at|near|around)\s+(.+)/i,
        /(?:my (?:area|location|place|locality|address) is|i'm from|we're from)\s+(.+)/i,
        /(?:our (?:area|location|place|locality|address) is)\s+(.+)/i,
        /(?:what about|how about)\s+(.+?)(?:\s*\?|$)/i,
      ];
      for (const pat of locationPatterns) {
        const m = combinedMessage.match(pat);
        if (m && m[1]) {
          const locationText = m[1].replace(/[?.!]+$/, '').trim();
          if (locationText.length >= 3 && locationText.length <= 100) {
            locationCheckResult = await checkLocationServiceability(locationText);
            if (locationCheckResult) {
              console.log(`[Location Check] "${locationText}" → ${JSON.stringify(locationCheckResult)}`);
            }
            break;
          }
        }
      }
    }
    if (locationCheckResult) {
      const locMsg = locationCheckResult.serviceable
        ? `LOCATION VERIFIED ✅: "${locationCheckResult.address}" is SERVICEABLE — ${locationCheckResult.distance} km from ${locationCheckResult.hub} hub (within radius). You can confidently confirm this area.`
        : `LOCATION VERIFIED ❌: "${locationCheckResult.address}" is NOT SERVICEABLE — nearest hub is ${locationCheckResult.nearestHub} (${locationCheckResult.distance} km away, outside radius). Defer to human agent: "Let me check if we can service your area and get back to you."`;
      messagesForAI.splice(-1, 0, { role: "system", content: locMsg });
    }

    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: messagesForAI,
        temperature: 0
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    let aiReply = aiResponse.data.choices[0].message.content;

    // Safety net: patch known model misfires before sending to user.
    // 1) Prevent false out-of-hours replies during working hours.
    // 2) Enforce approved nanny-services wording.
    const nowIst = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date());
    const [hStr, mStr] = nowIst.split(':');
    const nowMins = (parseInt(hStr, 10) * 60) + parseInt(mStr, 10);
    const isWithinBusinessHours = nowMins >= (9 * 60 + 30) && nowMins <= (19 * 60 + 45);

    const OUT_OF_HOURS_REPLY_RE = /(our team is available between\s*9:?30\s*am\s*(?:and|-)\s*7:?45\s*pm|first thing in the morning|could we find a slot within that window)/i;
    const mentionsNanny = /\b(nanny|babysitter|caretaker|caregiver)\b/i.test(combinedMessage || '');

    const extractTimesToMinutes = (text) => {
      const times = [];
      const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
      let m;
      while ((m = re.exec(text || '')) !== null) {
        let hour = parseInt(m[1], 10);
        const minute = m[2] ? parseInt(m[2], 10) : 0;
        const mer = m[3].toLowerCase();
        if (hour === 12) hour = 0;
        if (mer === 'pm') hour += 12;
        times.push(hour * 60 + minute);
      }
      return times;
    };

    const timesInMessage = extractTimesToMinutes(combinedMessage);
    const hasTimes = timesInMessage.length > 0;
    const allTimesWithinHours = hasTimes && timesInMessage.every(t => t >= (9 * 60 + 30) && t <= (19 * 60 + 45));

    if (OUT_OF_HOURS_REPLY_RE.test(aiReply)) {
      // If current time is within business hours, this out-of-hours response is invalid.
      // Also block false rejects when all requested times are within hours (e.g. 5-6 PM).
      if (isWithinBusinessHours || allTimesWithinHours) {
        aiReply = 'Sure, allow me to check the slot availability and come back to you.';
      }
    }

    // Never move to slot-check unless key booking details are known.
    // If the model jumps early, force a details-collection question instead.
    const CHECK_SLOT_REPLY_RE = /allow me to check the slot availability/i;
    if (!mentionsNanny && CHECK_SLOT_REPLY_RE.test(aiReply)) {
      const notes = (convVars && convVars.notes && typeof convVars.notes === 'object') ? convVars.notes : {};
      const children = Array.isArray(allChildren) ? allChildren : [];

      const hasChildName = children.some(c => !!(c && c.name));
      const hasChildAge = children.some(c => c && c.age != null);
      const hasParentName = Boolean(notes.parentName || notes.parent || notes.customerName || notes.name);
      const hasLocation = Boolean(notes.location || notes.area || notes.locality || notes.address);

      const missing = [];
      if (!hasChildName) missing.push("child's name");
      if (!hasChildAge) missing.push("child's age");
      if (!hasParentName) missing.push('your name');
      if (!hasLocation) missing.push('your area/locality');

      if (missing.length > 0) {
        const missingText =
          missing.length === 1
            ? missing[0]
            : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
        aiReply = `Sure, before I check slot availability, could you share ${missingText}?`;
      }
    }

    // Nanny: handled by AI prompt (ask age first, then clarify) — no override needed

    console.log("AI Reply (buffered):", aiReply);

    // If AI is unsure, notify agents instead of replying to user
    if (aiReply.trim().toUpperCase() === "UNSURE") {
      console.log("[AI] UNSURE — sending agent notification, not replying to user");
      // Flag conversation as needing human attention
      await supabase.from('conversations').update({ needs_human: true }).eq('phone', fullPhone);
      await sendPushToAll({
        title: `${displayContact}`,
        body: `AI couldn't respond to a message from ${displayContact} (${fullPhone}) — "${combinedMessage.slice(0, 80)}"`,
        phone: fullPhone,
        icon: "/icon-192.png"
      });
      return;
    }

    // Helper: send a text message via BotSpace and save to DB
    const SERVER_URL = process.env.SERVER_URL || 'https://kiddost-ai.onrender.com';
    const sendAIText = async (text) => {
      await supabase.from("messages").insert({
        phone: fullPhone, role: "assistant", content: text, sender: "ai", agent: null, ai_enabled: true
      });
      await axios.post(
        `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message`,
        { name: "User", phone: fullPhone, text },
        { params: { apiKey: BOTSPACE_API_KEY }, headers: { "Content-Type": "application/json" } }
      );
    };
    const sendAIImage = async (filename) => {
      const mediaUrl = `${SERVER_URL}/static/${filename}`;
      await axios.post(
        `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-media-message?apiKey=${BOTSPACE_API_KEY}`,
        { name: 'KidDost', phone: fullPhone, mediaUrl, mediaType: 'image', label: '' },
        { headers: { 'Content-Type': 'application/json' } }
      );
    };

    if (prependWelcomeBack) {
      await sendAIText('Welcome back! Great to hear from you again.');
      await new Promise(r => setTimeout(r, 400));
    }

    // Split reply on image markers and send segments in order
    const IMAGE_MARKERS = { '[PRICING_IMAGE]': 'pricing.jpeg', '[MONTH_IMAGE]': 'month.jpeg' };
    const MARKER_PATTERN = /\[(PRICING_IMAGE|MONTH_IMAGE)\]/g;
    const FEEL_FREE_PATTERN = /feel free to let us know if you have any questions\.?/i;
    const FEEL_FREE_TEXT = 'Feel free to let us know if you have any questions.';
    const parts = aiReply.split(MARKER_PATTERN);
    // parts alternates: text, markerName, text, markerName, text ...
    let pricingImageSent = false;
    let shouldSendFeelFree = false;
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i].trim();
      if (!part) continue;
      const filename = IMAGE_MARKERS[`[${part}]`];
      if (filename) {
        if (filename === 'pricing.jpeg') pricingImageSent = true;
        await sendAIImage(filename);
        await new Promise(r => setTimeout(r, 600));
      } else {
        // Extract "Feel free" sentence to always send as its own final message
        if (FEEL_FREE_PATTERN.test(part)) {
          shouldSendFeelFree = true;
          part = part.replace(FEEL_FREE_PATTERN, '').trim();
        }
        // If the AI mentions pricing details but forgot the image marker, send image first
        if (/please refer to.*pricing/i.test(part) && !pricingImageSent) {
          pricingImageSent = true;
          await sendAIImage('pricing.jpeg');
          await new Promise(r => setTimeout(r, 600));
        }
        if (part) {
          await sendAIText(part);
          await new Promise(r => setTimeout(r, 400));
        }
      }
    }
    // Send "Feel free" as its own final message
    if (shouldSendFeelFree) {
      await new Promise(r => setTimeout(r, 400));
      await sendAIText(FEEL_FREE_TEXT);
    }

    // ── Push notifications ──────────────────────────────────────────────────
    // Only notify agents when the AI is deferring and a human needs to follow up
    const NEEDS_HUMAN_PATTERNS = [
      /let me check.*(?:get back|come back)/i,
      /allow me to check/i,
      /check.*slot.*availability/i,
      /check.*availability.*come back/i,
      /get back to you/i,
      /come back to you/i,
      /check.*(?:area|location).*service/i,
      /best options for your children/i,
    ];
    const needsHuman = NEEDS_HUMAN_PATTERNS.some(p => p.test(aiReply));

    if (needsHuman) {
      // Flag conversation as needing human attention
      supabase.from('conversations').update({ needs_human: true }).eq('phone', fullPhone).then(() => {});
      sendPushToAll({
        title: `${displayContact}`,
        body: `Follow-up required for ${displayContact} (${fullPhone}): "${aiReply.slice(0, 100)}"`,
        phone: fullPhone,
        icon: "/icon-192.png"
      }).catch(() => {});
    }

    console.log("Buffered message sent successfully");
  } catch (err) {
    console.error("handleAIResponse error", err.response?.data || err.message || err);
  }
}

// Helper: upload external media URL to BotSpace and return mediaId
async function uploadToBotspace(mediaUrl) {
  try {
    const resp = await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/media/upload?apiKey=${BOTSPACE_API_KEY}`,
      { url: mediaUrl },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return resp?.data?.data?.id || null;
  } catch (err) {
    console.error('uploadToBotspace error', err.response?.data || err.message || err);
    return null;
  }
}

// Serve the KidDost welcome flyer image
app.use('/static', express.static(__dirname));

// Send 3-part welcome sequence to a new user
async function sendWelcome(fullPhone) {
  const sendText = async (text) => {
    await supabase.from('messages').insert({
      phone: fullPhone, role: 'assistant', content: text, sender: 'ai', agent: null, ai_enabled: true
    });
    await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message`,
      { name: 'KidDost', phone: fullPhone, text },
      { params: { apiKey: BOTSPACE_API_KEY }, headers: { 'Content-Type': 'application/json' } }
    );
  };
  try {
    // 1. Greeting
    await sendText('Hi, thank you for contacting KidDost.');
    await new Promise(r => setTimeout(r, 800));
    // 2. Flyer image (send via BotSpace; save a placeholder to DB so dashboard shows it)
    const SERVER_URL = process.env.SERVER_URL || 'https://kiddost-ai.onrender.com';
    const imageUrl = `${SERVER_URL}/static/image.png`;
    await supabase.from('messages').insert({
      phone: fullPhone, role: 'assistant', content: '', media_url: imageUrl, sender: 'ai', agent: null, ai_enabled: true
    });
    await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-media-message?apiKey=${BOTSPACE_API_KEY}`,
      { name: 'KidDost', phone: fullPhone, mediaUrl: imageUrl, mediaType: 'image', label: '' },
      { headers: { 'Content-Type': 'application/json' } }
    );
    await new Promise(r => setTimeout(r, 3000));
    // 3. Follow-up
    await sendText('Feel free to let us know if you have any questions.');
    console.log('[welcome] sent to', fullPhone);
  } catch (e) {
    console.error('[welcome] failed:', e.response?.data || e.message);
  }
}

// Health check
app.get("/", (req, res) => {
  res.send("Kiddost AI running");
});

// List all active agents (names + ids only, no PINs) — used by login profile picker
app.get("/agents", async (req, res) => {
  const profiles = [];
  if (supabaseService) {
    const { data } = await supabaseService
      .from('agents')
      .select('id, name')
      .order('created_at', { ascending: true });
    if (data) profiles.push(...data);
  }
  // Always include Admin card if DASHBOARD_PIN is configured
  if (process.env.DASHBOARD_PIN) {
    profiles.push({ id: 'admin', name: 'Admin' });
  }
  return res.json({ agents: profiles });
});

// Agent login — accepts agentId to restrict hash lookup to that specific account
app.post("/agent-login", async (req, res) => {
  const { pin, agentId } = req.body;
  if (!pin || typeof pin !== "string") return res.status(400).json({ error: "missing_pin" });
  const hashed = hashPin(pin.trim());

  // Admin shortcut (DASHBOARD_PIN)
  if (agentId === 'admin' || !agentId) {
    const DASHBOARD_PIN = process.env.DASHBOARD_PIN;
    if (DASHBOARD_PIN && pin.trim() === DASHBOARD_PIN) {
      return res.json({ success: true, name: 'Admin' });
    }
    if (agentId === 'admin') return res.status(401).json({ error: 'invalid_pin' });
  }

  // Check agents table — if agentId given, restrict to that row only
  if (supabaseService) {
    let query = supabaseService
      .from('agents')
      .select('id, name')
      .eq('pin_hash', hashed);
    if (agentId && agentId !== 'admin') query = query.eq('id', agentId);
    const { data: agent } = await query.maybeSingle();
    if (agent) return res.json({ success: true, name: agent.name, id: agent.id });
  }

  return res.status(401).json({ error: 'invalid_pin' });
});

// Backward compat alias
app.post("/verify-pin", async (req, res) => {
  const { pin } = req.body;
  const DASHBOARD_PIN = process.env.DASHBOARD_PIN;
  if (DASHBOARD_PIN && pin === DASHBOARD_PIN) return res.json({ success: true, name: 'Admin' });
  return res.status(401).json({ error: 'invalid_pin' });
});

// Request OTP to create a new agent — sends to ADMIN_PHONE via BotSpace WhatsApp
app.post("/request-agent-otp", async (req, res) => {
  const ADMIN_PHONE = process.env.ADMIN_PHONE;
  if (!ADMIN_PHONE) return res.status(500).json({ error: 'no_admin_phone_configured' });

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const token = crypto.randomBytes(16).toString('hex');
  otpStore[token] = { otp, expiresAt: Date.now() + 10 * 60 * 1000 };

  try {
    await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message`,
      { name: 'Kiddost', phone: ADMIN_PHONE, text: `🔐 Kiddost Agent OTP: *${otp}*\n\nSomeone is requesting to add a new agent to the dashboard. If this was you, enter this code. Expires in 10 minutes.` },
      { params: { apiKey: BOTSPACE_API_KEY }, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Failed to send OTP via BotSpace', err.response?.data || err.message);
    return res.status(500).json({ error: 'failed_to_send_otp' });
  }

  return res.json({ success: true, token });
});

// Create new agent — verify OTP then insert into agents table
app.post("/create-agent", async (req, res) => {
  const { token, otp, name, pin } = req.body;
  if (!token || !otp || !name || !pin) return res.status(400).json({ error: 'missing_params' });
  if (!supabaseService) return res.status(500).json({ error: 'missing_service_role_key' });

  const stored = otpStore[token];
  if (!stored) return res.status(400).json({ error: 'invalid_token' });
  if (Date.now() > stored.expiresAt) {
    delete otpStore[token];
    return res.status(400).json({ error: 'otp_expired' });
  }
  if (stored.otp !== String(otp).trim()) return res.status(401).json({ error: 'invalid_otp' });

  delete otpStore[token];

  const pinHash = hashPin(String(pin).trim());
  const safeName = String(name).trim().slice(0, 50);

  const { data: created, error: insertError } = await supabaseService
    .from('agents')
    .insert({ name: safeName, pin_hash: pinHash, active: true })
    .select('id')
    .single();

  if (insertError) {
    console.error('create-agent insert error', insertError);
    return res.status(500).json({ error: 'db_error', detail: insertError.message });
  }

  return res.json({ success: true, name: safeName, id: created?.id ?? null });
});

// Delete an agent account — requires matching agentId + PIN
app.post('/delete-agent', async (req, res) => {
  const { agentId, pin } = req.body;
  if (!agentId || !pin || typeof pin !== 'string') return res.status(400).json({ error: 'missing_fields' });
  if (agentId === 'admin') return res.status(403).json({ error: 'cannot_delete_admin' });
  if (!supabaseService) return res.status(500).json({ error: 'missing_service_role_key' });

  const hashed = hashPin(pin.trim());
  const { data: agent } = await supabaseService
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('pin_hash', hashed)
    .maybeSingle();

  if (!agent) return res.status(401).json({ error: 'invalid_pin' });

  await supabaseService.from('agents').delete().eq('id', agentId);
  return res.json({ ok: true });
});

// In-memory store for last 20 webhook bodies (for debugging)
const recentWebhooks = [];
app.get("/debug-webhooks", (req, res) => {
  res.json({ count: recentWebhooks.length, webhooks: recentWebhooks });
});

// Push notification endpoints
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/push-subscribe', async (req, res) => {
  const { subscription, agent } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'invalid_subscription' });
  pushSubscriptions.set(subscription.endpoint, { subscription, agent });
  await upsertPushSubscription(subscription, agent);
  console.log(`[push] subscribed: ${agent} (${pushSubscriptions.size} total)`);
  res.json({ ok: true });
});

app.post('/push-unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    pushSubscriptions.delete(endpoint);
    await deletePushSubscription(endpoint);
  }
  res.json({ ok: true });
});

async function sendPushToAll(payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  if (pushSubscriptions.size === 0) {
    console.log('[push] no active subscriptions; skipping notification');
    return;
  }
  const dead = [];
  for (const [endpoint, { subscription }] of pushSubscriptions) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(endpoint);
      else console.error('[push] send error:', e.message);
    }
  }
  for (const ep of dead) {
    pushSubscriptions.delete(ep);
    await deletePushSubscription(ep);
  }
}

// Shared contacts (stored in Supabase so all agents see the same names)
app.get('/contacts', async (req, res) => {
  const { data, error } = await supabase.from('contacts').select('phone, name, notes, labels');
  if (error) return res.status(500).json({ error: error.message });
  const map = {};
  for (const row of (data || [])) map[row.phone] = { name: row.name || '', notes: row.notes || '', labels: row.labels || [] };
  res.json({ contacts: map });
});

// Return phones that need human attention (red dot on dashboard)
app.get('/needs-human', async (req, res) => {
  const { data, error } = await supabase.from('conversations').select('phone').eq('needs_human', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ phones: (data || []).map(r => r.phone) });
});

app.post('/contacts', async (req, res) => {
  const { phone, name, notes } = req.body;
  if (!phone) return res.status(400).json({ error: 'missing phone' });
  const { error } = await supabase.from('contacts').upsert({ phone, name: name || '', notes: notes || '' }, { onConflict: 'phone' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Label endpoints — persist to Supabase and proxy add/remove to BotSpace
app.post('/label', async (req, res) => {
  const { phone, label } = req.body;
  if (!phone || !label) return res.status(400).json({ error: 'missing phone or label' });

  // Persist label to Supabase contacts table
  const { data: existing } = await supabase.from('contacts').select('labels').eq('phone', phone).maybeSingle();
  const currentLabels = existing?.labels || [];
  if (!currentLabels.includes(label)) {
    await supabase.from('contacts').upsert({ phone, labels: [...currentLabels, label] }, { onConflict: 'phone' });
  }

  // Also send to BotSpace if we have the conversationId
  const { data: conv } = await supabase.from('conversations').select('conversation_id').eq('phone', phone).maybeSingle();
  const conversationId = conv?.conversation_id;
  if (conversationId) {
    try {
      await axios.post(
        `https://public-api.bot.space/v1/${CHANNEL_ID}/conversation/${conversationId}/labels?apiKey=${BOTSPACE_API_KEY}`,
        { labels: [label] },
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      console.error('[label] BotSpace add error', e?.response?.data || e.message);
    }
  }
  res.json({ ok: true });
});

app.delete('/label', async (req, res) => {
  const { phone, label } = req.query;
  if (!phone || !label) return res.status(400).json({ error: 'missing phone or label' });

  // Remove from Supabase
  const { data: existing } = await supabase.from('contacts').select('labels').eq('phone', phone).maybeSingle();
  const updatedLabels = (existing?.labels || []).filter(l => l !== label);
  await supabase.from('contacts').upsert({ phone, labels: updatedLabels }, { onConflict: 'phone' });

  // Also remove from BotSpace
  const { data: conv } = await supabase.from('conversations').select('conversation_id').eq('phone', phone).maybeSingle();
  const conversationId = conv?.conversation_id;
  if (conversationId) {
    try {
      await axios.delete(
        `https://public-api.bot.space/v1/${CHANNEL_ID}/conversation/${conversationId}/labels/${encodeURIComponent(label)}?apiKey=${BOTSPACE_API_KEY}`
      );
    } catch (e) {
      console.error('[label] BotSpace remove error', e?.response?.data || e.message);
    }
  }
  res.json({ ok: true });
});

app.delete('/reset-conversation', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'missing phone' });
  const { error: msgErr } = await supabase.from('messages').delete().eq('phone', phone);
  if (msgErr) return res.status(500).json({ error: msgErr.message });
  // Also remove from conversations table so the welcome flow re-triggers on next message
  const { error: convErr } = await supabase.from('conversations').delete().eq('phone', phone);
  if (convErr) return res.status(500).json({ error: convErr.message });
  res.json({ ok: true, message: `Cleared conversation history for ${phone}` });
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Store for debug inspection
    recentWebhooks.unshift({ ts: new Date().toISOString(), body });
    if (recentWebhooks.length > 20) recentWebhooks.pop();

    console.log("Full incoming body:");
    console.log(JSON.stringify(body, null, 2));
    console.log('[webhook] event:', body?.event, '| type:', body?.type, '| status:', body?.status || body?.payload?.status);

    // Handle delivery / status webhooks from BotSpace / WhatsApp
    // Catch any event that carries a status field or has status-related event name
    const isStatusEvent = body?.event === 'delivery-update' ||
      body?.event === 'message-status' || body?.event === 'message-delivered' ||
      body?.event === 'message-read' || body?.event === 'message-seen' ||
      body?.event === 'status' || body?.type === 'status' ||
      (body?.payload?.status && body?.direction === 'outgoing') ||
      (body?.status && body?.direction === 'outgoing');

    if (isStatusEvent) {
      const messageId = body?.id || body?.messageId || body?.message_id || body?.payload?.messageId || body?.payload?.message_id || body?.payload?.id;
      const rawStatus = body?.status || body?.payload?.status || body?.delivery_status || body?.payload?.delivery_status;
      // Normalise to consistent lowercase values
      const statusMap = { delivered: 'delivered', delivery: 'delivered', read: 'read', seen: 'read', sent: 'sent', accepted: 'sent', enqueued: 'sent' };
      const status = rawStatus ? (statusMap[String(rawStatus).toLowerCase()] || String(rawStatus).toLowerCase()) : null;
      if (messageId && status) {
        try {
          await supabase
            .from("messages")
            .update({ status })
            .eq("whatsapp_id", messageId);
          console.log(`Updated message status for ${messageId} -> ${status}`);
        } catch (e) {
          console.error("Failed to update message status", e?.message || e);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // Extract phone info
    const countryCode = body?.phone?.countryCode;
    const phone = body?.phone?.phone;
    if (!countryCode || !phone) {
      console.log("Missing phone info");
      return res.status(200).json({ ok: true });
    }

    const fullPhone = `+${countryCode}${phone}`;
    const contactName = body?.customer?.name?.trim() || '';

    // Safely extract message or media
    let message = null;
    let mediaUrl = null;
    let incomingContentType = null;
    if (body.payload?.type === 'text') {
      message = body.payload?.payload?.text || null;
    } else if (body.payload?.type === 'media') {
      mediaUrl = body.payload?.payload?.url || null;
      incomingContentType = body.payload?.payload?.contentType || null;
    }

    console.log("Extracted message:", message);
    console.log("Extracted media:", mediaUrl);
    console.log("From:", fullPhone);

    if (!message && !mediaUrl) {
      console.log("Missing required fields or empty payload");
      return res.status(200).json({ ok: true });
    }

    const { data: existingConversation } = await supabase
      .from("conversations")
      .select("phone")
      .eq("phone", fullPhone)
      .maybeSingle();

    const botspaceConversationId = body?.customer?.id || null;

    const isNewUser = !existingConversation;
    if (isNewUser) {
      await supabase.from("conversations").insert({
        phone: fullPhone,
        conversation_id: botspaceConversationId
      });
      // Trigger welcome sequence for brand-new users (don't await — fire and forget)
      sendWelcome(fullPhone).catch(e => console.error('[welcome] error', e.message));
    } else if (botspaceConversationId) {
      await supabase.from("conversations").update({ conversation_id: botspaceConversationId }).eq("phone", fullPhone);
    }

    // Determine previous AI state for this conversation
    let lastBefore = null;
    let lastUserBefore = null;
    try {
      const { data: lb, error: lbErr } = await supabase
        .from("messages")
        .select("*")
        .eq("phone", fullPhone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lbErr) lastBefore = lb;

      const { data: lub, error: lubErr } = await supabase
        .from("messages")
        .select("created_at")
        .eq("phone", fullPhone)
        .eq("sender", "user")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lubErr) lastUserBefore = lub;
    } catch (e) {
      lastBefore = null;
      lastUserBefore = null;
    }

    const aiEnabledForInsert = lastBefore && typeof lastBefore.ai_enabled !== 'undefined' ? lastBefore.ai_enabled : true;
    const LONG_GAP_MS = 14 * 24 * 60 * 60 * 1000;
    const shouldWelcomeBack = !!(
      !isNewUser &&
      lastUserBefore?.created_at &&
      (Date.now() - new Date(lastUserBefore.created_at).getTime() >= LONG_GAP_MS)
    );

    // If incoming media URL is provided, try to fetch it and store
    let storedMediaUrl = mediaUrl || null;
    if (mediaUrl && supabaseService) {
      try {
        const fetchResp = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(fetchResp.data);
        // Prefer the contentType from the BotSpace webhook payload (accurate) over the HTTP header (often octet-stream)
        const contentType = incomingContentType || (fetchResp.headers['content-type'] !== 'application/octet-stream' ? fetchResp.headers['content-type'] : null) || 'application/octet-stream';
        const safePhone = String(fullPhone).replace(/^\+/, '');
        const ext = (contentType.split('/')[1] || '').split(';')[0].split('+')[0];
        const safeExt = ext ? `.${ext}` : '';
        const safeName = `incoming_${Date.now()}${safeExt}`;
        const path = `${safePhone}/${safeName}`;

        const { error: uploadErr } = await supabaseService.storage.from('media').upload(path, buffer, { cacheControl: '3600', upsert: false, contentType });
        if (uploadErr) {
          console.error('service upload error (incoming media)', uploadErr);
        } else {
          const publicRes = supabaseService.storage.from('media').getPublicUrl(path);
          storedMediaUrl = publicRes?.data?.publicUrl || storedMediaUrl;
        }
      } catch (e) {
        console.error('failed to fetch/upload incoming media', e.response?.data || e.message || e);
      }
    }

    // Save user message (preserve ai_enabled if conversation previously disabled)
    const { error: userInsertError } = await supabase.from("messages").insert({
      phone: fullPhone,
      role: "user",
      content: message || "",
      sender: "user",
      media_url: storedMediaUrl || null,
      ai_enabled: aiEnabledForInsert
    });
    if (userInsertError) console.error('/webhook user insert error', userInsertError.message, { storedMediaUrl });

    // Do not push on every inbound message.
    // Push alerts are sent only from agent-needed paths (UNSURE / human-handoff patterns).
 
    // If AI is disabled for this conversation, skip buffering/respon
    const { data: last, error: lastErr } = await supabase
      .from("messages")
      .select("*")
      .eq("phone", fullPhone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastErr) {
      console.log("Supabase fetch error:", lastErr);
    }

    if (last && last.ai_enabled === false) {
      console.log("AI disabled for this conversation");
      return res.status(200).json({ success: true, ai_skipped: true });
    }

    // Only buffer text messages for AI (ignore pure media for AI, and skip for brand-new users)
    if (message && !isNewUser) {
      if (!messageBuffers[fullPhone]) messageBuffers[fullPhone] = [];
      messageBuffers[fullPhone].push(message);
      if (shouldWelcomeBack) welcomeBackFlags[fullPhone] = true;

      // clear previous timer if any
      if (messageTimers[fullPhone]) {
        clearTimeout(messageTimers[fullPhone]);
      }

      // wait MESSAGE_BUFFER_DELAY_MS before sending combined text to AI
      messageTimers[fullPhone] = setTimeout(async () => {
        const combined = (messageBuffers[fullPhone] || []).join(" ").trim();
        const prependWelcomeBack = !!welcomeBackFlags[fullPhone];
        // reset buffer
        messageBuffers[fullPhone] = [];
        welcomeBackFlags[fullPhone] = false;
        try {
          if (combined) {
            await handleAIResponse(fullPhone, combined, { prependWelcomeBack, contactName });
          }
        } catch (e) {
          console.error('buffered AI handler error', e?.message || e);
        }
      }, MESSAGE_BUFFER_DELAY_MS);
    }

    // respond quickly to webhook sender
    return res.status(200).json({ success: true, buffered: !!message });

  } catch (error) {
    console.log("=== ERROR ===");
    console.log(error.response?.data || error.message);
    res.status(200).json({ error: true });
  }
});
// List approved WhatsApp templates from BotSpace
app.get('/templates', async (req, res) => {
  try {
    const resp = await axios.get(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/templates`,
      { params: { apiKey: BOTSPACE_API_KEY } }
    );
    // Return raw response so client can inspect structure
    console.log('[templates] raw BotSpace response:', JSON.stringify(resp.data).slice(0, 1000));
    res.json(resp.data);
  } catch (e) {
    const d1 = e?.response?.data || e.message;
    console.error('[templates] URL1 error status:', e?.response?.status, 'body:', JSON.stringify(d1));
    // Try alternate URL if first fails
    try {
      const resp2 = await axios.get(
        `https://public-api.bot.space/v1/${CHANNEL_ID}/templates`,
        { params: { apiKey: BOTSPACE_API_KEY } }
      );
      console.log('[templates] alt URL raw response:', JSON.stringify(resp2.data).slice(0, 1000));
      res.json(resp2.data);
    } catch (e2) {
      const d2 = e2?.response?.data || e2.message;
      console.error('[templates] URL2 error status:', e2?.response?.status, 'body:', JSON.stringify(d2));
      res.status(500).json({ error: 'failed_to_fetch_templates', detail: d1, alt_detail: d2 });
    }
  }
});

// Send a WhatsApp template message and save it to the messages table
app.post('/send-template', async (req, res) => {
  const { phone, name, templateId, variables, mediaVariable, agent: agentName } = req.body;
  if (!phone || !templateId) return res.status(400).json({ error: 'missing fields' });

  let botResp;
  try {
    const payload = { name: name || '', phone, templateId, variables: variables || [] };
    if (mediaVariable) payload.mediaVariable = mediaVariable;
    botResp = await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-message`,
      payload,
      { params: { apiKey: BOTSPACE_API_KEY }, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('[send-template] BotSpace error', e?.response?.data || e.message);
    return res.status(500).json({ error: 'botspace_error', detail: e?.response?.data || e.message });
  }

  const d = botResp?.data;
  const whatsappId = d?.data?.id || d?.data?.messageId || d?.messageId || d?.id || null;

  const TEMPLATE_PREVIEWS = {
    session: 'Hi, would you like to go ahead with the session today?',
  };
  const preview = TEMPLATE_PREVIEWS[templateId] || `[Template: ${templateId}]${variables?.length ? ' ' + variables.join(', ') : ''}`;

  try {
    await supabase.from('messages').insert({
      phone,
      role: 'assistant',
      content: preview,
      sender: 'agent',
      agent: agentName || 'Agent',
      ai_enabled: false,
      whatsapp_id: whatsappId,
      status: 'sent',
    });
    await supabase.from('conversations').update({ ai_paused: true }).eq('phone', phone);
  } catch (dbErr) {
    console.error('[send-template] DB error', dbErr?.message || dbErr);
  }

  res.json({ ok: true, whatsapp_id: whatsappId });
});

app.post("/agent-send", async (req, res) => {
  try {

    const { phone, message } = req.body;

    console.log("Agent message:", phone, message);

    // Send WhatsApp message through BotSpace and capture returned message id/status
    const agentName = req.body.agent || "Daksh";
    let botResp;
    try {
      botResp = await axios.post(
        `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message`,
        {
          phone: phone,
          text: message
        },
        {
          params: {
            apiKey: BOTSPACE_API_KEY
          }
        }
      );
    } catch (err) {
      console.log("BotSpace send error:", err.response?.data || err.message || err);
      return res.status(500).json({ error: true, detail: "botspace_send_failed" });
    }

    // Attempt to extract a whatsapp message id and status from BotSpace response
    console.log('BotSpace full response data:', JSON.stringify(botResp?.data));
    const d = botResp?.data;
    const whatsappId =
      d?.messageId || d?.message_id || d?.id ||
      d?.data?.messageId || d?.data?.message_id || d?.data?.id ||
      d?.message?.id || d?.message?.messageId ||
      d?.payload?.messageId || d?.payload?.id ||
      null;
    const status = d?.status || d?.data?.status || "sent";

    // Save message to database with whatsapp id and status
    try {
      await supabase.from("messages").insert({
        phone: phone,
        role: "assistant",
        content: message,
        sender: "agent",
        agent: agentName,
        ai_enabled: false,
        whatsapp_id: whatsappId,
        status: status
      });

      // Also update conversations table flag for compatibility
      await supabase
        .from("conversations")
        .update({ ai_paused: true, needs_human: false })
        .eq("phone", phone);
    } catch (dbErr) {
      console.error("Failed to insert agent message into supabase", dbErr?.message || dbErr);
    }

    if (whatsappId) console.log('[agent-send] whatsapp_id captured:', whatsappId, 'status:', status);

    res.json({ success: true, whatsapp_id: whatsappId, status });

  } catch (err) {

    console.log("Agent send error:", err.response?.data || err.message);

    res.status(500).json({
      error: true
    });

  }
});

// Endpoint to send media messages from agent and record them
app.post("/agent-send-media", async (req, res) => {
  const { phone, mediaUrl, caption } = req.body;

  console.log("/agent-send-media body:", req.body);

  try {
    // Auto-detect mediaType from URL extension
    function detectMediaType(url) {
      const clean = (url || '').split('?')[0].toLowerCase();
      if (/\.(mp4|mov|avi|mkv|webm|3gp)$/.test(clean)) return 'video';
      if (/\.(mp3|ogg|wav|m4a|aac)$/.test(clean)) return 'audio';
      if (/\.pdf$/.test(clean)) return 'document';
      return 'image'; // default
    }
    const payload = {
      name: "Agent",
      phone: phone,
      mediaUrl: mediaUrl,
      mediaType: detectMediaType(mediaUrl),
      label: caption || ""
    };

    console.log('BOTSPACE MEDIA PAYLOAD', payload);

    const response = await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-media-message?apiKey=${BOTSPACE_API_KEY}`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    console.log('BOTSPACE RESPONSE', response.data);

    const { data: insertData, error: insertError } = await supabase.from("messages").insert({
      phone: phone,
      role: "assistant",
      sender: "agent",
      content: caption || "",
      media_url: mediaUrl,
      whatsapp_id: response?.data?.data?.id || response?.data?.data?.messageId || response?.data?.messageId || response?.data?.id || response?.data?.message_id || null
    });
    console.log('/agent-send-media insert result', { insertError, insertData });

    const mediaMsgId = response?.data?.data?.id || response?.data?.data?.messageId || response?.data?.messageId || response?.data?.id || null;
    if (mediaMsgId) console.log('[agent-send-media] whatsapp_id captured:', mediaMsgId);

    res.json({ success: true });
  } catch (err) {
    console.error('BotSpace send-media error', err.response?.data || err);
    res.status(500).json({ error: 'Failed to send media' });
  }
});

// Ensure the 'media' storage bucket exists (idempotent) — useful when client can't upload
app.post('/ensure-media-bucket', async (req, res) => {
  try {
    const bucketName = 'media';
    // try to create bucket; if it exists, Supabase returns an error which we ignore
    const { data, error } = await supabase.storage.createBucket(bucketName, { public: true });
    if (error && !/already exists/i.test(String(error.message || ''))) {
      console.error('createBucket error', error.message || error);
      return res.status(500).json({ error: true, detail: 'create_bucket_failed' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('/ensure-media-bucket error', err.message || err);
    return res.status(500).json({ error: true });
  }
});

// Server-side upload endpoint: accepts base64 file, uploads to Supabase storage using service role, returns public URL
app.post('/upload-media-server', express.json({ limit: '100mb' }), async (req, res) => {
  try {
    // Ensure CORS headers present for browsers (handle cases where middleware may not run)
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    if (!supabaseService) return res.status(500).json({ error: 'missing_service_role_key' });
    const { fileBase64, fileName, phone, fileType } = req.body;
    if (!fileBase64 || !fileName || !phone) return res.status(400).json({ error: 'missing_params' });

    // sanitize phone for storage path: remove leading + to avoid issues with some fetchers
    const safePhone = String(phone).replace(/^\+/, '');
    const safeName = String(fileName).replace(/[^a-zA-Z0-9.\-_\.]/g, '_');
    const path = `${safePhone}/${Date.now()}_${safeName}`;

    const buffer = Buffer.from(fileBase64, 'base64');

    const uploadOptions = { cacheControl: '3600', upsert: false, contentType: fileType || 'application/octet-stream' };

    const { error: uploadError } = await supabaseService.storage.from('media').upload(path, buffer, uploadOptions);
    if (uploadError) {
      console.error('service upload error', uploadError);
      return res.status(500).json({ error: 'upload_failed', detail: uploadError.message || uploadError });
    }

    const publicRes = supabaseService.storage.from('media').getPublicUrl(path);
    const publicUrl = publicRes?.data?.publicUrl || null;
    return res.json({ success: true, publicUrl });
  } catch (err) {
    console.error('/upload-media-server error', err.message || err);
    return res.status(500).json({ error: true });
  }
});

// Toggle AI on/off via system message
app.post('/toggle-ai', async (req, res) => {
  try {
    const { phone, ai_enabled } = req.body;
    if (typeof phone === 'undefined' || typeof ai_enabled === 'undefined') {
      return res.status(400).json({ error: 'missing phone or ai_enabled' });
    }

    // Insert a system message so the next webhook message inherits the correct ai_enabled state
    await supabase.from("messages").insert({
      phone: phone,
      role: "system",
      content: ai_enabled ? "AI resumed" : "AI paused by agent",
      sender: "system",
      ai_enabled: !!ai_enabled
    });

    // Also update conversations table flag for compatibility
    await supabase.from('conversations').upsert({ phone, ai_paused: !ai_enabled });

    res.json({ success: true });
  } catch (err) {
    console.error('toggle-ai error', err.message || err);
    res.status(500).json({ error: true });
  }
});
// Debug endpoint: return recent messages (for troubleshooting frontend visibility)
app.get('/debug-messages', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, phone, content, media_url, whatsapp_id, status, sender, role, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    return res.json({ data, error });
  } catch (e) {
    console.error('/debug-messages error', e?.message || e);
    return res.status(500).json({ error: true });
  }
});

// Debug endpoint: show exactly what prompt would be sent to the AI for a given phone + test message
app.get('/debug-prompt', async (req, res) => {
  try {
    const { phone, message } = req.query;
    if (!phone || !message) return res.status(400).json({ error: 'pass ?phone=+91...&message=...' });

    const { data } = await supabase
      .from("messages")
      .select("role, content")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(10);
    const history = Array.isArray(data) ? data.reverse() : [];

    const exampleChat = findBestExampleChat(message);
    const programDescription = exampleChat ? extractProgramDescription(exampleChat) : null;
    const exampleBlock = exampleChat
      ? `\n\n---\n${programDescription ? `KIDDOST PROGRAM DESCRIPTION (extracted from a real conversation — when the user asks about activities or programs, use this description word for word, do not swap these activities for others):\n"${programDescription}"\n\n` : ""}Full example conversation (use for tone and style only):\n\`\`\`\n${formatExampleChat(exampleChat)}\n\`\`\`\n\nDO NOT copy from the example: specific names, dates, prices, locations, or availability.\n---`
      : "";

    const systemPrompt = `You are a WhatsApp assistant for KidDost, a child engagement and tutoring service in Bangalore for children aged 1 to 8 years (we also make exceptions for infants from 4 months).

Your tone:
- Friendly, warm, and human-like (like a real WhatsApp agent)
- Slightly sales-oriented but never pushy
- Clear and concise (2–5 short lines max)
- Never robotic or overly formal
- NO emojis — ever

CURRENT TIME: ${new Date(Date.now() + 5.5 * 60 * 60 * 1000).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} IST (24-hour format)

CRITICAL RULES:
- Always base your answer on the CURRENT conversation context
- Use ONLY the activities mentioned in the example conversation below — NEVER invent activities not found there
- DO NOT copy specific names, dates, prices, or availability from the example conversation
- If the user asks about availability (dates/tomorrow/etc), respond generally or ask for confirmation instead of assuming
- DO NOT use emojis in any response
- NEVER ask for the child's age if it was ALREADY mentioned earlier in the conversation or in KNOWN FACTS. Read the full history before responding.
- NEVER repeat information you have already given. If you already shared activities, pricing, or introductory session details earlier in the conversation, do NOT repeat them. Just answer the new question directly.
- If the child's name is shared voluntarily, remember it and use it naturally later.
- Only include "Feel free to let us know if you have any questions." when you are finishing a substantial info block (pricing/activities). Do NOT add it to every single message.
- ONLY answer questions that are explicitly covered in the RESPONSE PLAYBOOK below. If a question is not covered, reply UNSURE.
- Do NOT improvise, fabricate, assume, or fill gaps with your own knowledge. You only know what is written in this prompt and the conversation history.
- When in doubt, ALWAYS err on the side of saying UNSURE. A wrong answer is far worse than deferring to a human agent.

IMPORTANT — UNSURE threshold:
- If you are not 100% certain your answer is correct based on THIS prompt, reply with ONLY the single word: UNSURE
- Do NOT guess, speculate, or give a "probably" answer — just say UNSURE
- Do not add any other text when you reply UNSURE
- It is ALWAYS better to say UNSURE than to give an incorrect or made-up answer

---
RESPONSE PLAYBOOK — stick closely to these scripts. You may adjust phrasing slightly for natural conversation, but do NOT add information that isn't explicitly stated here. If the user asks something not covered below, reply UNSURE.

PRICING / SERVICES / QUOTATION:
- Check the conversation history first. If the child's age was already mentioned, use it — do NOT ask again.
- If age is not known yet, naturally ask for the child's age — phrase it conversationally, e.g. "Could you share your child's age?" or "May I know how old your child is?" — do NOT start with "Sure,"
- Once age is known, give the appropriate activities response (paraphrasing is fine, keep the core activities accurate):
  • Under 4 months: Explain this is too young and you might not be the right fit.
  • 4m–under 1 year: Explain the age category starts from 1 year, but on request of parents you have provided service for infants as young as 4 months. The team engages through verbal interaction, rhymes, flashcards etc. The aim is to give parents some free time. Clarify no massage/bathing. All members are female graduates, English interaction.
  • Age 1 to under 2 (including 1.5 years, 18 months): Verbal interaction, age-appropriate puzzles, flashcards, rhymes, storybook reading, park outings.
  • Age 2: Verbal interaction, puzzles, rhymes, simple art & craft, storybook reading, shapes/colours/numbers, park outings.
  • Age 3: Puzzles, memory games, art & craft, brain-boosting activities, storybook reading, phonics, writing practice, park outings.
  • Age 4 to 8: Puzzles, memory games, art & craft, brain-boosting activities, storybook reading, worksheets, study help if needed, park outings.
  • Age above 8: Apologise — services are for children aged 1 to 8 years, you are not the right fit.
- After the activities (for ages 8 and below), write [PRICING_IMAGE] on its own line so the pricing image is sent.
- After the image, include the pricing context — use judgment on how much to say based on what they asked:
  • If they asked about full pricing/services: use this exact line — "We suggest scheduling a one-hour introductory session at your convenience. For the first experience of our service, we are happy to offer it at a discounted price of ₹500 per hour."
  • If they just asked about pricing as a follow-up and age is already known: write [PRICING_IMAGE] then briefly say "Please refer to the pricing details above."
- IMPORTANT: ALWAYS send [PRICING_IMAGE] before referencing pricing. Never say "refer to the pricing above" without first writing [PRICING_IMAGE] on its own line.
- End with "Feel free to let us know if you have any questions." as a separate line.
- Do NOT add nanny disclaimer unless the user specifically asked about nanny services.
- Do NOT send [PRICING_IMAGE] unless the conversation is specifically about pricing, services, or packages.

NANNY SERVICES (only when user asks about nanny/caretaker/babysitter):
- Step 1: If child's age is not already known, send ONLY "May I know the age of the child?" and nothing else in that message. Stop there.
- Step 2: Once age is known, give the appropriate activities response (follow the age-based scripts above), then write [PRICING_IMAGE].
- Step 3: After the activities and pricing image, add on a new line: "Would like to clarify — we don't provide nanny services. Our team members are female graduates or students pursuing graduation, and our primary mode of interaction is in English."
- If age is already known, skip Step 1 and go straight to Step 2.

VALUE PACKAGES (only when user asks about packages/plans/bundles):
- IMPORTANT: We call them "value packages", NOT "monthly packages".
- Write [MONTH_IMAGE] on its own line, then explain the package flexibility (bundle of sessions, discounted rate, can be used over 1–3 months).
- If the user asks something like "I have twins, what will be the monthly package?" do NOT ask for children's names. First share the value package details, then tell them that we can customize a package for two kids once we have done the introductory session and confirmed that we are a good fit for your requirements.
- End with "Feel free to let us know if you have any questions."

SESSION LENGTH / DURATION:
- If the user asks "how long are the sessions" or similar, answer: "You can book as per your requirement."

MEMBER QUALIFICATIONS:
- Motivated, compassionate female graduates/students passionate about teaching. Comprehensive in-house training.

SAME MEMBER EVERY TIME:
- We keep 2–3 members per account for continuity, accounting for short and long leaves.

SAFETY / BACKGROUND CHECKS:
- All our members are on our salary roll and we do our internal background verification before taking them onboard.
- Parents do not need to be present during the session — our members are trained professionals and the child can be left with them comfortably.

OTHER BABY WORK (feeding, cleaning, bathing, diaper change, etc.):
- This is NOT about activities or pricing. Do NOT re-share activities or ask for age.
- Simply explain: our scope is limited to engaging children through fun and learning activities. We do not handle feeding, bathing, diaper changes, or other caretaking tasks. However, we can encourage light snacks if the child is not a fussy eater.

TOO EXPENSIVE / OUT OF BUDGET:
- If the user says something like "Ok. Prices are quite high", reply with EXACTLY:
"Hi, regarding discounts, we've already offered our most competitive pricing. Our pricing structure remains consistent for all clients, including long-term renewals. We are doing our annual adjustments in near future and the current pricing is available for limited time period. We appreciate your understanding."
- If after that it's still too expensive for them, thank them for considering and invite them to reach out for ad-hoc support.

BUSINESS HOURS:
- We are operational from 9:00 AM to 7:45 PM IST.
- If the CURRENT TIME is before 9:00 AM or after 7:45 PM, and the user asks for something that requires human help (booking, cancellation, rescheduling, availability check, location check, or anything you would normally reply UNSURE to), politely let them know: "Our team is available between 9:00 AM and 7:45 PM. We will get back to you first thing in the morning!" (or "shortly" if it's close to 9:00 AM). Do NOT reply UNSURE in this case — send the business hours message instead.
- If the CURRENT TIME is within business hours, follow the normal flow below.
- IMPORTANT: Only use the out-of-hours message when the requested time is unambiguously outside 9:00 AM-7:45 PM (examples: 7 AM, 8 PM, 9 PM, 6 AM). Treat 5 PM-6 PM as VALID and within operational hours. If the time is ambiguous or plausibly within the window, do NOT reject it; proceed normally and let the human agent confirm availability.
- If someone asks for a session on Sunday, say that we are operational Monday to Saturday currently.

BEFORE BOOKING:
- Before proceeding with booking or slot availability, the child's age MUST already be known.
- If the child's age is not known yet, ask for the child's age first before collecting booking details.

- NEVER ask for information that the user has already provided earlier in the conversation.
- Before asking booking questions, carefully check the full conversation history for:
  - Child's age
  - Parent/customer name
  - Preferred date/time
  - Area/locality
- Only ask for the missing information.

- If the user requests booking for Sunday or says "tomorrow" when tomorrow is Sunday, reply that we are currently operational Monday to Saturday only, and ask if they would like to schedule for another day instead.
- Do NOT proceed to slot-availability flow for Sunday requests.

- Before proceeding to check slot availability, you MUST gather ALL of the following:
  1. Parent's/customer's name — if not known, ask: "And may I know your name as well?"
  2. Preferred date and time — ask: "What date and time would work best for you?"
  3. Area/locality — if not already known, ask: "Could you also share your area or locality so I can confirm we service your location?"
- You can combine multiple missing questions into one message.
- Only proceed to check availability once all required details are already available.
- IMPORTANT: While gathering details/date/time, you are still in normal conversation mode. Reply normally to their answers. Do NOT reply UNSURE during this phase.

GROUP / SIBLING SESSIONS:
- Do NOT ask about same-or-separate sessions the moment the customer mentions multiple children. Continue the normal conversation (ages, interests, activities, pricing, etc.) first.
- Only ask the same-or-separate question when the customer is READY TO BOOK (i.e. they express booking intent like "I want to book", "let's schedule", "book sessions", etc.) AND you already know they have multiple children.
- At that point, as part of the BEFORE BOOKING flow, include the question: "Would you like both children in the same session, or would you prefer separate sessions for each child?"
- You can combine this with other BEFORE BOOKING questions (parent name, date/time) in one message.
- Once you have the same-or-separate answer AND all the standard booking info (parent name, date/time), say EXACTLY: "Great, allow me to check the slot availability and the best options for your children and come back to you."
- After saying this, you must STOP. If the user replies with ANYTHING after that, respond with ONLY the word: UNSURE
- A human agent will follow up with group/sibling session details.

TIME SLOT REQUEST:
- Once you have the parent's name AND preferred date/time, say EXACTLY: "Sure, allow me to check the slot availability and come back to you."
- CRITICAL: The UNSURE rule ONLY activates after you have sent this EXACT check-availability message. NOT before.
- After you have said "allow me to check the slot availability and come back to you", you must STOP. If the user replies with ANYTHING after that (e.g. "Sure", "Ok", "Thanks", a name, a time), respond with ONLY the word: UNSURE
- Do NOT fabricate availability confirmations. You cannot actually check calendars. A human agent will respond once they have checked.
- If the conversation history shows you already said "allow me to check the slot availability" and no human agent has confirmed yet, reply UNSURE.

LOCATION / SERVICEABILITY:
We operate in Bangalore only with 3 service hubs (Marathahalli ~6km, Jayanagar ~10km, Electronic City ~3km).
The system automatically geocodes the user's location and injects a LOCATION VERIFIED message above. Follow it:
- If you see "LOCATION VERIFIED ✅" → confirm to the user: "Yes, we do service in [area]! 😊" and continue normally.
- If you see "LOCATION VERIFIED ❌" → say EXACTLY: "Let me check if we can service your area and get back to you." Then STOP. If the user replies anything after that, respond UNSURE.
- If NO location check was injected (user didn't mention a place) and they ask "do you service in X?", ask them to share their area name and you will check.
- If the user mentions ANY city/area other than Bangalore (e.g. Mysore, Chennai, Mumbai, Pune, Hyderabad, etc.) → NEVER say "yes we service there". Say EXACTLY: "Currently we operate only in Bangalore. We're expanding soon — would you like us to notify you when we're available in your area?" — this is NON-NEGOTIABLE.
- During the BEFORE BOOKING flow, after collecting parent name / preferred time, also ask for their area/locality if not already known: "Could you also share your area or locality so I can confirm we service your location?"
- Do NOT fabricate serviceability. Only confirm when you see a LOCATION VERIFIED ✅ system message.
---

Goal: Make the user feel like they are chatting with a real human agent and move them towards booking an introductory session.` +
      (KIDDOST_WEBSITE_CONTENT ? `\n\n---\nKidDost Knowledge Base (from www.kiddost.com — use this to answer factual questions about services, activities, philosophy, and contact):\n${KIDDOST_WEBSITE_CONTENT}\n---` : "") +
      exampleBlock;

    res.json({
      systemPrompt,
      history,
      userMessage: message,
      exampleChatFile: exampleChat?.file || null,
      websiteContentLength: KIDDOST_WEBSITE_CONTENT.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug endpoint: return recent messages (for troubleshooting frontend visibility)
app.get('/debug-messages', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, phone, content, media_url, whatsapp_id, status, sender, role, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    return res.json({ data, error });
  } catch (e) {
    console.error('/debug-messages error', e?.message || e);
    return res.status(500).json({ error: true });
  }
});

// Proxy image endpoint for non-public media (temporary fallback)
app.get('/proxy-image', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || typeof url !== 'string') return res.status(400).send('missing url');

    // Only allow known media host(s) for safety
    const allowedHosts = ['public-api.bot.space'];
    const parsed = new URL(url);
    if (!allowedHosts.includes(parsed.hostname)) return res.status(403).send('forbidden host');

    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    const buf = Buffer.from(resp.data);
    // Honor an explicit type hint (passed when storing proxy URL from webhook)
    const typeHint = req.query.type;
    let contentType = typeHint || resp.headers['content-type'] || 'application/octet-stream';

    // If upstream didn't provide a useful content-type, sniff common types from magic bytes
    if (!typeHint && (!contentType || contentType === 'application/octet-stream')) {
      if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        contentType = 'image/jpeg';
      } else if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        contentType = 'image/png';
      } else if (buf.length >= 4 && buf.slice(0, 4).toString() === '%PDF') {
        contentType = 'application/pdf';
      } else if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        contentType = 'image/gif';
      }
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    // Force inline disposition so browser attempts to render instead of download
    res.setHeader('Content-Disposition', 'inline');
    return res.end(buf);
  } catch (e) {
    console.error('/proxy-image error', e?.response?.status, e?.message || e);
    return res.status(500).send('proxy error');
  }
});
// ── Calendar Events ─────────────────────────────────────────────────────────

// AI: read last N messages and extract session date/time
app.post('/calendar/extract', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'missing phone' });

    const { data: msgs } = await supabase
      .from('messages')
      .select('role, content, sender, created_at')
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(8);

    if (!msgs || msgs.length === 0) return res.json({ extracted: null });

    const chatText = msgs.reverse().map(m => {
      const label = m.sender === 'agent' ? 'Agent' : m.sender === 'ai' ? 'Agent' : 'Customer';
      return `${label}: ${m.content}`;
    }).join('\n');

    console.log('[extract] phone:', phone, 'msgs:', msgs.length, 'chatText:', chatText.slice(0, 500));

    const aiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: (() => {
              const now = new Date();
              const cal = [];
              for (let i = 0; i < 60; i++) {
                const d = new Date(now); d.setDate(now.getDate() + i);
                cal.push(`${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toISOString().split('T')[0]}`);
              }
              return `You extract confirmed session booking details from a WhatsApp conversation.
TODAY is ${now.toISOString().split('T')[0]} (${now.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}).
UPCOMING CALENDAR (next 60 days):
${cal.join('\n')}
Use this calendar to resolve day names like "Sunday", "this Friday", "next Wednesday", "from next month", "starting May" to the correct YYYY-MM-DD date.
Return ONLY valid JSON with these fields (use null if not found):
- "title": short session title, e.g. "KidDost Session" or include child name if mentioned
- "date": ISO date string YYYY-MM-DD — the START date for the recurring series. This is the date of the FIRST session occurrence.
  * When "from next month" or "starting [month]" is mentioned, set date to the 1st of that month (or the first matching weekday in that month if repeatDays are given).
  * When a weekday name is mentioned (e.g. "every Thursday"), pick the NEAREST UPCOMING match from the calendar above.
  * When only a day number is mentioned (e.g. "10th"), assume the CURRENT month and year.
  * When "tomorrow" is mentioned, use tomorrow's date.
  * IMPORTANT: If repeatDays is set, date MUST be set to the first occurrence of the earliest repeat day. NEVER return null for date when repeatDays has values.
- "startTime": HH:MM in 24h format
- "endTime": HH:MM in 24h format. IMPORTANT: If TWO times are mentioned (e.g. "3 PM to 6 PM", "between 3 and 6 PM", "5-8 PM"), the first is startTime and the second is endTime — do NOT default to 1 hour. Only assume 1 hour after start if NO end time is mentioned at all.
- "isTrial": true if this appears to be a TRIAL/demo/first/introductory session, false otherwise. Look for words like "trial", "demo", "free session", "intro", "first session", "try", etc.
- "repeatCount": TOTAL number of sessions. If the conversation mentions a value package, recurring sessions, group package, or regular weekly sessions, set this to 11 (our standard value package is 11 sessions total). If they say "for a month" or "monthly", use 11. If a specific number of sessions is mentioned, use that number. If it's just a single one-off session, use 1. NOTE: this is total sessions, NOT weeks — e.g. if sessions are Thursday and Sunday, 11 means roughly 5–6 weeks with 11 sessions total across both days.
- "repeatDays": array of JS day numbers (0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday) for which days the session repeats. E.g. "every Tuesday and Thursday" → [2, 4]. "Friday Saturday" → [5, 6]. "Monday, Wednesday, Friday" → [1, 3, 5]. If only one day is mentioned or no specific days, return null.
- "notes": any extra details like location, special instructions
Extract if a session/booking/appointment is being discussed, requested, or confirmed — even if still tentative. Look for any mention of dates, times, or booking intent. Only return {"title":null} if there is absolutely no mention of any session or booking.`;
            })()
          },
          { role: 'user', content: chatText }
        ],
        temperature: 0,
        response_format: { type: 'json_object' }
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const extracted = JSON.parse(aiRes.data.choices[0].message.content);
    console.log('[extract] GPT raw:', aiRes.data.choices[0].message.content);
    return res.json({ extracted, chatSnippet: chatText.slice(0, 300) });
  } catch (e) {
    console.error('/calendar/extract error', e?.message || e);
    return res.status(500).json({ error: e.message });
  }
});

// List events (optional ?from=YYYY-MM-DD&to=YYYY-MM-DD)
app.get('/calendar/events', async (req, res) => {
  try {
    let query = supabase.from('calendar_events').select('*').order('date', { ascending: true }).order('start_time', { ascending: true });
    if (req.query.from) query = query.gte('date', req.query.from);
    if (req.query.to) query = query.lte('date', req.query.to);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ events: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Create event (supports repeat_count for weekly recurring, repeat_days for multi-day)
app.post('/calendar/events', async (req, res) => {
  try {
    const { phone, title, date, start_time, end_time, notes, created_by, repeat_count, repeat_days, is_trial, assigned_member } = req.body;
    if (!title || !date) return res.status(400).json({ error: 'title and date required' });
    const weeks = Math.min(Math.max(parseInt(repeat_count) || 1, 1), 52);

    // repeat_days: array of JS day numbers [0=Sun,1=Mon,...6=Sat]
    // If provided, generate events for each specified day across the given weeks
    const days = Array.isArray(repeat_days) && repeat_days.length > 0
      ? repeat_days.map(Number).filter(d => d >= 0 && d <= 6)
      : null;

    const rows = [];
    if (days && days.length > 0 && weeks > 1) {
      // Multi-day recurring: repeat_count is TOTAL sessions, distribute across selected days
      const baseDate = new Date(date + 'T00:00:00');
      const baseDay = baseDate.getDay();
      const totalSessions = weeks; // weeks var is actually total sessions

      // Sort days by offset from baseDay so events are created chronologically
      const sortedDays = [...days].sort((a, b) => {
        const offA = ((a - baseDay) % 7 + 7) % 7;
        const offB = ((b - baseDay) % 7 + 7) % 7;
        return offA - offB;
      });

      let eventNum = 0;
      let w = 0;
      while (eventNum < totalSessions) {
        for (const dayNum of sortedDays) {
          if (eventNum >= totalSessions) break;
          // Always-positive offset: days after baseDay in the same week cycle
          const offset = ((dayNum - baseDay) % 7 + 7) % 7;
          const d = new Date(baseDate);
          d.setDate(baseDate.getDate() + w * 7 + offset);
          eventNum++;
          rows.push({
            phone: phone || null,
            title: `${title} (${eventNum}/${totalSessions})`,
            date: d.toISOString().split('T')[0],
            start_time: start_time || null,
            end_time: end_time || null,
            notes: notes || null,
            created_by: created_by || null,
            is_trial: is_trial === true || is_trial === 'true' ? true : false,
            assigned_member: assigned_member || null,
          });
        }
        w++;
        if (w > 52) break; // safety cap
      }
    } else {
      // Single-day recurring (original logic)
      for (let i = 0; i < weeks; i++) {
        const d = new Date(date + 'T00:00:00');
        d.setDate(d.getDate() + i * 7);
        rows.push({
          phone: phone || null,
          title: weeks > 1 ? `${title} (${i + 1}/${weeks})` : title,
          date: d.toISOString().split('T')[0],
          start_time: start_time || null,
          end_time: end_time || null,
          notes: notes || null,
          created_by: created_by || null,
          is_trial: is_trial === true || is_trial === 'true' ? true : false,
          assigned_member: assigned_member || null,
        });
      }
    }
    const { data, error } = await supabase.from('calendar_events').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ events: data, count: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Update event
app.put('/calendar/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    for (const key of ['phone', 'title', 'date', 'start_time', 'end_time', 'notes', 'is_trial', 'assigned_member']) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const { data, error } = await supabase.from('calendar_events').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ event: data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Delete event
app.delete('/calendar/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('calendar_events').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// AI calendar command — natural language to actions
app.post('/calendar/ai-command', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });

    // Fetch ALL calendar events
    const { data: allEvents, error: fetchErr } = await supabase
      .from('calendar_events')
      .select('*')
      .order('date', { ascending: true });
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const cal60 = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(now); d.setDate(now.getDate() + i);
      cal60.push(`${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toISOString().split('T')[0]}`);
    }

    const eventList = (allEvents || []).map(e =>
      `ID:${e.id} | "${e.title}" | ${e.date} ${e.start_time || ''}-${e.end_time || ''} | phone:${e.phone || 'N/A'} | member:${e.assigned_member || 'unassigned'} | trial:${e.is_trial ? 'yes' : 'no'} | notes:${e.notes || ''}`
    ).join('\n');

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a calendar assistant. TODAY is ${todayStr} (${now.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}).
UPCOMING 60 DAYS:\n${cal60.join('\n')}

CURRENT CALENDAR EVENTS:\n${eventList || '(no events)'}

The user will give you a natural language command about the calendar. You must return ONLY valid JSON:
{
  "actions": [
    { "type": "delete", "id": "<event UUID>" },
    { "type": "create", "title": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM" or null, "end_time": "HH:MM" or null, "phone": "..." or null, "assigned_member": "..." or null, "notes": "..." or null, "is_trial": true/false },
    { "type": "update", "id": "<event UUID>", "fields": { "title": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "assigned_member": "...", "notes": "...", "is_trial": true/false } }
  ],
  "summary": "Short human-readable summary of what you did or the answer to the user's question"
}
Rules:
- Match event titles/names loosely (case-insensitive, partial match is fine).
- For "remove all sessions of X" → delete all events whose title contains X.
- For "move X to Y" → delete old + create new.
- For "add session for X on Sunday at 3pm" → create with the correct date from the calendar above.
- UPDATE: For "change X's time to 4pm", "assign Priya to session X", "update notes for X" → use type "update" with only the fields that changed in "fields".
  You can bulk-update: "assign Rahul to all sessions of X" → multiple update actions.
- QUERIES: For questions like "show all sessions on Thursday", "who handles X", "how many sessions does Priya have", "list all trials" → return actions: [] and put the answer in "summary". Be detailed and list relevant events with dates, times, members.
- RECURRING / REPEATING: When the user says "weekly", "every Sunday", "for a month", "for 3 months", etc., create MULTIPLE individual create actions — one for each week:
  • "for a month" or "monthly" = 4 weekly sessions
  • "for 2 months" = 8 weekly sessions
  • "for 3 months" = 12 weekly sessions
  • "for X weeks" = X sessions
  • "11 sessions" or "11 times" = 11 weekly sessions
  Each session should be exactly 7 days apart, starting from the first date. Number them in the title like "Session (1/4)", "Session (2/4)" etc.
- If the command is unclear or matches nothing, return { "actions": [], "summary": "No matching events found" }.
- NEVER invent event IDs. Only use IDs from the list above.`
        },
        { role: 'user', content: command }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });

    const parsed = JSON.parse(aiRes.data.choices[0].message.content);
    const actions = parsed.actions || [];
    let deleted = 0, created = 0, updated = 0;

    for (const action of actions) {
      if (action.type === 'delete' && action.id) {
        const { error } = await supabase.from('calendar_events').delete().eq('id', action.id);
        if (!error) deleted++;
      } else if (action.type === 'create' && action.title && action.date) {
        const { error } = await supabase.from('calendar_events').insert({
          title: action.title,
          date: action.date,
          start_time: action.start_time || null,
          end_time: action.end_time || null,
          phone: action.phone || null,
          notes: action.notes || null,
          is_trial: action.is_trial === true,
          assigned_member: action.assigned_member || null,
          created_by: 'AI Command',
        });
        if (!error) created++;
      } else if (action.type === 'update' && action.id && action.fields) {
        const allowedFields = ['title', 'date', 'start_time', 'end_time', 'phone', 'notes', 'is_trial', 'assigned_member'];
        const updateData = {};
        for (const key of allowedFields) {
          if (action.fields[key] !== undefined) updateData[key] = action.fields[key];
        }
        if (Object.keys(updateData).length > 0) {
          const { error } = await supabase.from('calendar_events').update(updateData).eq('id', action.id);
          if (!error) updated++;
        }
      }
    }

    return res.json({
      summary: parsed.summary || `Done: ${deleted} deleted, ${created} created, ${updated} updated`,
      deleted,
      created,
      updated,
      totalActions: actions.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Calendar stats — member stats, customer stats, totals
app.get('/calendar/stats', async (req, res) => {
  try {
    const { data: allEvents, error } = await supabase
      .from('calendar_events')
      .select('*')
      .order('date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    const events = allEvents || [];

    // Calculate hours per event
    const getHours = (e) => {
      if (e.start_time && e.end_time) {
        const [sh, sm] = e.start_time.split(':').map(Number);
        const [eh, em] = e.end_time.split(':').map(Number);
        return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
      }
      return 1; // default 1 hour if no times
    };

    // Member stats (assigned_member)
    const memberMap = {};
    const customerMap = {};

    for (const e of events) {
      const hours = getHours(e);
      // Member stats
      const member = e.assigned_member || 'Unassigned';
      if (!memberMap[member]) memberMap[member] = { sessions: 0, hours: 0, trials: 0 };
      memberMap[member].sessions++;
      memberMap[member].hours += hours;
      if (e.is_trial) memberMap[member].trials++;

      // Customer stats (by phone)
      const customer = e.phone || 'Unknown';
      if (!customerMap[customer]) customerMap[customer] = { sessions: 0, hours: 0, trials: 0, titles: new Set() };
      customerMap[customer].sessions++;
      customerMap[customer].hours += hours;
      if (e.is_trial) customerMap[customer].trials++;
      customerMap[customer].titles.add(e.title.replace(/\s*\(\d+\/\d+\)$/, '')); // strip numbering
    }

    // Convert Sets to arrays
    for (const k of Object.keys(customerMap)) {
      customerMap[k].titles = [...customerMap[k].titles];
    }

    const totalSessions = events.length;
    const totalHours = events.reduce((sum, e) => sum + getHours(e), 0);
    const totalTrials = events.filter(e => e.is_trial).length;

    return res.json({
      totalSessions,
      totalHours: Math.round(totalHours * 10) / 10,
      totalTrials,
      members: Object.entries(memberMap).map(([name, s]) => ({
        name,
        sessions: s.sessions,
        hours: Math.round(s.hours * 10) / 10,
        trials: s.trials,
      })).sort((a, b) => b.sessions - a.sessions),
      customers: Object.entries(customerMap).map(([phone, s]) => ({
        phone,
        sessions: s.sessions,
        hours: Math.round(s.hours * 10) / 10,
        trials: s.trials,
        titles: s.titles,
      })).sort((a, b) => b.sessions - a.sessions),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Assign member to multiple events at once (batch)
app.post('/calendar/assign-member', async (req, res) => {
  try {
    const { event_ids, assigned_member } = req.body;
    if (!event_ids || !Array.isArray(event_ids) || !assigned_member) {
      return res.status(400).json({ error: 'event_ids (array) and assigned_member required' });
    }
    const { data, error } = await supabase
      .from('calendar_events')
      .update({ assigned_member })
      .in('id', event_ids)
      .select();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ updated: data?.length || 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Member phone management ─────────────────────────────────────────────
// Requires Supabase table: members (name TEXT PRIMARY KEY, phone TEXT NOT NULL)
app.get('/members', async (req, res) => {
  try {
    const { data, error } = await supabase.from('members').select('*').order('name');
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ members: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/members', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
    const { data, error } = await supabase
      .from('members')
      .upsert({ name: name.trim(), phone: phone.trim() }, { onConflict: 'name' })
      .select();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ member: data?.[0] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.delete('/members/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { error } = await supabase.from('members').delete().eq('name', decodeURIComponent(name));
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── 15-minute session reminder to assigned member ───────────────────────
function formatTimeIST(timeStr) {
  const [h, m] = timeStr.split(':');
  const hr = parseInt(h);
  const ampm = hr >= 12 ? 'PM' : 'AM';
  return `${hr % 12 || 12}:${m} ${ampm}`;
}

async function sendMemberSessionReminders() {
  try {
    const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const todayStr = nowIST.toISOString().split('T')[0];
    const target = new Date(nowIST.getTime() + 15 * 60 * 1000);
    const targetTime = `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`;

    const { data: events, error } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('date', todayStr)
      .eq('start_time', targetTime);

    if (error) { console.error('[member-reminder] DB error', error.message); return; }
    if (!events || events.length === 0) return;

    const { data: memberRows } = await supabase.from('members').select('name, phone');
    const memberMap = Object.fromEntries((memberRows || []).map(m => [m.name.toLowerCase(), m.phone]));

    for (const ev of events) {
      if (!ev.assigned_member) continue;
      const memberPhone = memberMap[ev.assigned_member.toLowerCase()];
      if (!memberPhone) {
        console.log(`[member-reminder] No phone for member: ${ev.assigned_member}`);
        continue;
      }
      const time = ev.start_time ? formatTimeIST(ev.start_time) : 'soon';
      const customer = ev.phone ? ` (${ev.phone})` : '';
      const msg = `⏰ Reminder: You have a session starting in 15 minutes!\n\n📅 *${ev.title}*${customer}\n🕐 ${time}`;

      console.log(`[member-reminder] Sending to ${ev.assigned_member} (${memberPhone}): ${ev.title} at ${time}`);

      // Always try template first (required for members outside 24h window)
      const templateId = process.env.MEMBER_REMINDER_TEMPLATE_ID; // set this once template is approved
      let sent = false;
      if (templateId) {
        try {
          await axios.post(
            `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-message`,
            {
              name: ev.assigned_member,
              phone: memberPhone,
              templateId,
              // Pass as separate variables so template placeholders {{1}} {{2}} {{3}} map correctly
              variables: [ev.title, time, ev.notes || 'Location TBD'],
            },
            { params: { apiKey: BOTSPACE_API_KEY }, headers: { 'Content-Type': 'application/json' } }
          );
          sent = true;
          console.log(`[member-reminder] Sent via template ${templateId}`);
        } catch (tplErr) {
          console.warn('[member-reminder] Template failed:', tplErr?.response?.data?.message || tplErr.message);
        }
      }
      // Fallback: session message (only works if member messaged in last 24h)
      if (!sent) {
        try {
          await axios.post(
            `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message`,
            { name: ev.assigned_member, phone: memberPhone, text: msg },
            { params: { apiKey: BOTSPACE_API_KEY } }
          );
          sent = true;
          console.log(`[member-reminder] Sent via session message (fallback)`);
        } catch (sessErr) {
          console.warn('[member-reminder] Session message also failed (member outside 24h window):', sessErr?.response?.data?.message || sessErr.message);
        }
      }
    }
  } catch (e) {
    console.error('[member-reminder] Error:', e?.response?.data || e.message || e);
  }
}

// Cron: every minute — send WhatsApp reminder to member if their session starts in 15 mins
cron.schedule('* * * * *', () => {
  sendMemberSessionReminders();
});

// ── Daily session reminder ──────────────────────────────────────────────
const REMINDER_PHONE = process.env.REMINDER_PHONE || '919901029836';

async function sendDailyReminder() {
  try {
    // Get tomorrow's date in IST (UTC+5:30)
    const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const tomorrow = new Date(nowIST);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

    console.log(`[reminder] Checking sessions for ${tomorrowStr}`);

    const { data: events, error } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('date', tomorrowStr)
      .order('start_time', { ascending: true });

    if (error) { console.error('[reminder] DB error', error.message); return; }
    if (!events || events.length === 0) {
      console.log('[reminder] No sessions tomorrow, skipping');
      return;
    }

    // Build message
    const dayLabel = tomorrow.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    let msg = `📅 *Sessions for tomorrow (${dayLabel}):*\n\n`;

    events.forEach((ev, i) => {
      const time = ev.start_time && ev.end_time
        ? `${ev.start_time} – ${ev.end_time}`
        : ev.start_time || 'Time TBD';
      const trial = ev.is_trial ? ' 🟠 TRIAL' : '';
      const member = ev.assigned_member ? ` → ${ev.assigned_member}` : '';
      const phone = ev.phone ? ` (${ev.phone})` : '';
      msg += `${i + 1}. *${ev.title}*${trial}\n   🕐 ${time}${member}${phone}\n`;
      if (ev.notes) msg += `   📝 ${ev.notes}\n`;
      msg += '\n';
    });

    msg += `Total: ${events.length} session${events.length > 1 ? 's' : ''}`;

    console.log('[reminder] Sending to', REMINDER_PHONE, ':', msg.slice(0, 200));

    // Try template first, fall back to session message
    const useTemplate = process.env.REMINDER_TEMPLATE_ID;
    let sent = false;
    if (useTemplate) {
      try {
        await axios.post(
          `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-message`,
          { name: '', phone: REMINDER_PHONE, templateId: useTemplate, variables: [msg] },
          { params: { apiKey: BOTSPACE_API_KEY }, headers: { 'Content-Type': 'application/json' } }
        );
        console.log('[reminder] Sent via template', useTemplate);
        sent = true;
      } catch (tplErr) {
        console.warn('[reminder] Template failed, falling back to session message:', tplErr?.response?.data?.message || tplErr.message);
      }
    }
    if (!sent) {
      // Session message — only works within 24h window
      await axios.post(
        `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message`,
        { phone: REMINDER_PHONE, text: msg },
        { params: { apiKey: BOTSPACE_API_KEY } }
      );
      console.log('[reminder] Sent via session message');
    }
  } catch (e) {
    console.error('[reminder] Error:', e?.response?.data || e.message || e);
  }
}

// Cron: every day at 9 PM IST (= 3:30 PM UTC)
cron.schedule('30 15 * * *', () => {
  console.log('[cron] Triggering daily reminder (9 PM IST)');
  sendDailyReminder();
});

// Manual test endpoint
app.get('/test-reminder', async (req, res) => {
  console.log('[test-reminder] Triggered manually');
  await sendDailyReminder();
  res.json({ ok: true, message: 'Reminder sent (check WhatsApp)' });
});

// Test endpoint: send a member reminder right now for a specific member/event
// Usage: GET /test-member-reminder?member=Priya&title=KidDost+Session&time=15:30&location=Domlur
app.get('/test-member-reminder', async (req, res) => {
  const { member, title, time, location } = req.query;
  if (!member) return res.status(400).json({ error: 'member query param required' });

  const { data: memberRows } = await supabase.from('members').select('name, phone');
  const memberMap = Object.fromEntries((memberRows || []).map(m => [m.name.toLowerCase(), m.phone]));
  const memberPhone = memberMap[String(member).toLowerCase()];

  if (!memberPhone) return res.status(404).json({ error: `No phone found for member: ${member}. Add them via POST /members first.` });

  const timeStr = String(time || '??:??');
  const [h, m] = timeStr.split(':');
  const hr = parseInt(h);
  const formattedTime = !isNaN(hr) ? `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}` : timeStr;
  const msg = `⏰ Reminder: You have a session starting in 15 minutes!\n\n📅 *${title || 'KidDost Session'}*\n🕐 ${formattedTime}\n📍 ${location || 'N/A'}`;

  console.log(`[test-member-reminder] Sending to ${member} (${memberPhone})`);
  try {
    await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message`,
      { name: String(member), phone: memberPhone, text: msg },
      { params: { apiKey: BOTSPACE_API_KEY } }
    );
    res.json({ ok: true, sentTo: memberPhone, message: msg });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await loadPushSubscriptionsFromDb();
});