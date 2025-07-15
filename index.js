const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config(); // render’da çevresel değişkenler için

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("✅ Robocombo GPT sunucusu başarıyla çalışıyor!");
});

app.post("/ask", async (req, res) => {
  const userMessage = req.body.message;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [
          { role: "system", content: "Sen Robocombo.com için müşteri destek chatbotusun." },
          { role: "user", content: userMessage }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;
    res.send(reply);
  } catch (error) {
    console.error("GPT Hatası:", error.message);
    res.status(500).send("GPT yanıtı alınamadı.");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
});
