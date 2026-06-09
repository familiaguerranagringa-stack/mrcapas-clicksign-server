const http = require("http");

const PORT = process.env.PORT || 3000;
const CLICKSIGN_BASE = "https://app.clicksign.com/api/v3";

function request(url, method, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        "Content-Type": "application/vnd.api+json",
        Authorization: token,
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const https = require("https");
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "MR. CAPAS ClickSign Server online" }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/enviar") {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      const { clicksign_token, colaborador, documento } = payload;

      if (!clicksign_token || !colaborador || !documento) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Dados incompletos" }));
        return;
      }

      // 1. Criar envelope
      const env = await request(`${CLICKSIGN_BASE}/envelopes`, "POST", clicksign_token, {
        data: {
          type: "envelopes",
          attributes: {
            name: `Admissão – ${colaborador.nome} – ${colaborador.data}`,
            locale: "pt-BR",
            auto_close: true,
            remind_interval: 3,
            block_after_refusal: true,
          },
        },
      });

      if (env.status !== 201) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao criar envelope", detail: env.body }));
        return;
      }

      const envelopeId = env.body.data.id;

      // 2. Adicionar documento
      const doc = await request(`${CLICKSIGN_BASE}/envelopes/${envelopeId}/documents`, "POST", clicksign_token, {
        data: {
          type: "documents",
          attributes: {
            filename: documento.nome,
            content_base64: `data:application/pdf;base64,${documento.pdf_base64}`,
          },
        },
      });

      if (doc.status !== 201) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao adicionar documento", detail: doc.body }));
        return;
      }

      // 3. Adicionar signatário
      const sig = await request(`${CLICKSIGN_BASE}/envelopes/${envelopeId}/requirements`, "POST", clicksign_token, {
        data: {
          type: "requirements",
          attributes: {
            action: "sign",
            role: "sign",
            name: colaborador.nome,
            email: colaborador.email,
            cpf: colaborador.cpf,
            communicate_events: {
              document_signed: { email: { active: true }, whatsapp: { active: false } },
              envelope_finished: { email: { active: true } },
            },
          },
        },
      });

      if (sig.status !== 201) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao adicionar signatário", detail: sig.body }));
        return;
      }

      // 4. Ativar envelope
      const ativ = await request(`${CLICKSIGN_BASE}/envelopes/${envelopeId}/activate`, "PATCH", clicksign_token, {
        data: { type: "envelopes", id: envelopeId },
      });

      if (ativ.status !== 200) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao ativar envelope", detail: ativ.body }));
        return;
      }

      // Sucesso
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        envelopeId,
        link: `https://app.clicksign.com/sign/${envelopeId}`,
        status: "enviado",
      }));

    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor MR. CAPAS rodando na porta ${PORT}`);
});
