import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import extension from "../index.ts";
import { config, parseHandoff, prepare, promptOnlyMessages, sessionId } from "../client.ts";

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
  const data = response(request);
  const handoff = parseHandoff(data, request);
  assert.deepEqual(handoff.response, data, "keep the full JSON for debugging");
  assert.match(JSON.stringify(handoff.context), /Prefer Python/);
});

test("sends only the improved prompt to the model while preserving the original transcript and images", async (t) => {
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
  assert.equal(result.message.content, "Fix the Python bugs and simplify the design.");
  assert.match(JSON.stringify(result.message.details.response), /SQLite/);
  const userMessage = { role: "user", content: [{ type: "text", text: event.prompt }, ...event.images] };
  const current = { role: "custom", ...result.message };
  const stale = { role: "custom", customType: "qwen-proxy", details: { request_id: "old" } };
  const tool = { role: "toolResult", content: "Keep tool results" };
  const filtered = h.events.get("context")({ messages: [stale, userMessage, current, tool] });
  assert.deepEqual(filtered.messages, [
    { role: "user", content: [{ type: "text", text: "Fix the Python bugs and simplify the design." }, ...event.images] },
    tool,
  ]);
  assert.equal(userMessage.content[0].text, event.prompt, "do not mutate Pi's session log");
  assert.doesNotMatch(JSON.stringify(filtered.messages), /request_id|missing_information|Prefer Python|Which bugs/);
  assert.equal(server.requests.length, 1, "tool turns must not call Qwen again");
  await h.commands.get("qwen")("last", h.ctx);
  assert.match(JSON.stringify(h.widgets.at(-1)), /Which bugs/);
  assert.match(JSON.stringify(h.widgets.at(-1)), /request_id/);
});

test("repeated prompts keep their own rewrites across tool turns and session reloads", () => {
  const messages: any[] = [
    { role: "user", content: "again" },
    { role: "custom", customType: "qwen-proxy", content: "First improved prompt", details: { original_prompt: "again" } },
    { role: "assistant", content: "First answer" },
    { role: "user", content: "again" },
    { role: "custom", customType: "qwen-proxy", content: "Second improved prompt", details: { original_prompt: "again" } },
    { role: "custom", customType: "other-extension", content: "Keep me" },
  ];
  const expected = [messages[0], messages[2], messages[3], messages[5]].map((message) => ({ ...message }));
  expected[0].content = "First improved prompt";
  expected[2].content = "Second improved prompt";
  assert.deepEqual(promptOnlyMessages(messages), expected);
  assert.deepEqual(promptOnlyMessages(messages), expected, "projection must work again without in-memory request state");
  assert.equal(messages[0].content, "again");
});

test("keeps Pi's image hints when replacing multi-block user text", () => {
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "fix" }, { type: "text", text: "this\n\nImage size: 640x480" },
      { type: "image", data: "image", mimeType: "image/png" }] },
    { role: "custom", customType: "qwen-proxy", content: "Fix the UI layout.", details: { original_prompt: "fix\nthis" } },
  ];
  assert.deepEqual(promptOnlyMessages(messages)[0].content, [
    { type: "text", text: "Fix the UI layout.\n\nImage size: 640x480" }, messages[0].content[2],
  ]);
});

test("qwen off stops new requests and keeps the last JSON available for debugging", async (t) => {
  const server = await fixture(t);
  const h = harness(server.url);
  const first = await h.events.get("before_agent_start")({ prompt: "fix and make nice" }, h.ctx);
  await h.commands.get("qwen")("off", h.ctx);
  await h.events.get("before_agent_start")({ prompt: "what was the prepared prompt?" }, h.ctx);
  await h.commands.get("qwen")("last", h.ctx);
  assert.match(JSON.stringify(h.widgets.at(-1)), /Fix the Python bugs/);
  assert.equal(server.requests.length, 1);
  const history = [
    { role: "user", content: "fix and make nice" }, { role: "custom", ...first.message },
    { role: "user", content: "what was the prepared prompt?" },
  ];
  assert.deepEqual(h.events.get("context")({ messages: history }).messages, [
    { role: "user", content: "Fix the Python bugs and simplify the design." }, history[2],
  ]);
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
