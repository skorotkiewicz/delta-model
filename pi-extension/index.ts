import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config, contextMessage, prepare, sessionId, type Handoff } from "./client.ts";

const CUSTOM_TYPE = "qwen-proxy";

export default function qwenProxy(pi: ExtensionAPI) {
  let enabled = process.env.QWEN_PROXY_ENABLED !== "0";
  let activeRequestId: string | undefined;
  let last: Handoff | undefined;
  const pending = new Set<AbortController>();

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

  function cancelPending() {
    for (const controller of pending) controller.abort();
    pending.clear();
    activeRequestId = undefined;
    last = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    cancelPending();
    ctx.ui.setStatus(CUSTOM_TYPE, enabled ? "Qwen: on" : "Qwen: off");
    ctx.ui.setWidget(CUSTOM_TYPE, undefined);
  });
  pi.on("session_shutdown", () => cancelPending());

  pi.registerCommand("qwen", {
    description: "Qwen proxy: status, on, off, or last",
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
        const lines = [
          `Qwen: ${last.preparation.prompt}`,
          ...last.preparation.missing_information.map((question) => `Missing: ${question}`),
          ...last.warnings.map((warning) => `Warning: ${warning}`),
        ];
        if (ctx.hasUI) ctx.ui.setWidget(CUSTOM_TYPE, lines);
        else console.error(lines.join("\n"));
      } else if (command === "status") {
        try {
          notify(ctx, [
            `Qwen proxy ${enabled ? "on" : "off"}: ${settings().url}`,
            `Session: ${sessionId(ctx.cwd, ctx.sessionManager.getSessionId())}`,
          ].join("\n"), "info");
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : "Invalid Qwen configuration.", "error");
        }
      } else {
        notify(ctx, "Usage: /qwen [status|on|off|last]", "warning");
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Older Pi versions did not include messageType. Custom background messages must not recurse.
    if (event.messageType === "custom" || !("prompt" in event) || typeof event.prompt !== "string") return;
    activeRequestId = undefined;
    last = undefined;
    ctx.ui.setWidget(CUSTOM_TYPE, undefined);
    if (!enabled || !event.prompt.trim()) return;

    const controller = new AbortController();
    pending.add(controller);
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
    ctx.ui.setStatus(CUSTOM_TYPE, "Qwen: preparing…");
    try {
      const handoff = await prepare({
        message: event.prompt,
        session_id: sessionId(ctx.cwd, ctx.sessionManager.getSessionId()),
      }, { ...settings(), signal });
      signal.throwIfAborted();
      last = handoff;
      activeRequestId = handoff.requestId;
      ctx.ui.setStatus(CUSTOM_TYPE, handoff.status === "prepared" ? "Qwen: ready" : "Qwen: fallback");
      if (handoff.status === "fallback" || handoff.warnings.length) {
        notify(ctx, "Qwen returned a fallback or warnings. Use /qwen last to inspect.", "warning");
      }
      return {
        message: {
          customType: CUSTOM_TYPE,
          content: contextMessage(handoff),
          display: false,
          details: { request_id: handoff.requestId, session_id: handoff.sessionId },
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

  pi.on("context", (event) => ({
    // Retain full session logs, but only send this request's preparation to the provider.
    messages: event.messages.filter((message) => message.role !== "custom" ||
      message.customType !== CUSTOM_TYPE || (activeRequestId !== undefined &&
        (message.details as { request_id?: string } | undefined)?.request_id === activeRequestId)),
  }));
}
