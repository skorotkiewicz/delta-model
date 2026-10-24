import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ProjectContext } from "./project-context.ts";

export const DEFAULT_URL = "http://127.0.0.1:8765/prepare";
export const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type PrepareRequest = {
  message: string;
  session_id: string;
  memories?: string[];
  storage?: Record<string, unknown>;
  project_id?: string;
  user_id?: string;
  context?: ProjectContext;
  learn_preferences?: boolean;
};

export type Preparation = { prompt: string; missing_information: string[] };
export type Handoff = {
  requestId: string;
  sessionId: string;
  status: "prepared" | "fallback";
  preparation: Preparation;
  context: Record<string, unknown>;
  submittedStorage: Record<string, unknown>;
  toolResults: unknown[];
  warnings: string[];
  response: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function sessionId(cwd: string, piSessionId: string): string {
  return `pi_${createHash("sha256").update(cwd).update("\0").update(piSessionId).digest("hex")}`;
}

export function config(url = DEFAULT_URL, timeout = String(DEFAULT_TIMEOUT_MS)) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Qwen URL must be an HTTP or HTTPS URL without embedded credentials.");
  }
  const timeoutMs = Number(timeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("Qwen timeout must be between 1 and 3600000 milliseconds.");
  }
  return { url: parsed.toString(), timeoutMs };
}

export function parseHandoff(data: unknown, request: PrepareRequest): Handoff {
  if (!isObject(data) || typeof data.request_id !== "string" || !data.request_id ||
      data.session_id !== request.session_id || !["prepared", "fallback"].includes(String(data.status)) ||
      !isObject(data.preparation) || typeof data.preparation.prompt !== "string" ||
      !data.preparation.prompt.trim() || !strings(data.preparation.missing_information) ||
      !isObject(data.handoff) || !Array.isArray(data.handoff.messages) || !strings(data.warnings)) {
    throw new Error("Qwen returned an invalid preparation response.");
  }
  const user = data.handoff.messages.find((item: unknown) => isObject(item) && item.role === "user");
  if (!isObject(user) || typeof user.content !== "string") {
    throw new Error("Qwen response is missing the user handoff.");
  }
  let details: unknown;
  try {
    details = JSON.parse(user.content);
  } catch {
    throw new Error("Qwen handoff contains invalid JSON.");
  }
  if (!isObject(details) || details.original_request !== request.message || !isObject(details.context) ||
      !isObject(details.submitted_storage) || !Array.isArray(details.tool_results)) {
    throw new Error("Qwen handoff does not match the current request.");
  }
  return {
    requestId: data.request_id,
    sessionId: request.session_id,
    status: data.status as Handoff["status"],
    preparation: data.preparation as Preparation,
    context: details.context,
    submittedStorage: details.submitted_storage,
    toolResults: details.tool_results,
    warnings: data.warnings,
    response: data,
  };
}

export async function postJson(
  bodyValue: unknown,
  options: { url: string; timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  const body = JSON.stringify(bodyValue);
  if (Buffer.byteLength(body) > 32_768) {
    throw new Error("Request exceeds the proxy limits.");
  }
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(options.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body,
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Qwen proxy returned HTTP ${response.status}.`);
  }
  if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    await response.body?.cancel();
    throw new Error("Qwen proxy did not return application/json.");
  }
  if (!response.body) throw new Error("Qwen proxy returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Qwen response exceeds 256 KB.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Qwen proxy returned invalid JSON.");
  }
  return data;
}

export async function prepare(
  request: PrepareRequest,
  options: { url: string; timeoutMs: number; signal?: AbortSignal },
): Promise<Handoff> {
  if (!request.message.trim() || request.message.length > 8000) {
    throw new Error("Prompt exceeds the proxy limits. Pi will use the original prompt.");
  }
  // Prefer dropping optional context to bypassing Qwen for a long user prompt.
  const bounded = structuredClone(request);
  while (Buffer.byteLength(JSON.stringify(bounded)) > 32_768 && bounded.context?.files.length) bounded.context.files.pop();
  if (Buffer.byteLength(JSON.stringify(bounded)) > 32_768) delete bounded.context;
  return parseHandoff(await postJson(bounded, options), request);
}

export function promptOnlyMessages(messages: AgentMessage[]): AgentMessage[] {
  const projected = [...messages];
  const replaced = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    const marker = messages[index];
    if (marker.role !== "custom" || marker.customType !== "qwen-proxy" ||
        typeof marker.content !== "string" || !isObject(marker.details) ||
        typeof marker.details.original_prompt !== "string") continue;
    const original = marker.details.original_prompt;
    // Pair each preparation with its preceding user message, including repeated prompts.
    for (let userIndex = index - 1; userIndex >= 0; userIndex--) {
      const user = projected[userIndex];
      if (user.role !== "user" || replaced.has(userIndex)) continue;
      const text = typeof user.content === "string" ? user.content :
        user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text !== original && !text.startsWith(original + "\n\n")) continue;
      // Pi may append image-size hints after the prompt. Keep those and image blocks.
      const rewritten = marker.content + text.slice(original.length);
      let inserted = false;
      const content = typeof user.content === "string" ? rewritten : user.content.flatMap((part): (ImageContent | TextContent)[] => {
        if (part.type !== "text") return [part];
        if (inserted) return [];
        inserted = true;
        return [{ ...part, text: rewritten }];
      });
      projected[userIndex] = { ...user, content };
      replaced.add(userIndex);
      break;
    }
  }
  // Markers and their debug metadata never enter provider context, including legacy JSON markers.
  return projected.filter((message) => message.role !== "custom" || message.customType !== "qwen-proxy");
}
