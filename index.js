const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { XMLParser } = require("fast-xml-parser");

const app = express();
const PORT = process.env.PORT || 3000;

// === OpenRouter ayarları ===
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const REFERER = process.env.OPENROUTER_SITE_URL || "https://robocombo.co";
const APP_NAME = process.env.OPENROUTER_APP_NAME || "Robocombo WhatsApp Bot";

// (Opsiyonel) cron/otomatik senk için basit koruma
const RAG_SYNC_TOKEN = process.env.RAG_SYNC_TOKEN || "";

app.use(cors());
app.use(express.json());

if (!OPENROUTER_API_KEY) {
  console.warn("⚠️  OPENROUTER_API_KEY tanımlı değil. Render > Environment'ta ekleyin.");
}

// --------- Bellek içi vektör mağazası (MVP) ----------
let VECTOR_DIM = 1536; // openai/text-embedding-3-small
let productVectors = []; // { id, text, meta, vector: number[] }

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), obj);
}

// -------- OpenRouter helpers --------
async function embedMany(texts) {
  // texts: string[]
  const res = await axios.post(
    `${OPENROUTER_BASE}/embeddings`,
    { model: "openai/text-embedding-3-small", input: texts },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": REFERER,
        "X-Title": APP_NAME,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );
  const arr = res?.data?.data;
  if (!Array.isArray(arr)) throw new Error("Embedding yanıtı beklenen formatta değil");
  return arr.map((x) => x.embedding);
}

async function chatWithContext(userMessage, contexts) {
  const contextText = contexts.map((c, i) =>
    `# Kaynak ${i + 1}
Ürün: ${c.meta?.name}
Açıklama: ${c.meta?.description}
Fiyat: ${c.meta?.price}
URL: ${c.meta?.url}`
  ).join("\n\n");

  const system = `Sen Robocombo.com için ürün danışmanısın.
- Önce niyeti anla, sonra en fazla 3 uygun ürün öner.
- Yanıtı kısa madde işaretleri ile yaz ve ürün URL’sini ekle.
- Sadece verilen bağlamdaki veriyi kullan, uydurma.`;

  const res = await axios.post(
    `${OPENROUTER_BASE}/chat/completions`,
    {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Soru: ${userMessage}\n\n---\nBağlam:\n${contextText}` },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": REFERER,
        "X-Title": APP_NAME,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  const reply = res?.data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error("LLM yanıtı boş");
  return reply;
}

// -------------------- Rotalar --------------------
app.get("/", (req, res) => {
  res.send("✅ Robocombo GPT (OpenRouter + RAG XML, batched) sunucusu çalışıyor!");
});

app.get("/test", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>RAG Test</title></head>
  <body>
    <h2>Robocombo RAG Test</h2>
    <p>Önce <code>/rag/ingest-xml</code> ile XML yükleyin (limit=50 ile başlayın), sonra soru sorun.</p>
    <form id="chat-form">
      <input type="text" id="message" placeholder="Örn: 3000 TL altı drone öner" size="50" />
      <button type="submit">Gönder</button>
    </form>
    <pre id="response"></pre>
    <script>
      document.getElementById("chat-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const message = document.getElementById("message").value;
        const el = document.getElementById("response");
        el.textContent = "Gönderiliyor...";
        try {
          const r = await fetch("/rag/query", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ question: message })
          });
          const text = await r.text();
          el.textContent = text;
        } catch (err) {
          el.textContent = "Hata: " + err.message;
        }
      });
    </script>
  </body></html>`);
});

app.get("/models", async (req, res) => {
  try {
    const response = await axios.get(`${OPENROUTER_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": REFERER,
        "X-Title": APP_NAME,
      },
      timeout: 20000,
    });
    const modelNames = response.data.data.map((m) => m.id);
    res.send(modelNames);
  } catch (error) {
    const status = error?.response?.status || 500;
    res.status(status).send("Model listesi alınamadı.");
  }
});

// --------- RAG: XML ingest (batched & limit) ----------
app.post("/rag/ingest-xml", async (req, res) => {
  try {
    if (RAG_SYNC_TOKEN) {
      const token = req.headers["x-rag-token"];
      if (!token || token !== RAG_SYNC_TOKEN) {
        return res.status(401).send("Yetkisiz (x-rag-token eksik/yanlış).");
      }
    }

    const {
      xmlUrl,
      itemPath,
      mapping,
      append = false,
      limit = 50,         // ilk deneme için 50 önerilir
      batchSize = 32      // embedding toplu boyutu
    } = req.body || {};

    if (!xmlUrl || !itemPath || !mapping) {
      return res.status(400).send("xmlUrl, itemPath ve mapping alanları gereklidir.");
    }

    const xml = await axios.get(xmlUrl, { responseType: "text", timeout: 60000 }).then((r) => r.data);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: false,
      allowBooleanAttributes: true,
      cdataPropName: "__cdata", // CDATA içeriğini yakalayalım (görünürlük için)
      preserveOrder: false
    });
    const parsed = parser.parse(xml);

    let items = getPath(parsed, itemPath);

    // Tekil ürün durumunda diziye çevir
    if (items && !Array.isArray(items)) items = [items];

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).send(`itemPath ile ürün listesi bulunamadı: ${itemPath}`);
    }

    // Limit uygula
    const limited = items.slice(0, Math.max(1, Number(limit) || 50));

    // Normalize
    const normalized = limited.map((it) => {
      const pick = (p) => {
        const v = getPath(it, p);
        if (v && typeof v === "object" && "__cdata" in v) return v.__cdata; // CDATA
        return v;
      };

      const id = pick(mapping.id) || uuidv4();
      const name = pick(mapping.name) || "";
      const description = pick(mapping.description) || "";
      const url = mapping.url ? pick(mapping.url) : "";
      const priceRaw = mapping.price ? pick(mapping.price) : "";
      const brand = mapping.brand ? pick(mapping.brand) : "";
      const tags = mapping.tags ? pick(mapping.tags) : "";

      const price = typeof priceRaw === "string"
        ? (priceRaw.match(/[0-9]+([.,][0-9]+)?/)?.[0] || priceRaw)
        : priceRaw;

      const text = `${name}\n${description}\nMarka:${brand}\nEtiket:${tags}\nFiyat:${price}\nURL:${url}`;
      return { id, name, description, url, price, brand, tags, text };
    }).filter(p => (p.name || p.description));

    if (!append) productVectors = [];

    // ---- Embedding batched ----
    const newVectors = [];
    for (let i = 0; i < normalized.length; i += batchSize) {
      const chunk = normalized.slice(i, i + batchSize);
      try {
        const embeddings = await embedMany(chunk.map((p) => p.text));
        embeddings.forEach((vec, idx) => {
          if (!VECTOR_DIM) VECTOR_DIM = vec.length;
          const p = chunk[idx];
          newVectors.push({
            id: p.id,
            text: p.text,
            vector: vec,
            meta: {
              name: p.name,
              description: p.description,
              url: p.url,
              price: p.price,
              brand: p.brand,
              tags: p.tags,
            },
          });
        });
      } catch (e) {
        console.warn("[INGEST-XML] embedding batch hatası (skip):", e.message);
      }
    }

    if (append && productVectors.length) {
      const byId = new Map(productVectors.map((v) => [v.id, v]));
      newVectors.forEach((v) => byId.set(v.id, v));
      productVectors = Array.from(byId.values());
    } else {
      productVectors = newVectors;
    }

    res.send(`✅ XML indeksleme bitti. (işlenen: ${normalized.length})  Toplam ürün: ${productVectors.length}`);
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error("[INGEST-XML][ERROR]", status, error?.message);
    res.status(status).send("XML indeksleme sırasında hata oluştu.");
  }
});

// --------- RAG: Sorgu ----------
app.post("/rag/query", async (req, res) => {
  try {
    const { question, topK = 5 } = req.body || {};
    if (!question) return res.status(400).send("question gereklidir.");
    if (!productVectors.length) return res.status(400).send("Önce /rag/ingest-xml ile veri yükleyin.");

    // Sorguyu embed et (tek sefer)
    const [qVec] = await embedMany([question]);

    // En benzer topK ürünü bul
    const scored = productVectors.map((p) => ({
      score: cosineSimilarity(qVec, p.vector),
      item: p,
    }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.item);

    const answer = await chatWithContext(question, scored);
    res.send(answer);
  } catch (error) {
    const status = error?.response?.status || 500;
    console.error("[RAG][ERROR]", status, error?.message);
    res.status(status).send("RAG sorgusunda hata oluştu.");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor (OpenRouter + RAG XML batched)`);
});
