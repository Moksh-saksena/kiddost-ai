import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

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

    console.log("Extracted message:", message);
    console.log("From:", fullPhone);

    // Save user message
    await supabase.from("messages").insert({
      phone: fullPhone,
      role: "user",
      content: message
    });

    // Fetch last 10 messages for conversation memory
    const { data: history = []} = await supabase
      .from("messages")
      .select("role, content")
      .eq("phone", fullPhone)
      .order("created_at", { ascending: true })
      .limit(10);

    // OpenAI response
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

    // Save AI reply
    await supabase.from("messages").insert({
      phone: fullPhone,
      role: "assistant",
      content: aiReply
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});