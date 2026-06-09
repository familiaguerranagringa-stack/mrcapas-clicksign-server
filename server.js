const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const PORT = process.env.PORT || 3000;
const BASE = "https://app.clicksign.com/api/v3";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatCPF(cpf) {
  if (!cpf) return null;
  const d = String(cpf).replace(/\D/g, "");
  return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : cpf;
}

function req(url, method, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { "Content-Type": "application/vnd.api+json", "Authorization": token,
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch(e) { resolve({ status: res.statusCode, body: raw }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function reqRetry(url, method, token, body) {
  for (let i = 1; i <= 4; i++) {
    const result = await req(url, method, token, body);
    if (result.status !== 429) return result;
    console.log("429 - aguardando " + (i * 6000) + "ms");
    await sleep(i * 6000);
  }
  return { status: 429, body: { error: "Rate limit" } };
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }

  if (request.method === "GET" && request.url === "/") {
    const htmlPath = path.join(__dirname, "index.html");
    if (fs.existsSync(htmlPath)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fs.readFileSync(htmlPath));
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "MR. CAPAS online" }));
    }
    return;
  }

  if (request.method !== "POST" || request.url !== "/enviar") {
    response.writeHead(404);
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";
  request.on("data", c => body += c);
  request.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      const token = payload.clicksign_token;
      const col = payload.colaborador;
      const doc = payload.documento;

      if (!token || !col || !doc) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "Dados incompletos" }));
        return;
      }

      console.log("--- INICIO ---");
      console.log("Nome:", col.nome);
      console.log("Email:", col.email);

      // PASSO 1 — Criar envelope
      const env = await reqRetry(BASE + "/envelopes", "POST", token, {
        data: { type: "envelopes", attributes: {
          name: "Admissao - " + col.nome + " - " + col.data,
          locale: "pt-BR", auto_close: true, remind_interval: 3, block_after_refusal: true
        }}
      });
      console.log("P1 ENV:", env.status);
      if (env.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro P1", detail: env.body })); return; }
      const envId = env.body.data.id;
      console.log("P1 ENV ID:", envId);

      // PASSO 2 — Adicionar documento
      await sleep(4000);
      const docR = await reqRetry(BASE + "/envelopes/" + envId + "/documents", "POST", token, {
        data: { type: "documents", attributes: {
          filename: doc.nome,
          content_base64: "data:application/pdf;base64," + doc.pdf_base64
        }}
      });
      console.log("P2 DOC:", docR.status);
      if (docR.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro P2", detail: docR.body })); return; }
      const docId = docR.body.data.id;
      console.log("P2 DOC ID:", docId);

      // PASSO 3 — Criar signatário
      await sleep(3000);
      const cpf = formatCPF(col.cpf);
      const sigAttr = { name: col.nome, email: col.email };
      if (cpf) sigAttr.documentation = cpf;
      const sigR = await reqRetry(BASE + "/envelopes/" + envId + "/signers", "POST", token, {
        data: { type: "signers", attributes: sigAttr }
      });
      console.log("P3 SIGNER:", sigR.status);
      if (sigR.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro P3", detail: sigR.body })); return; }
      const signerId = sigR.body.data.id;
      console.log("P3 SIGNER ID:", signerId);

      // PASSO 4A — Requisito: assinatura (agree)
      await sleep(3000);
      console.log("P4A usando docId=" + docId + " signerId=" + signerId);
      const rAgree = await reqRetry(BASE + "/envelopes/" + envId + "/requirements", "POST", token, {
        data: {
          type: "requirements",
          attributes: { action: "agree", role: "sign" },
          relationships: {
            document: { data: { type: "documents", id: docId } },
            signer: { data: { type: "signers", id: signerId } }
          }
        }
      });
      console.log("P4A REQ AGREE:", rAgree.status, JSON.stringify(rAgree.body).slice(0, 100));
      if (rAgree.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro P4A", detail: rAgree.body })); return; }

      // PASSO 4B — Requisito: rubrica
      await sleep(2000);
      const rRub = await reqRetry(BASE + "/envelopes/" + envId + "/requirements", "POST", token, {
        data: {
          type: "requirements",
          attributes: { action: "rubricate", pages: "1" },
          relationships: {
            document: { data: { type: "documents", id: docId } },
            signer: { data: { type: "signers", id: signerId } }
          }
        }
      });
      console.log("P4B REQ RUBRICATE:", rRub.status, JSON.stringify(rRub.body).slice(0, 100));
      if (rRub.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro P4B", detail: rRub.body })); return; }

      // PASSO 4C — Requisito: selfie (obrigatório no plano Plus)
      await sleep(2000);
      const rEvidence = await reqRetry(BASE + "/envelopes/" + envId + "/requirements", "POST", token, {
        data: {
          type: "requirements",
          attributes: { action: "provide_evidence", auth: "selfie" },
          relationships: {
            document: { data: { type: "documents", id: docId } },
            signer: { data: { type: "signers", id: signerId } }
          }
        }
      });
      console.log("P4C REQ EVIDENCE:", rEvidence.status, JSON.stringify(rEvidence.body).slice(0, 150));
      if (rEvidence.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro P4C", detail: rEvidence.body })); return; }

      // PASSO 5 — Ativar envelope
      await sleep(3000);
      const ativ = await reqRetry(BASE + "/envelopes/" + envId, "PATCH", token, {
        data: { type: "envelopes", id: envId, attributes: { status: "running" } }
      });
      console.log("P5 ATIV:", ativ.status, JSON.stringify(ativ.body).slice(0, 200));
      if (ativ.status !== 200) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro P5", detail: ativ.body })); return; }

      console.log("=== SUCESSO ===", envId);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        envelopeId: envId,
        link: "https://app.clicksign.com/sign/" + envId,
        status: "enviado"
      }));

    } catch(e) {
      console.log("ERRO GERAL:", e.message);
      response.writeHead(500);
      response.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => console.log("Servidor MR. CAPAS porta " + PORT));
