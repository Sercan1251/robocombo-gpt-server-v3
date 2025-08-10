const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Ana test sayfası
app.get("/", (req, res) => {
  res.send("✅ Robocombo GPT sunucusu başarıyla çalışıyor!");
});

// (Opsiyonel) Modelleri listele
app.get("/models", async (req, res) => {
  try {
    const response = await axios.get("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    const modelNames = response.data.data.map(m => m.id);
    res.send(modelNames.filter(name => name.includes("gpt")));
  } catch (error) {
    console.error("Model çekme hatası:", error.message);
    res.status(500).send("Model listesi alınamadı.");
  }
});

// ---- /ask (tamamen değiştirilmiş sürüm) ----
app.post("/ask", async (req, res) => {
  const userMessage = (req.body && req.body.message) ? String(req.body.message) : "";
  if (!userMessage) {
    return res.status(400).send("Mesaj boş olamaz.");
  }

  // Önce hızlı/ucuz model, sonra daha güçlü, sonra 3.5 fallback
  const candidateModels = ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"];

  const maxAttempts = 3;       // her model için kaç tekrar
  const baseDelayMs = 800;     // backoff başlangıç bekleme
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  let lastError = null;

  for (const model of candidateModels) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[ASK] model=${model} attempt=${attempt} msg="${userMessage}"`);

        const response = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model,
            messages: [
              { role: "system", content: "Sen Robocombo.com için müşteri destek chatbotusun." },
              { role: "user", content: userMessage }
            ]
          },
          {
            headers: {
              "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            },
            timeout: 20000
          }
        );

        const reply = response?.data?.choices?.[0]?.message?.content;
        if (!reply) {
          console.error("[ASK] Boş yanıt yapısı:", response?.data);
          throw new Error("Boş yanıt alındı");
        }
        return res.send(reply);
      } catch (error) {
        const status = error?.response?.status;
        const data = error?.response?.data;
        console.error(`[ASK][ERROR] model=${model} attempt=${attempt} status=${status || "n/a"}`);
        if (data) console.error("[ASK][ERROR][DATA]:", JSON.stringify(data));
        lastError = error;

        // 429/5xx ise backoff ile tekrar dene; diğerlerinde bir sonraki modele geç
        if (status === 429 || (status >= 500 && status <= 599)) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          console.warn(`[ASK] Rate limit/5xx - ${delay}ms bekleniyor ve tekrar denenecek...`);
          await wait(delay);
          continue;
        } else {
          console.warn(`[ASK] Model "${model}" ile hata. Sonraki modele geçiliyor.`);
          break;
        }
      }
    }
  }

  console.error("[ASK] Tüm denemeler başarısız. Son hata:", lastError?.message);
  return res.status(500).send("GPT yanıtı alınamadı.");
});
// --------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
});
