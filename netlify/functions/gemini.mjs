const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_BODY_BYTES = 1_000_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 25;
const POST_TIMEOUT_MS = 42_000; // Netlify sync functions have a 60s ceiling.
const PROBE_TIMEOUT_MS = 12_000; // Dos pruebas en paralelo: evita agotar el límite de Netlify.
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


// Prueba el endpoint clásico generateContent para separar un problema de
// Interactions API de un problema general de acceso a Gemini.
async function callGenerateContent(apiKey, model, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Respondé exactamente: CONEXION OK' }] }],
          generationConfig: { maxOutputTokens: 24, temperature: 0 },
        }),
        signal: controller.signal,
      },
    );
    const responseText = await upstream.text();
    return {
      status: upstream.status,
      ok: upstream.ok,
      responseText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      error: timedOut
        ? `generateContent no respondió dentro de ${Math.round(timeoutMs / 1000)} segundos.`
        : 'No se pudo abrir la conexión con generateContent.',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeInteractions(apiKey, model) {
  try {
    const result = await callGemini(apiKey, {
      model,
      input: 'Respondé exactamente: CONEXION OK',
    }, PROBE_TIMEOUT_MS);
    return {
      ok: result.ok,
      status: result.status,
      elapsedMs: result.elapsedMs,
      error: result.ok ? undefined : safeGoogleMessage(result.responseText),
      code: result.ok ? undefined : 'UPSTREAM_HTTP_ERROR',
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: error.elapsedMs || null,
      code: error.code || 'INTERACTIONS_ERROR',
      error: error.message || 'Falló Interactions API.',
    };
  }
}

async function probeGenerateContent(apiKey, model) {
  const result = await callGenerateContent(apiKey, model, PROBE_TIMEOUT_MS);
  if (!result.ok) return result;
  let data = {};
  try { data = JSON.parse(result.responseText); } catch {}
  return {
    ok: true,
    status: result.status,
    elapsedMs: result.elapsedMs,
    outputReceived: Boolean(data?.candidates?.[0]?.content?.parts?.some(part => typeof part.text === 'string')),
  };
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

    const model = String(url.searchParams.get('model') || DEFAULT_MODEL);
    if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) {
      return json({ ok: false, geminiKeyConfigured: true, error: 'Modelo no válido.' }, 400);
    }

    // Se prueban ambos endpoints en paralelo; cada uno tiene su propio límite de 12 s.
    const [interactions, generateContent] = await Promise.all([
      probeInteractions(apiKey, model),
      probeGenerateContent(apiKey, model),
    ]);

    const recommendation = generateContent.ok && !interactions.ok
      ? 'GENERATE_CONTENT_OK_INTERACTIONS_FAILED: la clave y la salida a Gemini funcionan; el problema está concentrado en Interactions API. Conviene migrar el proxy a generateContent.'
      : interactions.ok
        ? 'INTERACTIONS_OK: la API de Interactions respondió; revisar el payload completo de Olga si el chat aún falla.'
        : generateContent.ok
          ? 'GENERATE_CONTENT_OK: el endpoint alternativo funciona.'
          : 'BOTH_ENDPOINTS_FAILED: revisar conectividad de Netlify, restricciones de la clave, cuota o disponibilidad regional.';

    return json({
      ok: interactions.ok || generateContent.ok,
      geminiKeyConfigured: true,
      model,
      tests: { interactions, generateContent },
      recommendation,
      note: 'Diagnóstico seguro: nunca devuelve ni registra la API key.',
    }, 200);
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
