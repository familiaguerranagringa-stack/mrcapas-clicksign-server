const http = require("http");
const PORT = process.env.PORT || 3000;
const CLICKSIGN_BASE = "https://app.clicksign.com/api/v3";

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
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
        res.end(JSON.stri
