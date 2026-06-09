const http = require("http");
const PORT = process.env.PORT || 3000;
const CLICKSIGN_BASE = "https://app.clicksign.com/api/v3";

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function formatarCPF(cpf) {
  if (!cpf) return null;
  const digits = String(cpf).replace(/\D/g, "");
  if (digits.length !== 11) return cpf;
  return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

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

async function requestWithRetry(url, method, token, body) {
  const maxTentativas = 4;
  for (let i = 1; i <= maxTentativas; i++) {
    const result = await request(url, method, token, body);
    if (result.status !== 429) return result;
    const espera = i * 6000;
    console.log("RATE LIMIT 429 - aguardando " + espera + "ms (tentativa " + i + "/" + maxTentativas + ")");
    await sleep(espera);
  }
  return { status: 429, body: { error: "Rate limit após múltiplas tentativas" } };
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

      // 1. Criar envelope
      const env = await requestWithRetry(CLICKSIGN_BASE + "/envelopes", "POST", token, {
        data: { type: "envelopes", attributes: {
          name: "Admissao - " + col.nome + " - " + col.data,
          locale: "pt-BR",
          auto_close: true,
          remind_interval: 3,
          block_after_refusal: true
        }}
      });
      console.log("ENV:", env.status);
      if (env.status !== 201) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao criar envelope", detail: env.body }));
        return;
      }
      const envId = env.body.data.id;
      console.log("ENV ID:", envId);

      // 2. Adicionar documento
      await sleep(4000);
      const docR = await requestWithRetry(CLICKSIGN_BASE + "/envelopes/" + envId + "/documents", "POST", token, {
        data: { type: "documents", attributes: {
          filename: doc.nome,
          content_base64: "data:application/pdf;base64," + doc.pdf_base64
        }}
      });
      console.log("DOC:", docR.status);
      if (docR.status !== 201) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao adicionar documento", detail: docR.body }));
        return;
      }
      const docId = docR.body.data.id;
      console.log("DOC ID:", docId);

      // 3. Criar signatário com CPF
      await sleep(3000);
      const cpfFormatado = formatarCPF(col.cpf);
      const signerAttr = { name: col.nome, email: col.email };
      if (cpfFormatado) signerAttr.documentation = cpfFormatado;

      const sigR = await requestWithRetry(CLICKSIGN_BASE + "/envelopes/" + envId + "/signers", "POST", token, {
        data: { type: "signers", attributes: signerAttr }
      });
      console.log("SIGNER:", sigR.status);
      if (sigR.status !== 201) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao criar signatario", detail: sigR.body }));
        return;
      }
      const signerId = sigR.body.data.id;
      console.log("SIGNER ID:", signerId);

      // 4. Vincular signatário ao documento
      // ✅ rubric_field: false — desativa rubrica no requisito
      await sleep(3000);
      console.log("Criando requisito: doc=" + docId + " signer=" + signerId);
      const reqR = await requestWithRetry(CLICKSIGN_BASE + "/envelopes/" + envId + "/requirements", "POST", token, {
        data: {
          type: "requirements",
          attributes: { action: "agree", role: "sign", rubric_field: false },
          relationships: {
            document: { data: { type: "documents", id: docId } },
            signer: { data: { type: "signers", id: signerId } }
          }
        }
      });
      console.log("REQ:", reqR.status, JSON.stringify(reqR.body).slice(0, 300));
      if (reqR.status !== 201) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao vincular signatario", detail: reqR.body }));
        return;
      }

      // 5. Ativar envelope
      await sleep(3000);
      const ativ = await requestWithRetry(CLICKSIGN_BASE + "/envelopes/" + envId, "PATCH", token, {
        data: { type: "envelopes", id: envId, attributes: { status: "running" } }
      });
      console.log("ATIV:", ativ.status, JSON.stringify(ativ.body).slice(0, 300));
      if (ativ.status !== 200) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Erro ao ativar envelope", detail: ativ.body }));
        return;
      }

      console.log("SUCESSO:", envId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        envelopeId: envId,
        link: "https://app.clicksign.com/sign/" + envId,
        status: "enviado"
      }));

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
