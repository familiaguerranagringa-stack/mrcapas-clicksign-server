const http = require("http");
const PORT = process.env.PORT || 3000;
const CLICKSIGN_BASE = "https://app.clicksign.com/api/v3";

function request(url, method, token, body) {
  return new Promise(function(resolve, reject) {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method,
      headers: Object.assign(
        { "Content-Type": "application/vnd.api+json", "Authorization": token },
        data ? { "Content-Length": Buffer.byteLength(data) } : {}
      )
    };
    const https = require("https");
    const req = https.request(opts, function(res) {
      let raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/") {
    const fs = require("fs");
    const path = require("path");
    const htmlPath = path.join(__dirname, "index.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "MR. CAPAS ClickSign Server online" }));
    }
    return;
  }

  if (req.method !== "POST" || req.url !== "/enviar") {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";
  req.on("data", function(c) { body += c; });
  req.on("end", async function() {
    try {
      const payload = JSON.parse(body);
      const token = payload.clicksign_token;
      const col = payload.colaborador;
      const doc = payload.documento;

      if (!token || !col || !doc) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Dados incompletos" }));
        return;
      }

      console.log("INICIO:", col.nome, col.email);

      const env = await request(CLICKSIGN_BASE + "/envelopes", "POST", token, {
        data: { type: "envelopes", attributes: {
          name: "Admissao - " + col.nome + " - " + col.data,
          locale: "pt-BR", auto_close: true, remind_interval: 3, block_after_refusal: true
        }}
      });
      console.log("ENV:", env.status, JSON.stringify(env.body).slice(0,300));
      if (env.status !== 201) { res.writeHead(500); res.end(JSON.stringify({ error: "Erro ao criar envelope", detail: env.body })); return; }
      const envId = env.body.data.id;

      const docR = await request(CLICKSIGN_BASE + "/envelopes/" + envId + "/documents", "POST", token, {
        data: { type: "documents", attributes: {
          filename: doc.nome,
          content_base64: "data:application/pdf;base64," + doc.pdf_base64
        }}
      });
      console.log("DOC:", docR.status, JSON.stringify(docR.body).slice(0,300));
      if (docR.status !== 201) { res.writeHead(500); res.end(JSON.stringify({ error: "Erro ao adicionar documento", detail: docR.body })); return; }

      const sigAttrs = {
        action: "sign",
        name: col.nome,
        email: col.email,
        communicate_events: {
          document_signed: { email: { active: true }, whatsapp: { active: false } },
          envelope_finished: { email: { active: true } }
        }
      };
      const cpfClean = col.cpf ? col.cpf.replace(/[^0-9]/g, "") : "";
      if (cpfClean.length === 11) sigAttrs.cpf = cpfClean;

      const sig = await request(CLICKSIGN_BASE + "/envelopes/" + envId + "/requirements", "POST", token, {
        data: { type: "requirements", attributes: sigAttrs }
      });
      console.log("SIG:", sig.status, JSON.stringify(sig.body).slice(0,300));
      if (sig.status !== 201) { res.writeHead(500); res.end(JSON.stringify({ error: "Erro ao adicionar signatario", detail: sig.body })); return; }

      const ativ = await request(CLICKSIGN_BASE + "/envelopes/" + envId + "/activate", "PATCH", token, {
        data: { type: "envelopes", id: envId }
      });
      console.log("ATIV:", ativ.status, JSON.stringify(ativ.body).slice(0,200));
      if (ativ.status !== 200) { res.writeHead(500); res.end(JSON.stringify({ error: "Erro ao ativar envelope", detail: ativ.body })); return; }

      console.log("SUCESSO:", envId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ envelopeId: envId, link: "https://app.clicksign.com/sign/" + envId, status: "enviado" }));

    } catch(e) {
      console.log("ERRO:", e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, function() {
  console.log("Servidor MR. CAPAS rodando na porta " + PORT);
});
