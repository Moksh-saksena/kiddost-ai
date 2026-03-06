import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
dotenv.config();

const app = express();
app.use(express.json());
// Restrict CORS to the Vercel frontend origin
app.use(cors({
  origin: "https://kiddost-ai.vercel.app",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
const PORT = process.env.PORT || 10000;

// Keys
const BOTSPACE_API_KEY = process.env.BOTSPACE_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Service-role client for server-side uploads (requires SUPABASE_SERVICE_ROLE_KEY env)
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseService = null;
if (SUPABASE_SERVICE_ROLE_KEY) {
  supabaseService = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// In-memory buffering to combine fragmented user messages per phone
const messageBuffers = {};
const messageTimers = {};

// Helper: generate AI response for a combined user message
async function handleAIResponse(fullPhone, combinedMessage) {
  try {
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

    // Ensure the AI sees the combined version of the recent user input
    const messagesForAI = [
      {
        role: "system",
        content:
          "You are a friendly WhatsApp assistant for Kiddost. Help parents understand programs, classes, and enrollment."
      },
      ...history,
      { role: "user", content: combinedMessage }
    ];

    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: messagesForAI
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const aiReply = aiResponse.data.choices[0].message.content;
    console.log("AI Reply (buffered):", aiReply);

    // Save AI reply (AI agent = null, ai_enabled = true)
    await supabase.from("messages").insert({
      phone: fullPhone,
      role: "assistant",
      content: aiReply,
      sender: "ai",
      agent: null,
      ai_enabled: true
    });

    // Send message back via BotSpace
    await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message`,
      {
        name: "User",
        phone: fullPhone,
        text: aiReply
      },
      {
        params: {
          apiKey: BOTSPACE_API_KEY
        },
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Buffered message sent successfully");
  } catch (err) {
    console.error("handleAIResponse error", err.response?.data || err.message || err);
  }
}

// Health check
app.get("/", (req, res) => {
  res.send("Kiddost AI running 🚀");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("Full incoming body:");
    console.log(JSON.stringify(req.body, null, 2));

    // Handle delivery / status webhooks from BotSpace / WhatsApp
    if (req.body?.event === "message-status" || req.body?.event === "message-delivered") {
      const messageId = req.body?.messageId || req.body?.message_id || req.body?.payload?.messageId;
      const status = req.body?.status || req.body?.payload?.status || req.body?.delivery_status;
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

    const message = req.body?.payload?.payload?.text;
    const countryCode = req.body?.phone?.countryCode;
    const phone = req.body?.phone?.phone;

    if (!message || !countryCode || !phone) {
      console.log("Missing required fields");
      return res.status(200).json({ ok: true });
    }

    const fullPhone = `+${countryCode}${phone}`;
    const { data: existingConversation } = await supabase
      .from("conversations")
      .select("phone")
      .eq("phone", fullPhone)
      .maybeSingle();

    if (!existingConversation) {
      await supabase.from("conversations").insert({
        phone: fullPhone
      });
    }
    console.log("Extracted message:", message);
    console.log("From:", fullPhone);

    // Determine previous AI state for this conversation
    let lastBefore = null;
    try {
      const { data: lb, error: lbErr } = await supabase
        .from("messages")
        .select("*")
        .eq("phone", fullPhone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lbErr) lastBefore = lb;
    } catch (e) {
      lastBefore = null;
    }

    const aiEnabledForInsert = lastBefore && typeof lastBefore.ai_enabled !== 'undefined' ? lastBefore.ai_enabled : true;

    // Save user message (preserve ai_enabled if conversation previously disabled)
    await supabase.from("messages").insert({
      phone: fullPhone,
      role: "user",
      content: message,
      sender: "user",
      ai_enabled: aiEnabledForInsert
    });

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
    // OpenAI response
    // Before generating AI response, check most recent message's ai_enabled flag
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

    // Buffer this message for a short delay so fragmented messages are combined
    // into a single prompt for the AI. This helps avoid message fragmentation.
    if (!messageBuffers[fullPhone]) messageBuffers[fullPhone] = [];
    messageBuffers[fullPhone].push(message);

    // clear previous timer if any
    if (messageTimers[fullPhone]) {
      clearTimeout(messageTimers[fullPhone]);
    }

    // wait 10 seconds (user requested 10s buffer) before sending combined text to AI
    messageTimers[fullPhone] = setTimeout(async () => {
      const combined = (messageBuffers[fullPhone] || []).join(" ").trim();
      // reset buffer
      messageBuffers[fullPhone] = [];
      try {
        if (combined) {
          await handleAIResponse(fullPhone, combined);
        }
      } catch (e) {
        console.error('buffered AI handler error', e?.message || e);
      }
    }, 10000);

    // respond quickly to webhook sender
    return res.status(200).json({ success: true, buffered: true });

  } catch (error) {
    console.log("=== ERROR ===");
    console.log(error.response?.data || error.message);
    res.status(200).json({ error: true });
  }
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
    const whatsappId = botResp?.data?.messageId || botResp?.data?.id || botResp?.data?.message_id || null;
    const status = botResp?.data?.status || "sent";

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
        .update({ ai_paused: true })
        .eq("phone", phone);
    } catch (dbErr) {
      console.error("Failed to insert agent message into supabase", dbErr?.message || dbErr);
    }

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
  const { phone, mediaUrl, caption } = req.body

  console.log("/agent-send-media body:", req.body)

  try {

    const response = await axios.post(
      `https://public-api.bot.space/v1/${CHANNEL_ID}/message/send-session-message?apiKey=${BOTSPACE_API_KEY}`,
      {
        phone: phone,
        name: "Agent",
        text: caption || ' ',
        payload: {
          type: "image",
          payload: {
            url: mediaUrl,
            caption: caption || ""
          }
        }
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    )

    await supabase.from("messages").insert({
      phone: phone,
      sender: "agent",
      text: caption || "",
      media_url: mediaUrl
    })

    res.json({ success: true })

  } catch (err) {

    console.error("BotSpace media error:", err.response?.data || err)

    res.status(500).json({ error: "Media send failed" })

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
    const { fileBase64, fileName, phone } = req.body;
    if (!fileBase64 || !fileName || !phone) return res.status(400).json({ error: 'missing_params' });

    const safeName = String(fileName).replace(/[^a-zA-Z0-9.\-_\.]/g, '_');
    const path = `${phone}/${Date.now()}_${safeName}`;

    const buffer = Buffer.from(fileBase64, 'base64');

    const { error: uploadError } = await supabaseService.storage.from('media').upload(path, buffer, { cacheControl: '3600', upsert: false });
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

    await supabase.from('messages').insert({
      phone,
      sender: 'system',
      role: 'system',
      content: ai_enabled ? 'Resume AI' : 'Stop AI',
      ai_enabled: !!ai_enabled,
      agent: null
    });

    // Also update conversations table flag for compatibility
    await supabase.from('conversations').upsert({ phone, ai_paused: !ai_enabled });

    res.json({ success: true });
  } catch (err) {
    console.error('toggle-ai error', err.message || err);
    res.status(500).json({ error: true });
  }
});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});