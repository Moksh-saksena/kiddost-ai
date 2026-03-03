import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* HEALTH CHECK */
app.get("/", (req, res) => {
  res.send("Kiddost AI is running 🚀");
});

/* WEBHOOK */
app.post("/webhook", async (req, res) => {
  try {
    console.log("==== NEW MESSAGE ====");
    console.log("BotSpace Key Length:", process.env.BOTSPACE_API_KEY?.length);

    console.log("Full incoming body:");
    console.log(JSON.stringify(req.body, null, 2));

    const message = req.body?.payload?.payload?.text;
    const countryCode = req.body?.phone?.countryCode;
    const phone = req.body?.phone?.phone;

    const from = `${countryCode}${phone}`;

    console.log("Extracted message:", message);
    console.log("From:", from);

    if (!message) {
      return res.status(200).send("No text message");
    }

    /* OPENAI */
    const openaiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Kiddost AI assistant. Be friendly, clear and concise."
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

    const aiReply = openaiResponse.data.choices[0].message.content;

    console.log("AI Reply:", aiReply);

    /* SEND BACK TO BOTSPACE */
    const botspaceResponse = await axios.post(
      "https://public-api.bot.space/v1/channel/69a01f1323c371226c2c3cea/message/send-session-message",
      {
        phone: from,
        message: {
          type: "text",
          text: aiReply
        }
      },
      {
        headers: {
          "x-api-key": process.env.BOTSPACE_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("BotSpace Response:", botspaceResponse.data);

    res.status(200).send("OK");
  } catch (error) {
    console.error("=== BOTSPACE ERROR ===");
    console.error(error.response?.data || error.message);
    res.status(200).send("Error handled");
  }
});

/* START SERVER */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});