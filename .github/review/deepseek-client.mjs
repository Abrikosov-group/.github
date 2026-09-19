// The provider receives review data only. No retries, fallback model or external tools.
export const PROFILE = Object.freeze({
  model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "max",
});
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ReviewFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function completion({ key, messages, tools, json = false, signal, fetchImpl = fetch }) {
  if (typeof key !== "string" || key.length < 16) throw new ReviewFailure("credential_unavailable");
  const body = JSON.stringify({
    ...PROFILE, messages, max_tokens: 32768, stream: false,
    ...(json ? { response_format: { type: "json_object" } } : {}),
    ...(tools ? { tools } : {}),
  });
  if (body.includes(key)) throw new ReviewFailure("credential_in_input");
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body,
    });
  } catch {
    throw new ReviewFailure(signal?.aborted ? "deadline_exceeded" : "transport_unavailable");
  }
  // Never include provider error bodies, headers or the credential in logs/artifacts.
  if (!response.ok) throw new ReviewFailure(`provider_http_${response.status}`);
  let raw = "";
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ReviewFailure("response_too_large");
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof ReviewFailure) throw error;
    throw new ReviewFailure(signal?.aborted ? "deadline_exceeded" : "response_unavailable");
  }
  if (raw.includes(key)) throw new ReviewFailure("credential_in_response");
  let data;
  try { data = JSON.parse(raw); } catch { throw new ReviewFailure("response_invalid_json"); }
  if (data.model !== PROFILE.model) throw new ReviewFailure("returned_model_mismatch");
  const choice = data.choices?.[0];
  if (data.choices?.length !== 1 || !choice?.message ||
      !["stop", "tool_calls"].includes(choice.finish_reason)) {
    throw new ReviewFailure("response_incomplete");
  }
  if (choice.message.role !== "assistant") throw new ReviewFailure("response_invalid_role");
  const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    message: choice.message, finishReason: choice.finish_reason,
    evidence: {
      model: data.model,
      responseId: typeof data.id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(data.id) ? data.id : null,
      finishReason: choice.finish_reason,
      reasoningPresent: typeof choice.message.reasoning_content === "string" && choice.message.reasoning_content.length > 0,
      // Successful HTTP requests prove parameter acceptance, not the provider's internal setting.
      effortEcho: ["low", "high", "max"].includes(data.reasoning_effort) ? data.reasoning_effort : null,
      promptTokens: number(data.usage?.prompt_tokens), completionTokens: number(data.usage?.completion_tokens),
    },
  };
}
