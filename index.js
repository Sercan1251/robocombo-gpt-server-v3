const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Papa = require("papaparse");
const { v4: uuidv4 } = require("uuid");
const { XMLParser } = require("fast-xml-parser");

const app = express();
const PORT = process.env.PORT || 3000;

// === OpenRouter ayarları ===
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const REFERER = process.env.OPENROUTER_SITE_URL || "https://robocombo.co";
const APP_NAME = process.env.OPENROUTER_APP_NAME || "Robocombo WhatsApp Bot";

// (Opsiyonel) basit bir koruma için cron/otomatik senk çağrılarına token
const RAG_SYNC_TOKEN = process.env.RAG_SYNC_TOKEN || ""; // Render Env'e eklersen /rag/ingest-xml çağrılarına x-rag-token header bekler

app.use(cors());
app.use(express.json());

// --------- Basit bellek içi vektör mağazası (MVP) ----------
let VECTOR_DIM = 1536; // openai/text-embedding-3-small boyutu
let productVectors = []; // { id, text, meta, vector: number[] }

// Cosine similarity
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

// Nesne içinden "a.b.c" yolu ile değer çekme
function getPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), obj);
}

// -------------- OpenRouter yardımcıları --------------
async function embedText(text) {
  const res = await axios.post(
    `${OPENROUTER_BASE}/embeddings`,
    { model: "openai/text-embedding-3-small", input: text },
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
  const vec = res?.data?.data?.[0]?.embedding;
  if (!vec || !Array.isArray(vec)) throw new Error("Embedding alınamadı");
  return vec;
}

async function chatWithContext(userMessage, contexts) {
  const contextText = contexts.map((c, i) =>
    `# Kaynak ${i+1}\nÜrün: ${c.meta?.name}\nAçıklama: ${c.meta?.description}\nFiyat: ${c.meta?.price}\nURL: ${c.meta?.url}`
  ).join("\n\n");

  const system = `Sen Robocombo.com için ürün danışmanısın.
- Önce niyeti anla, sonra maksimum 3 uygun ürün öner.
- Yanıtı kısa madde işaretleriyle yaz ve ürün URL'sini ekle.
- Sadece bağlamda olan veriyi kullan, uydurma.`;

  const res = await axios.post(
    `${OPENROUTER_BASE}/chat/completions`,
    {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Soru: ${userMessage}\n\n---\nBağlam:\n${contextText}` }
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

  const reply = res?.data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error("LLM yanıtı boş");
  return reply;
}

// -------------------- Rotalar --------------------

// Health
app.get("/", (req, res) => {
  res.send("✅ Robocombo GPT (OpenRouter + RAG XML) sunucusu çalışıyor!");
});

// Basit test formu (RAG query)
app.get("/test", (req, res) => {
  res.send(`
    <!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>RAG Test</title></head>
    <body>
      <h2>Robocombo RAG Test</h2>
      <p>Önce <code>/rag/ingest-xml</code> ile XML yükleyin, sonra soru sorun.</p>
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
    </body></html>
  `);
});

// Mevcut modeller (OpenRouter)
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
    res.send(modelNames);
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    console.error("[MODELS][ERROR] status=", status, data || error?.message);
    res.status(status).send("Model listesi alınamadı.");
  }
});

// --------- RAG: XML ingest ----------
app.post("/rag/ingest-xml", async (req, res) => {
  try {
    // Güvenlik: opsiyonel token kontrolü
    if (RAG_SYNC_TOKEN) {
      const token = req.headers["x-rag-token"];
      if (!token || token !== RAG_SYNC_TOKEN) {
        return res.status(401).send("Yetkisiz (x-rag-token eksik/yanlış).");
      }
    }

    const { xmlUrl, itemPath, mapping, append = false } = req.body || {};
    // örnek mapping (Google Merchant RSS):
    // itemPath: "rss.channel.item"
    // mapping: { id: "g:id", name: "title", description: "description", url: "link", price: "g:price", brand:"g:brand", tags:"g:product_type" }

    if (!xmlUrl || !itemPath || !mapping) {
      return res.status(400).send("xmlUrl, itemPath ve mapping alanları gereklidir.");
    }

    // XML indir
    const xml = await axios.get(xmlUrl, { responseType: "text", timeout: 60000 }).then(r => r.data);

    // XML parse
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      // XML namespace'li etiketleri (g:id, g:price) olduğu gibi bırakalım
      removeNSPrefix: false,
      allowBooleanAttributes: true
    });
    const parsed = parser.parse(xml);

    // itemPath "a.b.c" gibi; diziyi bulalım
    const items = getPath(parsed, itemPath);
    if (!items || !Array.isArray(items)) {
      return res.status(400).send(`itemPath ile ürün listesi bulunamadı: ${itemPath}`);
    }

    // Ürünleri normalize et
    const normalized = items.map((it) => {
      const id = getPath(it, mapping.id) || uuidv4();
      const name = getPath(it, mapping.name) || "";
      const description = getPath(it, mapping.description) || "";
      const url = getPath(it, mapping.url) || "";
      const priceRaw = getPath(it, mapping.price) || "";
      const brand = mapping.brand ? getPath(it, mapping.brand) : "";
      const tags = mapping.tags ? getPath(it, mapping.tags) : "";

      // Fiyatı mümkünse sadece sayı kısmını çekelim (örn "2999 TRY" -> 2999)
      const price = typeof priceRaw === "string"
        ? (priceRaw.match(/[0-9]+([.,][0-9]+)?/)?.[0] || priceRaw)
        : priceRaw;

      const text = `${name}\n${description}\nMarka:${brand}\nEtiket:${tags}\nFiyat:${price}\nURL:${url}`;
      return { id, name, description, url, price, brand, tags, text };
    }).filter(p => (p.name || p.description));

    // Embedding + belleğe koy (append=false ise sıfırla)
    if (!append) productVectors = [];

    const newVectors = [];
    for (const p of normalized) {
      try {
        const vector = await embedText(p.text);
        if (!VECTOR_DIM) VECTOR_DIM = vector.length;
        newVectors.push({
          id: p.id,
          text: p.text,
          meta: { name: p.name, description: p.description, url: p.url, price: p.price, brand: p.brand, tags: p.tags },
          vector
        });
      } catch (e) {
        console.warn("[INGEST-XML] embedding hatası (skip):", p.id, e.message);
      }
    }

    // append=true ise upsert
    if (append && productVectors.length) {
      const byId = new Map(productVectors.map(v => [v.id, v]));
      newVectors.forEach(v => byId.set(v.id, v));
      productVectors = Array.from(byId.values());
    } else {
      productVectors = newVectors;
    }

    res.send(`✅ XML indeksleme bitti. Ürün sayısı: ${productVectors.length}`);
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    console.error("[INGEST-XML][ERROR] status=", status, data || error?.message);
    res.status(status).send("XML indeksleme sırasında hata oluştu.");
  }
});

// (İstersen CSV ingest de kalsın — opsiyonel)
app.post("/rag/ingest", async (req, res) => {
  try {
    const { csvUrl } = req.body || {};
    if (!csvUrl) return res.status(400).send("csvUrl gereklidir.");
    const csv = await axios.get(csvUrl, { responseType: "text", timeout: 30000 }).then(r => r.data);
    const parsed = Papa.parse(csv, { header: true });
    const rows = parsed?.data?.filter(Boolean) || [];
    if (!rows.length) return res.status(400).send("CSV'de satır bulunamadı.");

    const toIndex = rows.map((r) => {
      const id = r.id || uuidv4();
      const name = r.name || r.title || "";
      const description = r.description || r.desc || "";
      const url = r.url || r.link || "";
      const price = r.price || r.prc || "";
      const text = `${name}\n${description}\nFiyat:${price}\nURL:${url}`;
      return { id, name, description, url, price, text };
    });

    const newVectors = [];
    for (const p of toIndex) {
      if (!p.text?.trim()) continue;
      const vector = await embedText(p.text);
      if (!VECTOR_DIM) VECTOR_DIM = vector.length;
      newVectors.push({
        id: p.id,
        text: p.text,
        meta: { name: p.name, description: p.description, url: p.url, price: p.price },
        vector
      });
    }
    productVectors = newVectors;

    res.send(`✅ İndeksleme bitti. Ürün sayısı: ${productVectors.length}`);
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    console.error("[INGEST][ERROR] status=", status, data || error?.message);
    res.status(status).send("İndeksleme sırasında hata oluştu.");
  }
});

// --------- RAG: Sorgu ----------
app.post("/rag/query", async (req, res) => {
  try {
    const { question, topK = 5 } = req.body || {};
    if (!question) return res.status(400).send("question gereklidir.");
    if (!productVectors.length) return res.status(400).send("Önce /rag/ingest-xml veya /rag/ingest ile veri yükleyin.");

    const qVec = await embedText(question);

    const scored = productVectors.map((p) => ({
      score: cosineSimilarity(qVec, p.vector),
      item: p
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(x => x.item);

    const answer = await chatWithContext(question, scored);
    res.send(answer);
  } catch (error) {
    const status = error?.response?.status || 500;
    const data = error?.response?.data;
    console.error("[RAG][ERROR] status=", status, data || error?.message);
    res.status(status).send("RAG sorgusunda hata oluştu.");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor (OpenRouter + RAG XML)`);
});
