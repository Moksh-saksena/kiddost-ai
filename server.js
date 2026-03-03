import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/*
==============================
  HEALTH CHECK
==============================
*/
app.get("/", (req, res) => {
  res.send("Kiddost AI running 🚀");
});

/*
==============================
  BOTSPACE WEBHOOK
==============================
*/
app.post("/webhook", async (req, res) => {
  try {
    console.log("==== NEW MESSAGE ====");
    console.log(JSON.stringify(req.body, null, 2));

    // Extract message
    const message = req.body?.payload?.payload?.text;
    const countryCode = req.body?.phone?.countryCode;
    const phone = req.body?.phone?.phone;

    if (!message || !countryCode || !phone) {
      return res.status(200).send("No valid message");
    }

    const from = `${countryCode}${phone}`;

    console.log("User said:", message);
    console.log("From:", from);

    /*
    ==============================
      CALL OPENAI
    ==============================
    */
    const openaiRes = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Kiddost AI assistant. Be friendly, clear and helpful."
          },
          {
            role: "user",
            content: message
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const aiReply = openaiRes.data.choices[0].message.content;

    console.log("AI Reply:", aiReply);
    console.log("BOTSPACE KEY:", process.env.BOTSPACE_API_KEY);
    /*
    ==============================
      SEND BACK TO BOTSPACE
    ==============================
    */
    const botspaceRes = await axios.post(
      "https://public-api.bot.space/v1/channel/69a6fb50136d322a1f67dbd5/message/send-session-message",
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

    console.log("BotSpace Response:", botspaceRes.data);

    res.status(200).send("OK");
  } catch (error) {
    console.error("=== ERROR ===");
    console.error(error.response?.data || error.message);
    res.status(200).send("Handled");
  }
});

/*
==============================
  START SERVER
==============================
*/
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});