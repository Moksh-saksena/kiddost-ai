import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/*
==============================
  HEALTH CHECK ROUTE
==============================
*/
app.get("/", (req, res) => {
  res.send("Kiddost AI is running 🚀");
});

/*
==============================
  BOTSPACE WEBHOOK
==============================
*/
app.post("/webhook", async (req, res) => {
  try {
    console.log("Full incoming body:");
    console.log(JSON.stringify(req.body, null, 2));

    // Extract message safely
    const message =
      req.body?.payload?.payload?.text || null;

    const countryCode =
      req.body?.phone?.countryCode || "";

    const phone =
      req.body?.phone?.phone || "";

    const from = `${countryCode}${phone}`;

    console.log("Extracted message:", message);
    console.log("From:", from);

    if (!message) {
      return res.status(200).send("No text message");
    }

    /*
    ==============================
      OPENAI CALL
    ==============================
    */

    const openaiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Kiddost AI assistant. Answer clearly, friendly and concise."
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

    const aiReply =
      openaiResponse.data.choices[0].message.content;

    console.log("AI Reply:", aiReply);

    /*
    ==============================
      SEND MESSAGE BACK TO BOTSPACE
    ==============================
    */

      await axios.post(
  "https://public-api.bot.space/v1/69a6fb50136d322a1f67dbd5/message/send-session-message",
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
    res.status(200).send("OK");
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.status(200).send("Error handled");
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