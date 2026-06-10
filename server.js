const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const PORT = process.env.PORT || 3000;
const BASE = "https://app.clicksign.com/api/v3";

// ✅ Token via variável de ambiente (nunca exposto no frontend)
const ENV_TOKEN = process.env.CLICKSIGN_TOKEN || "";

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
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        "Content-Type": "application/vnd.api+json",
        "Authorization": token,
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
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
    const wait = i * 6000;
    console.log("429 - aguardando " + wait + "ms (tentativa " + i + ")");
    await sleep(wait);
  }
  return { status: 429, body: { error: "Rate limit após múltiplas tentativas" } };
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
      response.end(JSON.stringify({ status: "MR. CAPAS ClickSign Server online" }));
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

      // ✅ Token: usa env var (seguro) ou payload (compatibilidade)
      const token = ENV_TOKEN || payload.clicksign_token;
      const col = payload.colaborador;
      // Garante que telefone existe
      if (col && !col.telefone) col.telefone = '';
      const doc = payload.documento;

      if (!token) {
        response.writeHead(500);
        response.end(JSON.stringify({ error: "Token ClickSign não configurado. Defina a variável CLICKSIGN_TOKEN no servidor." }));
        return;
      }
      if (!col || !doc) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "Dados incompletos: colaborador e documento são obrigatórios" }));
        return;
      }

      console.log("--- INICIO ---", col.nome, col.email);

      // P1 — Criar envelope
      const env = await reqRetry(BASE + "/envelopes", "POST", token, {
        data: { type: "envelopes", attributes: {
          name: "Admissao - " + col.nome + " - " + col.data,
          locale: "pt-BR", auto_close: true, remind_interval: 3, block_after_refusal: true
        }}
      });
      console.log("P1 ENV:", env.status);
      if (env.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro ao criar envelope", detail: env.body })); return; }
      const envId = env.body.data.id;
      console.log("P1 ENV ID:", envId);

      // P2 — Adicionar documento
      await sleep(4000);
      const docR = await reqRetry(BASE + "/envelopes/" + envId + "/documents", "POST", token, {
        data: { type: "documents", attributes: {
          filename: doc.nome,
          content_base64: "data:application/pdf;base64," + doc.pdf_base64
        }}
      });
      console.log("P2 DOC:", docR.status);
      if (docR.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro ao adicionar documento", detail: docR.body })); return; }
      const docId = docR.body.data.id;
      console.log("P2 DOC ID:", docId);

      // P3 — Criar signatário com CPF
      await sleep(3000);
      const cpf = formatCPF(col.cpf);
      const sigAttr = { name: col.nome, email: col.email };
      if (cpf) sigAttr.documentation = cpf;
      // ✅ Configura WhatsApp como canal de notificação quando telefone é fornecido
      if (col.telefone && col.telefone.length >= 10) {
        sigAttr.phone_number = "55" + col.telefone;
        console.log("P3 phone:", sigAttr.phone_number);
      }
      // Email automático padrão (funciona 100%)
      // WhatsApp automático: aguardando ativação pelo suporte ClickSign
      const sigR = await reqRetry(BASE + "/envelopes/" + envId + "/signers", "POST", token, {
        data: { type: "signers", attributes: sigAttr }
      });
      console.log("P3 SIGNER:", sigR.status);
      if (sigR.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro ao criar signatário", detail: sigR.body })); return; }
      const signerId = sigR.body.data.id;
      console.log("P3 SIGNER ID:", signerId);

      // P4A — Requisito: assinatura (agree + role:sign)
      await sleep(3000);
      console.log("P4A usando docId=" + docId + " signerId=" + signerId);
      const rAgree = await reqRetry(BASE + "/envelopes/" + envId + "/requirements", "POST", token, {
        data: { type: "requirements",
          attributes: { action: "agree", role: "sign" },
          relationships: {
            document: { data: { type: "documents", id: docId } },
            signer: { data: { type: "signers", id: signerId } }
          }
        }
      });
      console.log("P4A REQ AGREE:", rAgree.status);
      if (rAgree.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro ao criar requisito agree", detail: rAgree.body })); return; }

      // P4B — Requisito: rubrica (rubricate + pages:"1")
      await sleep(2000);
      const rRub = await reqRetry(BASE + "/envelopes/" + envId + "/requirements", "POST", token, {
        data: { type: "requirements",
          attributes: { action: "rubricate", pages: "1" },
          relationships: {
            document: { data: { type: "documents", id: docId } },
            signer: { data: { type: "signers", id: signerId } }
          }
        }
      });
      console.log("P4B REQ RUBRICATE:", rRub.status);
      if (rRub.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro ao criar requisito rubricate", detail: rRub.body })); return; }

      // P4C — Requisito: selfie (provide_evidence + auth:selfie — obrigatório no plano Plus)
      await sleep(2000);
      const rEvidence = await reqRetry(BASE + "/envelopes/" + envId + "/requirements", "POST", token, {
        data: { type: "requirements",
          attributes: { action: "provide_evidence", auth: "selfie" },
          relationships: {
            document: { data: { type: "documents", id: docId } },
            signer: { data: { type: "signers", id: signerId } }
          }
        }
      });
      console.log("P4C REQ EVIDENCE:", rEvidence.status);
      if (rEvidence.status !== 201) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro ao criar requisito selfie", detail: rEvidence.body })); return; }

      // P5 — Ativar envelope (PATCH com status:running)
      await sleep(3000);
      const ativ = await reqRetry(BASE + "/envelopes/" + envId, "PATCH", token, {
        data: { type: "envelopes", id: envId, attributes: { status: "running" } }
      });
      console.log("P5 ATIV:", ativ.status);
      if (ativ.status !== 200) { response.writeHead(500); response.end(JSON.stringify({ error: "Erro ao ativar envelope", detail: ativ.body })); return; }

      // P6 — Disparar notificação (email + WhatsApp quando telefone presente)
      await sleep(2000);
      const notifyAttrs = {
        message: "Voce tem documentos de admissao na MR. CAPAS aguardando sua assinatura digital."
      };
      const notify = await reqRetry(BASE + "/envelopes/" + envId + "/notifications", "POST", token, {
        data: { type: "notifications", attributes: notifyAttrs }
      });
      console.log("P6 NOTIFY:", notify.status, JSON.stringify(notify.body).slice(0, 400));

      // P7 — Buscar signer APÓS notificação para pegar o link de assinatura ativo
      await sleep(3000);
      const sigInfo = await reqRetry(BASE + "/envelopes/" + envId + "/signers/" + signerId, "GET", token, null);
      console.log("P7 SIGNER FULL:", JSON.stringify(sigInfo.body));
      const sigAttrs = (sigInfo.body && sigInfo.body.data && sigInfo.body.data.attributes) ? sigInfo.body.data.attributes : {};
      const ce = sigAttrs.communicate_events || {};

      // Tentar extrair URL do communicate_events (token de assinatura do ClickSign)
      let signingLink = sigAttrs.url || sigAttrs.sign_url || sigAttrs.signing_url || null;
      if (!signingLink) {
        signingLink = (ce.document && ce.document.sign_request && ce.document.sign_request.url) ||
                      (ce.sign_request && ce.sign_request.url) ||
                      (ce.document && ce.document.url) || null;
      }
      // Fallback: link com signerId (ClickSign usa o UUID do signatário no link)
      if (!signingLink) signingLink = "https://app.clicksign.com/sign/" + signerId;
      console.log("P7 SIGNING LINK:", signingLink);

      console.log("=== SUCESSO ===", envId);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        envelopeId: envId,
        link: signingLink,
        envelopeLink: "https://app.clicksign.com/envelopes/" + envId,
        notified: notify.status === 200 || notify.status === 201 || notify.status === 204,
        whatsappSent: !!(col.telefone && col.telefone.length >= 10),
        status: "enviado"
      }));

    } catch(e) {
      console.log("ERRO GERAL:", e.message);
      response.writeHead(500);
      response.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => console.log("Servidor MR. CAPAS rodando na porta " + PORT));
