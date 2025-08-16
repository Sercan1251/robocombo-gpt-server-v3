const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// === OpenRouter ayarları ===
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // Render'da ekle
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const REFERER = process.env.OPENROUTER_SITE_URL || "https://robocombo.co"; // opsiyonel
const APP_NAME = process.env.OPENROUTER_APP_NAME || "Robocombo WhatsApp Bot"; // opsiyonel

app.use(cors());
app.use(express.json());

// Ana sayfa (health check)
app.get("/", (req, res) => {
  res.send("✅ Robocombo GPT (OpenRouter) sunucusu çalışıyor!");
});

// Test sayfası (/test)
app.get("/test", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head><meta charset="UTF-8"><title>Robocombo GPT Test</title></head>
    <body>
      <h2>Robocombo GPT Test (OpenRouter)</h2>
      <form id="chat-form">
        <input type="text" id="message" placeholder="Mesajınızı yazın..." size="50" />
        <button type="submit">Gönder</button>
      </form>
      <p><strong>Yanıt:</strong> <span id="response"></span></p>
      <script>
        document.getElementById("chat-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const message = document.getElementById("message").value;
          const el = document.getElementById("response");
          el.textContent = "Gönderiliyor...";
          try {
            const r = await fetch("/ask", {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify({ message })
            });
            const text = await r.text();
            el.textContent = text;
          } catch (err) {
            el.textContent = "Hata: " + err.message;
          }
        });
      </script>
    </body>
    </html>
  `);
});

// (Opsiyonel) Modelleri listele
app.get("/models", async (req, res) => {
  try {
    const response = await axios.get(`${OPENROUTER_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": REFERER,
        "X-Title": APP_NAME
      },
      timeout: 20000
    });
    const modelNames = response.data.data.map(m => m.id);
    res.send(modelNames.filter(name => name.toLowerCase().includes("gpt")));
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    console.error("[MODELS][ERROR] status=", status, data || error?.message);
    res.status(status).send("Model listesi alınamadı.");
  }
});

// ---- /ask: OpenRouter chat completions + retry/fallback ----
app.post("/ask", async (req, res) => {
  const userMessage = (req.body && req.body.message) ? String(req.body.message) : "";
  if (!userMessage) return res.status(400).send("Mesaj boş olamaz.");

  // OpenRouter model adları
  const candidateModels = [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "openai/gpt-3.5-turbo"
  ];

  const maxAttempts = 3;
  const baseDelayMs = 800;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  let lastError = null;

  for (const model of candidateModels) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[ASK] model=${model} attempt=${attempt} msg="${userMessage}"`);

        const response = await axios.post(
          `${OPENROUTER_BASE}/chat/completions`,
          {
            model,
            messages: [
              { role: "system", content: "Sen Robocombo.com için müşteri destek chatbotusun." },
              { role: "user", content: userMessage }
            ]
          },
          {
            headers: {
              Authorization: `Bearer ${OPENROUTER_API_KEY}`,
              "HTTP-Referer": REFERER,
              "X-Title": APP_NAME,
              "Content-Type": "application/json"
            },
            timeout: 20000
          }
        );

        const reply =
          response?.data?.choices?.[0]?.message?.content ||
          response?.data?.choices?.[0]?.delta?.content;

        if (!reply) {
          console.error("[ASK] Boş yanıt yapısı:", response?.data);
          throw new Error("Boş yanıt alındı");
        }
        return res.send(reply);
      } catch (error) {
        const status = error?.response?.status || "n/a";
        const data = error?.response?.data;
        console.error(`[ASK][ERROR] model=${model} attempt=${attempt} status=${status} message=${error?.message}`);
        if (data) console.error("[ASK][ERROR][DATA]:", JSON.stringify(data));
        lastError = error;

        // 429/5xx tekrar dene; diğer hatalarda bir sonraki modele geç
        if (status === 429 || (typeof status === "number" && status >= 500 && status <= 599)) {
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

  const status = lastError?.response?.status || 500;
  const data = lastError?.response?.data;
  return res.status(status).send(
    JSON.stringify({
      error: "OpenRouter isteği başarısız",
      status,
      message: lastError?.message,
      data
    })
  );
});
// -----------------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor (OpenRouter)`);
});
