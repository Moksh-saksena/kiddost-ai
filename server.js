import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const CHANNEL_ID = "69a6fb50136d322a1f67dbd5"; // your WhatsApp channel ID
const BOTSPACE_API_KEY = process.env.BOTSPACE_API_KEY;

// Health route (so Render doesn't show Cannot GET /)
app.get("/", (req, res) => {
  res.send("Server running");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("Full incoming body:");
    console.log(JSON.stringify(req.body, null, 2));

    const message =
      req.body?.payload?.payload?.text || "";

    const countryCode = req.body?.phone?.countryCode || "";
    const phone = req.body?.phone?.phone || "";
    const from = `${countryCode}${phone}`;

    console.log("Extracted message:", message);
    console.log("From:", from);

    if (!message) {
      return res.sendStatus(200);
    }

    // Simple AI reply (replace with OpenAI later)
    const aiReply = `Hello! How can I assist you today?`;

    console.log("AI Reply:", aiReply);

    await axios.get(
      "https://public-api.bot.space/v1/contact",
      {
        headers: {
          Authorization: `Bearer ${BOTSPACE_API_KEY}`
        }
      }
    );

    console.log("Message sent successfully");

    res.sendStatus(200);
  } catch (error) {
    console.log("=== BOTSPACE ERROR ===");
    console.log(error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});