import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BOTSPACE_API_KEY = process.env.BOTSPACE_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/webhook", async (req, res) => {
  try {
    console.log("Full incoming body:");
    console.log(JSON.stringify(req.body, null, 2));

    // Extract message from BotSpace webhook structure
    const message =
      req.body?.payload?.payload?.text || null;

    const countryCode =
      req.body?.phone?.countryCode || null;

    const phone =
      req.body?.phone?.phone || null;

    if (!message || !countryCode || !phone) {
      console.log("Missing required fields");
      return res.status(200).json({ ok: true });
    }

    const fullPhone = `+${countryCode}${phone}`;

    console.log("Extracted message:", message);
    console.log("From:", fullPhone);

    // ---- Call OpenAI ----
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: message }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const aiReply =
      aiResponse.data.choices[0].message.content;

    console.log("AI Reply:", aiReply);

    // ---- Send reply to BotSpace ----
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
    console.log("=== BOTSPACE ERROR ===");
    console.log(
      error.response?.data || error.message
    );
    res.status(200).json({ error: true });
  }
});

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});