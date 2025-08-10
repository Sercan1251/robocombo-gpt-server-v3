const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Ana sayfa (health check)
app.get("/", (req, res) => {
  res.send("✅ Robocombo GPT sunucusu başarıyla çalışıyor!");
});

// Hızlı test sayfası (/test)
app.get("/test", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head><meta charset="UTF-8"><title>Robocombo GPT Test</title></head>
    <body>
      <h2>Robocombo GPT Test</h2>
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

// (Opsiyonel) erişimin olan GPT modellerini görmek için
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

// ---- /ask: retry + fallback + ayrıntılı hata çıktısı ----
app.post("/ask", async (req, res) => {
  const userMessage = (req.body && req.body.message) ? String(req.body.message) : "";
  if (!userMessage) {
    return res.status(400).send("Mesaj boş olamaz.");
  }

  // Erişimin olan modellerden hızlı → güçlü → geniş fallback sırası
  const candidateModels = ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"];

  const maxAttempts = 3;           // her model için deneme sayısı
  const baseDelayMs = 800;         // exponential backoff başlangıç bekleme
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
        const status = error?.response?.status || "n/a";
        const data = error?.response?.data;
        console.error(`[ASK][ERROR] model=${model} attempt=${attempt} status=${status} message=${error?.message}`);
        if (data) console.error("[ASK][ERROR][DATA]:", JSON.stringify(data));

        lastError = error;

        // 429 veya 5xx ise backoff ile tekrar dene; diğer hatalarda model değiştir
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

  // Geçici debug: istemciye ayrıntılı hata dön (canlıda sadeleştiririz)
  const status = lastError?.response?.status || 500;
  const data = lastError?.response?.data;
  return res.status(status).send(
    JSON.stringify({
      error: "OpenAI isteği başarısız",
      status,
      message: lastError?.message,
      data
    })
  );
});
// ---------------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
});
