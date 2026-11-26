const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_BODY_BYTES = 1_000_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 25;
const requestCounts = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isRateAllowed(ip) {
  if (!ip) return true;
  const now = Date.now();
  const record = requestCounts.get(ip) || { start: now, count: 0 };
  if (now - record.start > RATE_WINDOW_MS) {
    record.start = now;
    record.count = 0;
  }
  record.count += 1;
  requestCounts.set(ip, record);
  // Evita que el mapa crezca indefinidamente en instancias persistentes.
  if (requestCounts.size > 5_000) {
    for (const [key, value] of requestCounts) {
      if (now - value.start > RATE_WINDOW_MS) requestCounts.delete(key);
    }
  }
  return record.count <= RATE_MAX;
}

export default async (request, context) => {
  // En Netlify Functions (serverless), process.env es la API oficial para
  // leer variables con alcance Functions. Nunca devolvemos el valor secreto.
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();

  // Diagnóstico seguro: permite comprobar desde el navegador si ESTE deploy
  // recibió la variable, sin revelar la clave ni fragmentos de ella.
  if (request.method === 'GET') {
    return json({
      ok: true,
      service: 'olga-gemini-netlify-function',
      geminiKeyConfigured: Boolean(apiKey),
      keyLookup: 'process.env.GEMINI_API_KEY',
    });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Método no permitido.' }, 405);
  }

  if (!apiKey) {
    return json({
      error: 'Esta función no recibió GEMINI_API_KEY. Confirmá que la variable esté creada en ESTE sitio Netlify, con alcance Functions, y volvé a publicar un nuevo deploy de Production después de guardarla.',
      code: 'GEMINI_ENV_MISSING',
    }, 500);
  }

  const ip = context?.ip || request.headers.get('x-nf-client-connection-ip') || '';
  if (!isRateAllowed(ip)) {
    return json({ error: 'Se alcanzó el límite temporal de consultas. Intentá nuevamente en un minuto.' }, 429);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'La solicitud supera el tamaño máximo permitido.' }, 413);
  }

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: 'La solicitud supera el tamaño máximo permitido.' }, 413);
    }
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'El cuerpo recibido no es JSON válido.' }, 400);
  }

  const payload = body?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: 'Falta el objeto payload.' }, 400);
  }
  const model = String(payload.model || '');
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) {
    return json({ error: 'Nombre de modelo Gemini no válido.' }, 400);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55_000);
    let upstream;
    try {
      upstream = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Api-Revision': '2026-05-20',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await upstream.text();
    return new Response(responseText, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Gemini tardó demasiado en responder. Intentá nuevamente.'
      : 'No se pudo establecer conexión con Gemini desde el servidor.';
    return json({ error: message }, 502);
  }
};
