const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config(); // render’da çevresel değişkenler için

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Ana test sayfası
app.get("/", (req, res) => {
  res.send("✅ Robocombo GPT sunucusu başarıyla çalışıyor!");
});

// GPT modellerini listele
app.get("/models", async (req, res) => {
  try {
    const response = await axios.get("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });

    const modelNames = response.data.data.map(m => m.id);
    res.send(modelNames.filter(name => name.includes("gpt")));
  } catch (error) {
    console.error("Model çekme hatası:", error.message);
    res.status(500).send("Model listesi alınamadı.");
  }
});

// GPT-4 üzerinden kullanıcı mesajı yanıtlama
app.post("/ask", async (req, res) => {
  const userMessage = req.body.message;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo", // gerekirse gpt-3.5-turbo olarak değiştir
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
