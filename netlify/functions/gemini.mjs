const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 48_000; // Netlify synchronous function ceiling: 60 seconds.
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

function rateAllowed(ip) {
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

function parseJson(text, fallback = {}) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function textParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
    .map((part) => ({ text: String(part.text || '') }));
}

function functionResultValue(step) {
  const chunks = Array.isArray(step.result) ? step.result : [];
  const text = chunks.filter((item) => item?.type === 'text').map((item) => String(item.text || '')).join('\n');
  if (!text) return { result: null };
  return { result: parseJson(text, text) };
}

// Translate the app's Interactions-style history into Gemini generateContent.
// This preserves Olga's existing function/tool loop while routing through Netlify AI Gateway.
function toGenerateContentContents(input) {
  const items = Array.isArray(input) ? input : [{ type: 'user_input', content: [{ type: 'text', text: String(input ?? '') }] }];
  const contents = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'user_input') {
      const parts = textParts(item.content);
      if (parts.length) contents.push({ role: 'user', parts });
      continue;
    }

    if (item.type === 'function_call') {
      contents.push({
        role: 'model',
        parts: [{ functionCall: {
          name: String(item.name || ''),
          args: item.arguments && typeof item.arguments === 'object' ? item.arguments : {},
          ...(item.id ? { id: String(item.id) } : {}),
        } }],
      });
      continue;
    }

    if (item.type === 'function_result') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: {
          name: String(item.name || ''),
          response: functionResultValue(item),
          ...(item.call_id ? { id: String(item.call_id) } : {}),
        } }],
      });
      continue;
    }

    if (item.type === 'model_output') {
      const parts = textParts(item.content);
      if (parts.length) contents.push({ role: 'model', parts });
    }
  }

  return contents;
}

function toGenerateContentTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const functionDeclarations = tools
    .filter((tool) => tool && (tool.type === 'function' || tool.name))
    .map((tool) => ({
      name: String(tool.name || ''),
      ...(tool.description ? { description: String(tool.description) } : {}),
      ...(tool.parameters && typeof tool.parameters === 'object' ? { parameters: tool.parameters } : {}),
    }))
    .filter((tool) => tool.name);
  return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

function toGoogleRequest(payload) {
  const request = {
    contents: toGenerateContentContents(payload.input),
  };

  if (typeof payload.system_instruction === 'string' && payload.system_instruction.trim()) {
    request.systemInstruction = { parts: [{ text: payload.system_instruction }] };
  } else if (payload.system_instruction && typeof payload.system_instruction === 'object') {
    request.systemInstruction = payload.system_instruction;
  }

  const tools = toGenerateContentTools(payload.tools);
  if (tools) {
    request.tools = tools;
    request.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  if (payload.generation_config && typeof payload.generation_config === 'object') {
    request.generationConfig = payload.generation_config;
  }
  return request;
}

function toInteractionsShape(data, model) {
  const candidate = data?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const outputText = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('\n').trim();
  const steps = [];

  const modelTextParts = parts.filter((part) => typeof part.text === 'string');
  if (modelTextParts.length) {
    steps.push({
      type: 'model_output',
      content: modelTextParts.map((part) => ({ type: 'text', text: part.text })),
    });
  }

  parts.filter((part) => part.functionCall && typeof part.functionCall.name === 'string').forEach((part, index) => {
    const call = part.functionCall;
    steps.push({
      type: 'function_call',
      name: call.name,
      arguments: call.args && typeof call.args === 'object' ? call.args : {},
      id: call.id || `olga_call_${Date.now()}_${index}`,
    });
  });

  return {
    object: 'interaction',
    status: steps.some((step) => step.type === 'function_call') ? 'requires_action' : 'completed',
    model: data?.modelVersion || model,
    output_text: outputText,
    steps,
    usage: data?.usageMetadata || undefined,
    finishReason: candidate?.finishReason || undefined,
  };
}

function safeErrorMessage(data, rawText) {
  const message = data?.error?.message || data?.message || rawText || 'Netlify AI Gateway devolvió un error sin detalle.';
  return String(message).slice(0, 1200);
}

// Reporta únicamente presencia/ausencia de variables. Nunca devuelve sus valores.
function gatewayEnvironmentStatus() {
  const apiKeyAvailable = Boolean(String(process.env.GEMINI_API_KEY || '').trim());
  const baseUrlAvailable = Boolean(String(process.env.GOOGLE_GEMINI_BASE_URL || '').trim());
  const googleApiKeyOverrideDetected = Boolean(String(process.env.GOOGLE_API_KEY || '').trim());
  const googleVertexBaseUrlOverrideDetected = Boolean(String(process.env.GOOGLE_VERTEX_BASE_URL || '').trim());
  const netlifyGatewayKeyAvailable = Boolean(String(process.env.NETLIFY_AI_GATEWAY_KEY || '').trim());
  const netlifyGatewayUrlAvailable = Boolean(String(
    process.env.NETLIFY_AI_GATEWAY_URL || process.env.NETLIFY_AI_GATEWAY_BASE_URL || ''
  ).trim());

  let recommendedAction = 'Verificá que AI Features esté habilitado, que el plan admita AI Gateway y que el sitio tenga al menos un deploy de producción.';
  if (!baseUrlAvailable && (googleApiKeyOverrideDetected || googleVertexBaseUrlOverrideDetected)) {
    recommendedAction = 'Hay variables GOOGLE_API_KEY o GOOGLE_VERTEX_BASE_URL configuradas. Quitalas si no usás Vertex/Google propio y volvé a publicar.';
  } else if (!baseUrlAvailable && apiKeyAvailable) {
    recommendedAction = 'La clave Gemini está presente, pero falta la URL del Gateway. Quitá las variables Gemini/Google configuradas manualmente (incluida GEMINI_API_KEY) para permitir que Netlify inyecte el par completo y volvé a publicar.';
  }

  return {
    gatewayConfigured: apiKeyAvailable && baseUrlAvailable,
    gatewayKeyAvailable: apiKeyAvailable,
    gatewayBaseUrlAvailable: baseUrlAvailable,
    googleApiKeyOverrideDetected,
    googleVertexBaseUrlOverrideDetected,
    netlifyGatewayKeyAvailable,
    netlifyGatewayUrlAvailable,
    recommendedAction,
  };
}

async function callNetlifyGateway(payload, apiKey, baseUrl) {
  const model = String(payload.model || DEFAULT_MODEL);
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) {
    return json({ error: { message: 'Nombre de modelo Gemini no válido.' }, code: 'MODEL_INVALID' }, 400);
  }

  const contents = toGenerateContentContents(payload.input);
  if (!contents.length) {
    return json({ error: { message: 'La solicitud no contiene mensajes válidos.' }, code: 'INPUT_EMPTY' }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const endpoint = `${cleanBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(toGoogleRequest(payload)),
      signal: controller.signal,
    });

    const responseText = await upstream.text();
    const responseData = parseJson(responseText, {});

    if (!upstream.ok) {
      return json({
        error: { message: safeErrorMessage(responseData, responseText) },
        code: 'NETLIFY_AI_GATEWAY_ERROR',
        upstreamStatus: upstream.status,
        elapsedMs: Date.now() - startedAt,
      }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const adapted = toInteractionsShape(responseData, model);
    return json(adapted, 200);
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return json({
      error: { message: timedOut
        ? 'Netlify AI Gateway no respondió dentro de 48 segundos.'
        : 'No se pudo completar la solicitud a Netlify AI Gateway.' },
      code: timedOut ? 'NETLIFY_AI_GATEWAY_TIMEOUT' : 'NETLIFY_AI_GATEWAY_NETWORK',
      detail: String(error?.message || error).slice(0, 300),
      elapsedMs: Date.now() - startedAt,
    }, timedOut ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
}

export default async (request, context) => {
  const url = new URL(request.url);
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const baseUrl = String(process.env.GOOGLE_GEMINI_BASE_URL || '').trim();
  const environmentStatus = gatewayEnvironmentStatus();

  // Health check: devuelve diagnóstico seguro, sin filtrar claves ni URLs.
  if (request.method === 'GET' && url.searchParams.get('probe') !== '1') {
    return json({
      ok: true,
      service: 'olga-netlify-ai-gateway',
      ...environmentStatus,
      route: 'Netlify AI Gateway → Gemini generateContent',
      note: 'Solo se informa si las variables existen; nunca se devuelven sus valores.',
    });
  }

  if (request.method === 'GET' && url.searchParams.get('probe') === '1') {
    if (!apiKey || !baseUrl) {
      return json({
        ok: false,
        ...environmentStatus,
        code: 'NETLIFY_AI_GATEWAY_NOT_CONFIGURED',
        error: environmentStatus.recommendedAction,
      }, 503);
    }
    const model = String(url.searchParams.get('model') || DEFAULT_MODEL);
    return await callNetlifyGateway({ model, input: 'Respondé exactamente: CONEXIÓN OK' }, apiKey, baseUrl);
  }

  if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  if (!apiKey || !baseUrl) {
    return json({
      error: { message: environmentStatus.recommendedAction },
      code: 'NETLIFY_AI_GATEWAY_NOT_CONFIGURED',
      gatewayKeyAvailable: environmentStatus.gatewayKeyAvailable,
      gatewayBaseUrlAvailable: environmentStatus.gatewayBaseUrlAvailable,
      googleApiKeyOverrideDetected: environmentStatus.googleApiKeyOverrideDetected,
      googleVertexBaseUrlOverrideDetected: environmentStatus.googleVertexBaseUrlOverrideDetected,
      netlifyGatewayKeyAvailable: environmentStatus.netlifyGatewayKeyAvailable,
      netlifyGatewayUrlAvailable: environmentStatus.netlifyGatewayUrlAvailable,
    }, 503);
  }

  const ip = context?.ip || request.headers.get('x-nf-client-connection-ip') || '';
  if (!rateAllowed(ip)) {
    return json({ error: { message: 'Se alcanzó el límite temporal de consultas. Intentá nuevamente en un minuto.' }, code: 'RATE_LIMIT' }, 429);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: { message: 'La solicitud supera el tamaño máximo permitido.' } }, 413);
  }

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: { message: 'La solicitud supera el tamaño máximo permitido.' } }, 413);
    }
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: { message: 'El cuerpo recibido no es JSON válido.' } }, 400);
  }

  const payload = body?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: { message: 'Falta el objeto payload.' } }, 400);
  }

  return await callNetlifyGateway(payload, apiKey, baseUrl);
};
