import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
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

// Health check
app.get("/", (req, res) => {
  res.send("Kiddost AI running 🚀");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("Full incoming body:");
    console.log(JSON.stringify(req.body, null, 2));

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
    const { data: last } = await supabase
      .from("messages")
      .select("*")
      .eq("phone", fullPhone)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (last && last.ai_enabled === false) {
      console.log("AI disabled for this conversation");
      return res.status(200).json({ success: true, ai_skipped: true });
    }

    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a friendly WhatsApp assistant for Kiddost. Help parents understand programs, classes, and enrollment."
          },
          ...history
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const aiReply = aiResponse.data.choices[0].message.content;

    console.log("AI Reply:", aiReply);

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

    console.log("Message sent successfully");

    res.status(200).json({ success: true });

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

    // Save message to database
    // record agent name if provided (default to Daksh)
    const agentName = req.body.agent || "Daksh";

    await supabase.from("messages").insert({
      phone: phone,
      role: "assistant",
      content: message,
      sender: "agent",
      agent: agentName,
      ai_enabled: false
    });

    // Also update conversations table flag for compatibility
    await supabase
      .from("conversations")
      .update({ ai_paused: true })
      .eq("phone", phone);

    // Send WhatsApp message through BotSpace
    await axios.post(
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

    res.json({ success: true });

  } catch (err) {

    console.log("Agent send error:", err.response?.data || err.message);

    res.status(500).json({
      error: true
    });

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