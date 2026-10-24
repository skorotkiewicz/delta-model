import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config, postJson, prepare, promptOnlyMessages, sessionId, type Handoff } from "./client.ts";
import { contentText, identities, ProjectContextCollector, type Check } from "./project-context.ts";

const CUSTOM_TYPE = "qwen-proxy";

export default function qwenProxy(pi: ExtensionAPI) {
  let enabled = process.env.QWEN_PROXY_ENABLED !== "0";
  let last: Handoff | undefined;
  const pending = new Set<AbortController>();
  const collector = new ProjectContextCollector();
  type Feedback = { session_id: string; request_id: string; summary: string; status: string; files: string[]; checks: Check[]; url: string; ready: boolean };
  const feedbacks = new Map<string, Feedback>();
  let activeRequest: string | undefined;
  let lifecycle = 0;

  function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else console.error(`[qwen-proxy] ${text}`);
  }

  pi.registerFlag("qwen-proxy-url", {
    type: "string", description: "Qwen preparation endpoint, default: http://127.0.0.1:8765/prepare",
  });
  pi.registerFlag("qwen-proxy-timeout", {
    type: "string", description: "Qwen preparation timeout in milliseconds, default: 300000",
  });

  const settings = () => config(
    String(pi.getFlag("qwen-proxy-url") || process.env.QWEN_PROXY_URL || "http://127.0.0.1:8765/prepare"),
    String(pi.getFlag("qwen-proxy-timeout") || process.env.QWEN_PROXY_TIMEOUT_MS || "300000"),
  );
  const scopeIds = (ctx: ExtensionContext) => ({
    session_id: sessionId(ctx.cwd, ctx.sessionManager.getSessionId()), ...identities(ctx.cwd),
  });
  const endpoint = (name: string) => new URL(name, settings().url).toString();

  function cancelPending() {
    lifecycle++;
    for (const controller of pending) controller.abort();
    pending.clear();
    feedbacks.clear();
    activeRequest = undefined;
  }

  async function deliverFeedback(ctx: ExtensionContext, aborted = false, readyOnly = false) {
    if (!enabled) return;
    const version = lifecycle;
    const currentId = activeRequest;
    const completed = [...feedbacks.values()].filter((item) => !readyOnly || item.ready);
    for (const item of completed) feedbacks.delete(item.request_id);
    for (const current of completed) {
      if (version !== lifecycle || !enabled) break;
      if (aborted && current.request_id === currentId) current.status = "aborted";
      const controller = new AbortController();
      pending.add(controller);
      try {
        const { url, ready: _ready, ...body } = current;
        await postJson(body, { url, timeoutMs: 5000, signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) notify(ctx, `Qwen outcome feedback failed: ${error instanceof Error ? error.message : error}`, "warning");
      } finally { pending.delete(controller); }
    }
    if (!readyOnly && activeRequest === currentId) activeRequest = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    cancelPending();
    last = undefined;
    collector.reset();
    ctx.ui.setStatus(CUSTOM_TYPE, enabled ? "Qwen: on" : "Qwen: off");
    ctx.ui.setWidget(CUSTOM_TYPE, undefined);
  });
  pi.on("session_shutdown", () => { cancelPending(); last = undefined; });

  pi.on("input", async (event, ctx) => {
    // Capture the user's own words before skill or template expansion.
    // Text from repository files must never become a claimed user preference.
    if (!enabled || event.source === "extension" ||
        !/(?:^|\n|[.!?]\s+)(?:I prefer\b|I always\b|I never\b|Remember(?: that)?\b)/i.test(event.text)) {
      return { action: "continue" };
    }
    const controller = new AbortController();
    const version = lifecycle;
    pending.add(controller);
    try {
      await postJson({ ...scopeIds(ctx), operation: "capture", message: event.text },
        { url: endpoint("memory"), timeoutMs: 5000, signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) notify(ctx, `Qwen preference capture failed: ${error instanceof Error ? error.message : error}`, "warning");
    } finally { pending.delete(controller); }
    return { action: version === lifecycle ? "continue" : "handled" };
  });

  pi.registerCommand("qwen", {
    description: "Qwen proxy: status, on, off, last, memories, remember, forget",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "on" || command === "off") {
        enabled = command === "on";
        if (!enabled) cancelPending();
        ctx.ui.setStatus(CUSTOM_TYPE, enabled ? "Qwen: on" : "Qwen: off");
        ctx.ui.setWidget(CUSTOM_TYPE, undefined);
        notify(ctx, `Qwen proxy ${enabled ? "enabled" : "disabled"}.`, "info");
      } else if (command === "last") {
        if (!last) {
          notify(ctx, "No Qwen preparation in this session yet.", "info");
          return;
        }
        const lines = JSON.stringify(last.response, null, 2).split("\n");
        if (ctx.hasUI) ctx.ui.setWidget(CUSTOM_TYPE, lines);
        else console.error(lines.join("\n"));
      } else if (command === "status") {
        try {
          notify(ctx, [
            `Qwen proxy ${enabled ? "on" : "off"}: ${settings().url}`,
            `Session: ${sessionId(ctx.cwd, ctx.sessionManager.getSessionId())}`,
            `Project: ${identities(ctx.cwd).project_id}`,
            `User: ${identities(ctx.cwd).user_id}`,
          ].join("\n"), "info");
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : "Invalid Qwen configuration.", "error");
        }
      } else if (/^(?:remember|forget|memories)(?:\s|$)/.test(command)) {
        const parts = command.match(/^(remember|forget|memories)(?:\s+(session|project|user|all))?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/);
        if (!parts || (parts[1] !== "memories" && (!parts[2] || !parts[3] || parts[2] === "all")) ||
            (parts[1] === "remember" && !parts[4])) {
          notify(ctx, "Use /qwen remember <scope> <key> <fact>, /qwen forget <scope> <key>, or /qwen memories [scope] [query].", "warning");
          return;
        }
        const operation = parts[1] === "remember" ? "put" : parts[1] === "forget" ? "forget" : "search";
        const body = { ...scopeIds(ctx), operation, scope: parts[2] || "all",
          ...(operation === "search" ? { query: [parts[3], parts[4]].filter(Boolean).join(" ") } : { key: parts[3] }),
          ...(operation === "put" ? { fact: parts[4] } : {}),
        };
        const controller = new AbortController();
        pending.add(controller);
        try {
          const result = await postJson(body, { url: endpoint("memory"), timeoutMs: 5000, signal: controller.signal }) as {
            memories: { scope: string; key: string; fact: string; source: string }[];
          };
          const lines = result.memories.map((memory) => `[${memory.scope}] ${memory.key}: ${memory.fact} (${memory.source})`);
          if (ctx.hasUI) ctx.ui.setWidget(CUSTOM_TYPE, lines.length ? lines : ["No matching memories."]);
          else console.error(lines.join("\n") || "No matching memories.");
        } catch (error) {
          if (!controller.signal.aborted) notify(ctx, `Memory request failed: ${error instanceof Error ? error.message : error}`, "warning");
        } finally { pending.delete(controller); }
      } else {
        notify(ctx, "Usage: /qwen [status|on|off|last|memories|remember|forget]", "warning");
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Older Pi versions did not include messageType. Custom background messages must not recurse.
    if (event.messageType === "custom" || !("prompt" in event) || typeof event.prompt !== "string") return;
    // A queued follow-up can start before global settlement. Make the previous
    // answer available to Qwen before preparing that follow-up.
    const version = lifecycle;
    await deliverFeedback(ctx, false, true);
    if (version !== lifecycle) return;
    collector.beginTurn();
    activeRequest = undefined;
    ctx.ui.setWidget(CUSTOM_TYPE, undefined);
    if (!enabled || !event.prompt.trim()) return;

    const controller = new AbortController();
    pending.add(controller);
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
    ctx.ui.setStatus(CUSTOM_TYPE, "Qwen: preparing…");
    try {
      const handoff = await prepare({
        message: event.prompt,
        ...scopeIds(ctx),
        learn_preferences: false,
        context: await collector.collect(ctx.cwd, event.prompt,
          typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []),
      }, { ...settings(), signal });
      signal.throwIfAborted();
      last = handoff;
      activeRequest = handoff.requestId;
      feedbacks.set(handoff.requestId, { session_id: handoff.sessionId, request_id: handoff.requestId,
        summary: "", status: "completed", files: [], checks: [], url: endpoint("feedback"), ready: false });
      ctx.ui.setStatus(CUSTOM_TYPE, handoff.status === "prepared" ? "Qwen: ready" : "Qwen: fallback");
      if (handoff.status === "fallback" || handoff.warnings.length) {
        notify(ctx, "Qwen returned a fallback or warnings. Use /qwen last to inspect.", "warning");
      }
      return {
        message: {
          customType: CUSTOM_TYPE,
          content: handoff.preparation.prompt,
          display: false,
          details: { request_id: handoff.requestId, session_id: handoff.sessionId,
                     original_prompt: event.prompt, response: handoff.response },
        },
      };
    } catch (error) {
      if (signal.aborted) {
        if (!controller.signal.aborted) ctx.ui.setStatus(CUSTOM_TYPE, enabled ? "Qwen: on" : "Qwen: off");
        return;
      }
      ctx.ui.setStatus(CUSTOM_TYPE, "Qwen: unavailable");
      const message = error instanceof Error ? error.message : "Unknown proxy error.";
      notify(ctx, `Qwen preparation failed: ${message} Using the original prompt.`, "warning");
    } finally {
      pending.delete(controller);
    }
  });

  pi.on("tool_execution_start", (event) => collector.toolStart(event.toolCallId, event.toolName, event.args));
  pi.on("tool_execution_end", (event) => collector.toolEnd(event.toolCallId, event.toolName, event.result, event.isError));
  pi.on("agent_end", (event, ctx) => {
    const current = activeRequest && feedbacks.get(activeRequest);
    if (!current) return;
    const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (assistant?.role === "assistant") {
      current.summary = contentText(assistant.content).slice(0, 4000);
      current.status = assistant.stopReason === "error" ? "error" : "completed";
    }
    Object.assign(current, collector.outcome(ctx.cwd));
    current.ready = true;
  });
  pi.on("agent_settled", (event, ctx) => deliverFeedback(ctx, event.aborted));

  pi.on("context", (event) => ({
    messages: promptOnlyMessages(event.messages),
  }));
}
