const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_BODY_BYTES = 1_000_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 25;
const POST_TIMEOUT_MS = 42_000; // Netlify sync functions have a 60s ceiling.
const PROBE_TIMEOUT_MS = 20_000;
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
  if (requestCounts.size > 5_000) {
    for (const [key, value] of requestCounts) {
      if (now - value.start > RATE_WINDOW_MS) requestCounts.delete(key);
    }
  }
  return record.count <= RATE_MAX;
}

async function callGemini(apiKey, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const upstream = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Api-Revision': '2026-05-20',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Keep the timeout active until the response body has also been read.
    const responseText = await upstream.text();
    return {
      status: upstream.status,
      ok: upstream.ok,
      responseText,
      elapsedMs: Date.now() - startedAt,
      contentType: upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Gemini no respondió dentro de ${Math.round(timeoutMs / 1000)} segundos.`);
      timeoutError.code = 'GEMINI_UPSTREAM_TIMEOUT';
      timeoutError.elapsedMs = Date.now() - startedAt;
      throw timeoutError;
    }
    const networkError = new Error('No se pudo conectar con la API de Gemini desde Netlify.');
    networkError.code = 'GEMINI_UPSTREAM_NETWORK';
    networkError.detail = String(error?.message || error).slice(0, 300);
    networkError.elapsedMs = Date.now() - startedAt;
    throw networkError;
  } finally {
    clearTimeout(timer);
  }
}

function safeGoogleMessage(responseText) {
  try {
    const data = JSON.parse(responseText);
    return String(data?.error?.message || data?.message || 'Google devolvió un error sin mensaje.').slice(0, 900);
  } catch {
    return String(responseText || 'Google devolvió una respuesta no JSON.').slice(0, 900);
  }
}

export default async (request, context) => {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const url = new URL(request.url);

  // Health check: confirms the variable exists, but does not call Google.
  if (request.method === 'GET' && url.searchParams.get('probe') !== '1') {
    return json({
      ok: true,
      service: 'olga-gemini-netlify-function',
      geminiKeyConfigured: Boolean(apiKey),
      keyLookup: 'process.env.GEMINI_API_KEY',
    });
  }

  if (request.method === 'GET' && url.searchParams.get('probe') === '1') {
    if (!apiKey) {
      return json({ ok: false, geminiKeyConfigured: false, error: 'GEMINI_API_KEY no está disponible para esta función.' }, 500);
    }
    try {
      const result = await callGemini(apiKey, {
        model: DEFAULT_MODEL,
        input: 'Respondé exactamente: CONEXION OK',
      }, PROBE_TIMEOUT_MS);
      if (!result.ok) {
        return json({
          ok: false,
          geminiKeyConfigured: true,
          geminiReachable: true,
          upstreamStatus: result.status,
          elapsedMs: result.elapsedMs,
          error: safeGoogleMessage(result.responseText),
        }, 502);
      }
      let data = {};
      try { data = JSON.parse(result.responseText); } catch {}
      return json({
        ok: true,
        geminiKeyConfigured: true,
        geminiReachable: true,
        upstreamStatus: result.status,
        elapsedMs: result.elapsedMs,
        model: data.model || DEFAULT_MODEL,
        outputReceived: Boolean(data.output_text || data.steps?.some(step => step.type === 'model_output')),
      });
    } catch (error) {
      return json({
        ok: false,
        geminiKeyConfigured: true,
        geminiReachable: false,
        code: error.code || 'GEMINI_PROBE_FAILED',
        elapsedMs: error.elapsedMs || null,
        error: error.message || 'Falló la prueba de Gemini.',
      }, 504);
    }
  }

  if (request.method !== 'POST') {
    return json({ error: 'Método no permitido.' }, 405);
  }
  if (!apiKey) {
    return json({ error: 'Netlify no entregó GEMINI_API_KEY a esta función.', code: 'GEMINI_ENV_MISSING' }, 500);
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
    const result = await callGemini(apiKey, payload, POST_TIMEOUT_MS);
    return new Response(result.responseText, {
      status: result.status,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Olga-Upstream-Ms': String(result.elapsedMs),
      },
    });
  } catch (error) {
    return json({
      error: error.message || 'No se pudo completar la solicitud a Gemini.',
      code: error.code || 'GEMINI_PROXY_ERROR',
      elapsedMs: error.elapsedMs || null,
      detail: error.detail || undefined,
    }, error.code === 'GEMINI_UPSTREAM_TIMEOUT' ? 504 : 502);
  }
};
