import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

/* Health Check */
app.get("/", (req, res) => {
  res.send("Server is running");
});

/* Webhook */
app.post("/webhook", async (req, res) => {
  try {
    console.log("==== NEW WEBHOOK HIT ====");
    console.log(JSON.stringify(req.body, null, 2));

    const message = req.body?.payload?.payload?.text;
    const countryCode = req.body?.phone?.countryCode;
    const phone = req.body?.phone?.phone;

    if (!message || !countryCode || !phone) {
      console.log("Missing required data");
      return res.status(200).send("OK");
    }

    const fullNumber = `${countryCode}${phone}`;

    console.log("User said:", message);
    console.log("From:", fullNumber);

    /* 🧠 Call OpenAI */
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are the KidDost AI assistant. Be friendly, helpful, and clear. Help parents understand programs and answer questions."
          },
          { role: "user", content: message }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply =
      aiResponse.data.choices[0].message.content;

    console.log("AI Reply:", reply);

    /* 📤 Send reply via BotSpace API */
    await axios.post(
      "https://api.bot.space/messages",
      {
        to: fullNumber,
        type: "text",
        text: reply
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.BOTSPACE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Reply sent successfully");

    res.status(200).send("OK");
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.status(500).send("Error");
  }
});

/* Start Server */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});