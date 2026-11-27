import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL = "gemini-3.8-flash";
const MAX_BODY_BYTES = 1_000_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 25;
const MAX_RETRIES = 3;
const rateBuckets = globalThis.__olgaGeminiRateBuckets || (globalThis.__olgaGeminiRateBuckets = new Map());

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function clean(value, max = 1200) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, max);
}

function redact(value, max = 1200) {
  return clean(value, max)
    .replace(/AQ\.[A-Za-z0-9._~-]{12,}/g, "[credencial omitida]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[credencial omitida]")
    .replace(/auth_tokens?\/[A-Za-z0-9_-]+/gi, "[token omitido]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[correo omitido]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[teléfono omitido]");
}

function safeOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function rateAllowed(request, context) {
  const ip = context?.ip
    || request.headers.get("x-nf-client-connection-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
  if (ip === "unknown") return true;

  const now = Date.now();
  const current = rateBuckets.get(ip);
  if (!current || now - current.start > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return true;
  }

  current.count += 1;
  if (rateBuckets.size > 1500) {
    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.start > RATE_WINDOW_MS * 2) rateBuckets.delete(key);
    }
  }
  return current.count <= RATE_MAX;
}

function parseJson(text, fallback = {}) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function textParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
    .map((part) => ({ text: String(part.text || "") }));
}

function functionResultValue(step) {
  const chunks = Array.isArray(step.result) ? step.result : [];
  const text = chunks
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n");
  if (!text) return { result: null };
  return { result: parseJson(text, text) };
}

// Convert the frontend's Interactions-style history to Gemini generateContent history.
function toGenerateContentContents(input) {
  const items = Array.isArray(input)
    ? input
    : [{ type: "user_input", content: [{ type: "text", text: String(input ?? "") }] }];
  const contents = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "user_input") {
      const parts = textParts(item.content);
      if (parts.length) contents.push({ role: "user", parts });
      continue;
    }

    if (item.type === "function_call") {
      contents.push({
        role: "model",
        parts: [{
          functionCall: {
            name: String(item.name || ""),
            args: item.arguments && typeof item.arguments === "object" ? item.arguments : {},
            ...(item.id ? { id: String(item.id) } : {}),
          },
        }],
      });
      continue;
    }

    if (item.type === "function_result") {
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: String(item.name || ""),
            response: functionResultValue(item),
            ...(item.call_id ? { id: String(item.call_id) } : {}),
          },
        }],
      });
      continue;
    }

    if (item.type === "model_output") {
      const parts = textParts(item.content);
      if (parts.length) contents.push({ role: "model", parts });
    }
  }

  return contents;
}

function normalizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") normalized.type = value.toUpperCase();
    else if (key === "properties" && value && typeof value === "object") {
      normalized.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, normalizeSchema(child)]),
      );
    } else if (key === "items") normalized.items = normalizeSchema(value);
    else normalized[key] = value;
  }
  return normalized;
}

function toGenerateContentTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const functionDeclarations = tools
    .filter((tool) => tool && (tool.type === "function" || tool.name))
    .map((tool) => ({
      name: String(tool.name || ""),
      ...(tool.description ? { description: String(tool.description) } : {}),
      ...(tool.parameters && typeof tool.parameters === "object"
        ? { parameters: normalizeSchema(tool.parameters) }
        : {}),
    }))
    .filter((tool) => tool.name);
  return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

function toSdkRequest(payload, model) {
  const contents = toGenerateContentContents(payload.input);
  const config = {};

  if (typeof payload.system_instruction === "string" && payload.system_instruction.trim()) {
    config.systemInstruction = payload.system_instruction;
  } else if (payload.system_instruction && typeof payload.system_instruction === "object") {
    config.systemInstruction = payload.system_instruction;
  }

  const tools = toGenerateContentTools(payload.tools);
  if (tools) {
    config.tools = tools;
    config.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  if (payload.generation_config && typeof payload.generation_config === "object") {
    Object.assign(config, payload.generation_config);
  }

  return { model, contents, ...(Object.keys(config).length ? { config } : {}) };
}

function toInteractionsShape(data, model) {
  const candidate = data?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const outputText = parts
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const steps = [];
  const modelTextParts = parts.filter((part) => typeof part.text === "string");

  if (modelTextParts.length) {
    steps.push({
      type: "model_output",
      content: modelTextParts.map((part) => ({ type: "text", text: part.text })),
    });
  }

  parts
    .filter((part) => part.functionCall && typeof part.functionCall.name === "string")
    .forEach((part, index) => {
      const call = part.functionCall;
      steps.push({
        type: "function_call",
        name: call.name,
        arguments: call.args && typeof call.args === "object" ? call.args : {},
        id: call.id || `olga_call_${Date.now()}_${index}`,
      });
    });

  return {
    object: "interaction",
    status: steps.some((step) => step.type === "function_call") ? "requires_action" : "completed",
    model: data?.modelVersion || model,
    output_text: outputText,
    steps,
    usage: data?.usageMetadata || undefined,
    finishReason: candidate?.finishReason || undefined,
  };
}

function statusFromError(error) {
  const direct = Number(error?.status || error?.httpStatus || error?.code);
  if (Number.isInteger(direct) && direct >= 400 && direct <= 599) return direct;
  const raw = String(error?.message || "");
  const match = raw.match(/"code"\s*:\s*(4\d\d|5\d\d)/);
  return match ? Number(match[1]) : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same retry policy used by the working NEXO integration for transient Google errors.
async function generateWithRetry(ai, request, attempts = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      lastError = error;
      const status = statusFromError(error);
      const retryable = [429, 500, 502, 503, 504].includes(status);
      if (!retryable || attempt === attempts - 1) throw error;
      const delay = 600 * (2 ** attempt);
      console.warn(`Olga Gemini temporary provider error (${status}); retry ${attempt + 1}/${attempts - 1} in ${delay}ms.`);
      await wait(delay);
    }
  }
  throw lastError;
}

function providerDiagnostic(error, model) {
  const message = redact(error?.message || error?.toString?.() || "Google no devolvió detalles del error.");
  const status = statusFromError(error);
  let code = clean(error?.statusText || error?.error?.status || error?.error?.code || "", 100);
  const jsonMatch = message.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = parseJson(jsonMatch[0], {});
    code = code || clean(parsed?.error?.status || parsed?.error?.code || "", 100);
  }
  return { provider: "Google Gemini", googleHttpStatus: status, code: code || "PROVIDER_ERROR", message, model };
}

function apiKeyStatus() {
  const apiKeyAvailable = Boolean(String(process.env.GEMINI_API_KEY || "").trim());
  return {
    configured: apiKeyAvailable,
    apiKeyAvailable,
    provider: "Google Gemini",
    model: clean(process.env.GEMINI_TEXT_MODEL || DEFAULT_MODEL, 120).replace(/^models\//, ""),
    route: "Netlify Function → Google Gemini API v1beta generateContent",
    keySource: "GEMINI_API_KEY (Netlify environment variable)",
    note: "La clave permanece en el servidor. No se devuelve su valor.",
  };
}

function createGoogleClient(apiKey) {
  return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
}

async function callGemini(payload, apiKey) {
  const model = clean(payload.model || process.env.GEMINI_TEXT_MODEL || DEFAULT_MODEL, 120);
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) {
    return json({ error: { message: "Nombre de modelo Gemini no válido." }, code: "MODEL_INVALID" }, 400);
  }

  const request = toSdkRequest(payload, model);
  if (!request.contents.length) {
    return json({ error: { message: "La solicitud no contiene mensajes válidos." }, code: "INPUT_EMPTY" }, 400);
  }

  const startedAt = Date.now();
  try {
    const ai = createGoogleClient(apiKey);
    const response = await generateWithRetry(ai, request, MAX_RETRIES);
    const adapted = toInteractionsShape(response, model);
    return json({ ...adapted, provider: "Google Gemini", elapsedMs: Date.now() - startedAt }, 200);
  } catch (error) {
    const diagnostic = providerDiagnostic(error, model);
    const upstreamStatus = diagnostic.googleHttpStatus;
    console.error("Olga Gemini request failed", JSON.stringify(diagnostic));

    const status = upstreamStatus === 503 ? 503 : upstreamStatus === 429 ? 429 : 502;
    const message = upstreamStatus === 503
      ? "Gemini está temporalmente sobrecargado o no disponible. Olga reintentó la consulta y no pudo completarla; probá nuevamente en unos instantes."
      : upstreamStatus === 429
        ? "Se alcanzó temporalmente el límite de consultas de Gemini. Esperá un momento y volvé a intentar."
        : "No se pudo completar la consulta con Google Gemini. Revisá el diagnóstico para conocer el motivo.";

    return json({
      error: { message },
      code: upstreamStatus === 503 ? "GOOGLE_GEMINI_UNAVAILABLE" : upstreamStatus === 429 ? "GOOGLE_GEMINI_RATE_LIMIT" : "GOOGLE_GEMINI_ERROR",
      diagnostic,
      elapsedMs: Date.now() - startedAt,
    }, status);
  }
}

export default async (request, context) => {
  const url = new URL(request.url);
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  const status = apiKeyStatus();

  if (request.method === "GET" && url.searchParams.get("probe") !== "1") {
    return json({ ok: true, service: "olga-google-gemini", ...status });
  }

  if (!apiKey) {
    return json({
      ok: false,
      error: { message: "Falta configurar GEMINI_API_KEY como variable secreta de Netlify." },
      code: "GEMINI_API_KEY_NOT_CONFIGURED",
      ...status,
    }, 503);
  }

  if (request.method === "GET" && url.searchParams.get("probe") === "1") {
    const model = clean(url.searchParams.get("model") || status.model, 120);
    return await callGemini({
      model,
      input: "Respondé exactamente: CONEXIÓN OK",
      system_instruction: "Respondé en español rioplatense con una frase muy breve.",
    }, apiKey);
  }

  if (request.method !== "POST") return json({ error: { message: "Método no permitido." } }, 405);
  if (!safeOrigin(request)) return json({ error: { message: "Origen no permitido." }, code: "ORIGIN_NOT_ALLOWED" }, 403);
  if (!rateAllowed(request, context)) {
    return json({ error: { message: "Se alcanzó el límite temporal de consultas. Intentá nuevamente en un minuto." }, code: "RATE_LIMIT" }, 429);
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json({ error: { message: "La solicitud supera el tamaño máximo permitido." }, code: "BODY_TOO_LARGE" }, 413);
  }

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: { message: "La solicitud supera el tamaño máximo permitido." }, code: "BODY_TOO_LARGE" }, 413);
    }
    body = JSON.parse(raw || "{}");
  } catch {
    return json({ error: { message: "El cuerpo recibido no es JSON válido." }, code: "INVALID_JSON" }, 400);
  }

  const payload = body?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ error: { message: "Falta el objeto payload." }, code: "PAYLOAD_REQUIRED" }, 400);
  }

  return await callGemini(payload, apiKey);
};
