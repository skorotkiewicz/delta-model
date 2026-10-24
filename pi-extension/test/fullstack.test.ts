import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hasPi = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
const root = fileURLToPath(new URL("../../", import.meta.url));

test("real proxy, scoped memory, compiler, installed Pi and feedback work together", {
  skip: !hasPi && "Pi is not installed", timeout: 30_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-fullstack-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "resources"));
  const database = join(dir, "proxy.sqlite3");
  const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from http.server import ThreadingHTTPServer
from serve import Preparer, Store, Resources, handler_for
class Model:
    device = 'test'
    thinking = False
    def generate(self, messages):
        return json.dumps({'prompt': 'Fix the project bug.', 'missing_information': ['What error should be fixed?']})
server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(Preparer(Model(), Store(sys.argv[2]), Resources(sys.argv[3]))))
print('http://127.0.0.1:' + str(server.server_port), flush=True)
server.serve_forever()
`;
  const server = spawn("python", ["-c", script, root, database, join(dir, "resources")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (server.exitCode === null) server.kill("SIGTERM"); });
  let serverErrors = "";
  server.stderr.on("data", (chunk) => { serverErrors += chunk; });
  const base = await new Promise<string>((resolve, reject) => {
    let output = "";
    server.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) resolve(output.split("\n")[0]);
    });
    server.on("error", reject);
    server.on("exit", (code) => reject(new Error(`Proxy exited ${code}: ${serverErrors}`)));
  });
  const seed = await fetch(base + "/memory", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "seed", user_id: "integration-user", project_id: "integration-project",
      operation: "put", scope: "user", key: "language", fact: "Prefer Python." }) });
  assert.equal(seed.status, 200);
  const childEnv = { ...process.env, QWEN_PROXY_LIVE_URL: base + "/prepare",
    QWEN_PROXY_USER_ID: "integration-user", QWEN_PROXY_PROJECT_ID: "integration-project" };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", fileURLToPath(new URL("./pi.test.ts", import.meta.url))], {
    cwd: root, env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  assert.equal(exit, 0, output + errors + serverErrors);
  assert.match(output, /What error should be fixed/, errors);
  assert.match(output, /Prefer Python/);
  const query = spawnSync("python", ["-c", `
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    feedback = db.execute('SELECT session,summary FROM feedback').fetchall()
    facts = db.execute('SELECT fact,scope,source FROM facts').fetchall()
print(json.dumps({'feedback': feedback, 'facts': facts}))
`, database], { encoding: "utf8" });
  assert.equal(query.status, 0, query.stderr);
  const stored = JSON.parse(query.stdout);
  assert.equal(stored.feedback.length, 1, "the actual proxy must receive post-answer feedback");
  assert.equal(stored.feedback[0][1], "Main model answered after Qwen preparation.");
  assert.deepEqual(stored.facts, [["Prefer Python.", "user", "user"]], "model text must not become durable facts");
  const followup = await fetch(base + "/prepare", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: stored.feedback[0][0], message: "Adapt that plan." }) });
  assert.equal(followup.status, 200);
  const prepared = await followup.json() as any;
  assert.match(prepared.preparation.prompt, /Main model answered after Qwen preparation/);
  assert.equal(JSON.parse(prepared.handoff.messages[1].content).context.recent_outcomes.length, 1);
});
