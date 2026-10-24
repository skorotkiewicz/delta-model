import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hasPi = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
const liveProxy = process.env.QWEN_PROXY_LIVE_URL;

test("installed Pi forwards original prompt, Qwen context and built-in tools to its model", {
  skip: !hasPi && "Pi is not installed",
  timeout: liveProxy ? 330_000 : 30_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-qwen-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, body });
    if (req.url === "/prepare") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        request_id: "pi-integration", session_id: body.session_id, status: "prepared",
        preparation: { prompt: "Fix the Python bugs. Keep SQLite.", missing_information: ["Which bugs?"] },
        handoff: { messages: [{ role: "user", content: JSON.stringify({
          original_request: body.message,
          context: { memories: ["Keep SQLite."] },
          submitted_storage: {}, tool_results: [{ result: "local project facts" }],
        }) }] }, warnings: [],
      }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [
        { delta: { role: "assistant", content: "Main model answered after Qwen preparation." }, finish_reason: null },
        { delta: {}, finish_reason: "stop" },
      ]) {
        res.write(`data: ${JSON.stringify({
          id: "local-test", object: "chat.completion.chunk", model: "check", created: 1,
          choices: [{ index: 0, ...choice }],
        })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = join(dir, "provider.ts");
  await writeFile(provider, `export default function (pi) {
    pi.registerProvider("qwen-proxy-test", {
      baseUrl: ${JSON.stringify(base + "/v1")}, api: "openai-completions", apiKey: "local-test",
      models: [{ type: "chat", id: "check", name: "Local integration test", reasoning: false,
        input: ["text"], contextWindow: 32000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    });
  }`);
  await mkdir(join(dir, "agent"));
  const child = spawn("pi", [
    "--offline", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-themes",
    "--no-context-files", "--no-prompt-templates", "--tools", "read",
    "-e", fileURLToPath(new URL("../index.ts", import.meta.url)), "-e", provider,
    "--model", "qwen-proxy-test/check", "--api-key", "local-test", "-p", "fix and make nice",
  ], {
    cwd: dir,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
      QWEN_PROXY_URL: liveProxy || base + "/prepare",
      QWEN_PROXY_TIMEOUT_MS: liveProxy ? "300000" : "5000", QWEN_PROXY_ENABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(exit, 0, errors + output);
  assert.match(output, /Main model answered after Qwen preparation/);
  assert.doesNotMatch(errors, /Qwen preparation failed|Error loading extension/);
  assert.deepEqual(requests.map((request) => request.path), liveProxy ?
    ["/v1/chat/completions"] : ["/prepare", "/v1/chat/completions"]);
  if (!liveProxy) assert.equal(requests[0].body.message, "fix and make nice");
  const payload = requests.at(-1)!.body;
  const text = (message: any) => typeof message.content === "string" ? message.content :
    message.content.map((part: any) => part.text || "").join("\n");
  assert.ok(payload.messages.some((message: any) => message.role === "user" && text(message) === "fix and make nice"));
  const context = payload.messages.find((message: any) => text(message).includes("Qwen preparation for the current user request."));
  assert.ok(context, "the model must receive Qwen context, not silently bypass the proxy");
  if (liveProxy) {
    assert.match(text(context), /"proxy_status": "prepared"/);
    t.diagnostic(text(context));
  } else {
    assert.match(text(context), /Keep SQLite/);
    assert.match(text(context), /Which bugs/);
  }
  assert.ok(payload.tools.some((tool: any) => tool.function.name === "read"));
});
