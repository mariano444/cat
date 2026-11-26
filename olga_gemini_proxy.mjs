import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
const HTML_PATH = resolve(process.env.HTML_FILE || './olga_vendedor_gemini_demo.html');
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_BODY_BYTES = 1024 * 1024;
const rate = new Map();

if (!API_KEY) {
  console.error('Falta GEMINI_API_KEY. Definí la variable de entorno antes de iniciar el servidor.');
  process.exit(1);
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === ALLOWED_ORIGIN;
}
function allowHeaders(req) {
  const origin = req.headers.origin;
  return origin === ALLOWED_ORIGIN ? {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  } : {};
}
function rateAllowed(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const row = rate.get(ip) || { start: now, count: 0 };
  if (now - row.start > 60_000) { row.start = now; row.count = 0; }
  row.count += 1;
  rate.set(ip, row);
  return row.count <= 25;
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('El cuerpo de la solicitud supera 1 MB.');
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw new Error('El cuerpo recibido no es JSON válido.'); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS' && req.url === '/api/gemini') {
    if (!isAllowedOrigin(req)) return send(res, 403, { error: 'Origen no autorizado.' });
    res.writeHead(204, allowHeaders(req));
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/olga_vendedor_gemini_demo.html')) {
    try {
      const html = await readFile(HTML_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No se encontró olga_vendedor_gemini_demo.html en la carpeta del servidor.');
    }
  }

  if (req.method !== 'POST' || req.url !== '/api/gemini') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  const cors = allowHeaders(req);
  if (!isAllowedOrigin(req)) return send(res, 403, { error: 'Origen no autorizado.' }, cors);
  if (!rateAllowed(req)) return send(res, 429, { error: 'Límite temporal de solicitudes alcanzado. Intentá más tarde.' }, cors);

  try {
    const body = await readJson(req);
    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(res, 400, { error: 'Falta el objeto payload.' }, cors);
    }
    const model = String(payload.model || '');
    if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) {
      return send(res, 400, { error: 'Nombre de modelo Gemini no válido.' }, cors);
    }
    // Evita convertir este servicio en un proxy abierto hacia otros destinos.
    const upstream = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY,
        'Api-Revision': '2026-05-20'
      },
      body: JSON.stringify(payload)
    });
    const resultText = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors
    });
    return res.end(resultText);
  } catch (error) {
    return send(res, 400, { error: error.message || 'No se pudo procesar la solicitud.' }, cors);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Olga Gemini Proxy disponible en http://${HOST}:${PORT}`);
  console.log(`Origen permitido: ${ALLOWED_ORIGIN}`);
  console.log('La clave Gemini se mantiene en el entorno del servidor y no se envía al navegador.');
});
