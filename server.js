import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  try {
    const { message, from } = req.body;

    if (!message) return res.sendStatus(200);

    console.log("Incoming message:", message);
    console.log("Full body:", req.body);
    // Call OpenAI
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are KidDost AI assistant. Be helpful, friendly and clear." },
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

    const reply = aiResponse.data.choices[0].message.content;

    // Send reply back using TextMeBot
    await axios.get(
      `http://api.textmebot.com/send.php?recipient=${from}&apikey=${process.env.TEXTMEBOT_KEY}&text=${encodeURIComponent(reply)}`
    );

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));