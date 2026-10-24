import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import extension from "../index.ts";
import { config, contextMessage, parseHandoff, prepare, sessionId } from "../client.ts";

function response(request: any, overrides: Record<string, unknown> = {}) {
  return {
    request_id: "request-1",
    session_id: request.session_id,
    status: "prepared",
    preparation: { prompt: "Fix the Python bugs and simplify the design.", missing_information: ["Which bugs?"] },
    handoff: { messages: [
      { role: "system", content: "A proxy instruction that must not replace Pi's system prompt." },
      { role: "user", content: JSON.stringify({
        original_request: request.message,
        context: { memories: ["Prefer Python."], resources: [{ path: "notes.md", text: "Use SQLite." }] },
        submitted_storage: {},
        tool_results: [{ result: { database: "SQLite" } }],
      }) },
    ] },
    warnings: [],
    ...overrides,
  };
}

async function fixture(t: any, handler?: (request: any, res: any) => void) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url, method: req.method, data: request });
    if (handler) return handler(request, res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response(request)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/prepare`, requests };
}

function harness(url: string, timeout = "1000") {
  const events = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  const widgets: unknown[] = [];
  const flags: Record<string, string> = { "qwen-proxy-url": url, "qwen-proxy-timeout": timeout };
  const pi = {
    on: (name: string, handler: any) => events.set(name, handler),
    registerCommand: (name: string, options: any) => commands.set(name, options.handler),
    registerFlag: () => {},
    getFlag: (name: string) => flags[name],
  };
  const ctx = {
    cwd: "/project", hasUI: true, signal: undefined as AbortSignal | undefined,
    sessionManager: { getSessionId: () => "session-a" },
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWidget: (_key: string, widget: unknown) => widgets.push(widget),
    },
  };
  extension(pi as any);
  return { events, commands, ctx, flags, notifications, statuses, widgets };
}

test("session IDs survive resume and isolate different sessions and projects", () => {
  const first = sessionId("/project", "a");
  assert.equal(first, sessionId("/project", "a"));
  assert.match(first, /^[a-zA-Z0-9_-]{1,80}$/);
  assert.notEqual(first, sessionId("/project", "b"));
  assert.notEqual(first, sessionId("/other", "a"));
});

test("validates configuration and mismatched or malformed handoffs", () => {
  assert.equal(config().timeoutMs, 300_000);
  assert.throws(() => config("file:///tmp/proxy"));
  assert.throws(() => config("http://user:password@localhost/prepare"));
  assert.throws(() => config(undefined, "NaN"));
  const request = { message: "fix and make nice", session_id: "test" };
  for (const bad of [null, {}, response(request, { session_id: "another-session" }),
    response(request, { handoff: { messages: [{ role: "user", content: "invalid" }] } }),
    response({ ...request, message: "different request" })]) {
    assert.throws(() => parseHandoff(bad, request));
  }
  const content = contextMessage(parseHandoff(response(request), request));
  assert.match(content, /Prefer Python/);
  assert.match(content, /SQLite/);
  assert.match(content, /Which bugs/);
  assert.doesNotMatch(content, /A proxy instruction/);
});

test("calls the actual HTTP preparation endpoint and injects context without changing the prompt or images", async (t) => {
  const server = await fixture(t);
  const h = harness(server.url);
  h.events.get("session_start")({}, h.ctx);
  const event = { messageType: "user", prompt: "fix and make nice", systemPrompt: "Pi's system prompt",
    images: [{ type: "image", data: "image-data", mimeType: "image/png" }] };
  const before = structuredClone(event);
  const result = await h.events.get("before_agent_start")(event, h.ctx);
  assert.deepEqual(event, before);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, "POST");
  assert.equal(server.requests[0].path, "/prepare");
  assert.equal(server.requests[0].data.message, event.prompt);
  assert.equal(result.systemPrompt, undefined);
  assert.equal(result.message.customType, "qwen-proxy");
  assert.equal(result.message.display, false);
  assert.match(result.message.content, /SQLite/);
  const userMessage = { role: "user", content: event.prompt };
  const current = { role: "custom", ...result.message };
  const stale = { role: "custom", customType: "qwen-proxy", details: { request_id: "old" } };
  const tool = { role: "toolResult", content: "Keep tool results" };
  const filtered = h.events.get("context")({ messages: [stale, userMessage, current, tool] });
  assert.deepEqual(filtered.messages, [userMessage, current, tool]);
  assert.equal(server.requests.length, 1, "tool turns must not call Qwen again");
  await h.commands.get("qwen")("last", h.ctx);
  assert.match(JSON.stringify(h.widgets.at(-1)), /Which bugs/);
});

test("disabled and custom-message runs skip Qwen", async (t) => {
  const server = await fixture(t);
  const h = harness(server.url);
  await h.events.get("before_agent_start")({ messageType: "custom" }, h.ctx);
  await h.commands.get("qwen")("off", h.ctx);
  await h.events.get("before_agent_start")({ messageType: "user", prompt: "hello" }, h.ctx);
  assert.equal(server.requests.length, 0);
  await h.commands.get("qwen")("on", h.ctx);
  await h.events.get("before_agent_start")({ messageType: "user", prompt: "hello" }, h.ctx);
  assert.equal(server.requests.length, 1);
});

test("proxy errors warn and leave the original Pi prompt available without stale context", async (t) => {
  const server = await fixture(t, (_req, res) => { res.writeHead(503); res.end(); });
  const h = harness(server.url);
  const event = { messageType: "user", prompt: "fix all bugs", systemPrompt: "unchanged" };
  assert.equal(await h.events.get("before_agent_start")(event, h.ctx), undefined);
  assert.equal(event.prompt, "fix all bugs");
  assert.match(h.notifications[0], /HTTP 503.*original prompt/);
  assert.deepEqual(h.events.get("context")({ messages: [
    { role: "custom", customType: "qwen-proxy", details: { request_id: "old" } },
  ] }).messages, []);
});

test("timeouts and session shutdown cancel pending proxy requests", async (t) => {
  const server = await fixture(t, () => {});
  const h = harness(server.url, "25");
  assert.equal(await h.events.get("before_agent_start")({ prompt: "hello" }, h.ctx), undefined);
  assert.match(h.notifications[0], /original prompt/);
  h.flags["qwen-proxy-timeout"] = "1000";
  const pending = h.events.get("before_agent_start")({ prompt: "hello again" }, h.ctx);
  h.events.get("session_shutdown")();
  assert.equal(await pending, undefined);
  assert.equal(h.notifications.length, 1, "shutdown cancellation must not report a proxy failure");
});

test("new sessions reset context and use a different proxy session", async (t) => {
  const server = await fixture(t);
  const h = harness(server.url);
  await h.events.get("before_agent_start")({ prompt: "hello" }, h.ctx);
  h.ctx.sessionManager.getSessionId = () => "session-b";
  h.events.get("session_start")({}, h.ctx);
  await h.events.get("before_agent_start")({ prompt: "hello again" }, h.ctx);
  assert.notEqual(server.requests[0].data.session_id, server.requests[1].data.session_id);
});

test("rejects oversized prompts before sending them and caps streamed response size", async (t) => {
  const server = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ padding: "x".repeat(256 * 1024) }));
  });
  const options = { url: server.url, timeoutMs: 1000 };
  await assert.rejects(prepare({ message: "x".repeat(8001), session_id: "test" }, options), /limits/);
  assert.equal(server.requests.length, 0);
  await assert.rejects(prepare({ message: "hello", session_id: "test" }, options), /256 KB/);
});
