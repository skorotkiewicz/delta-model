import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { identities, ProjectContextCollector } from "../project-context.ts";

test("collects bounded active files and manifests, excluding hidden and outside files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/app.py"), "def main():\n    raise ValueError('broken')\n");
  await writeFile(join(root, "package.json"), '{"name":"atlas","scripts":{"test":"vitest run"}}');
  await writeFile(join(root, ".env.json"), '{"secret":"private"}');
  await writeFile(join(dir, "outside.py"), "private = True");
  await symlink(join(dir, "outside.py"), join(root, "link.py"));
  const collector = new ProjectContextCollector();
  const context = await collector.collect(root, "Fix src/app.py and inspect link.py and .env.json ../outside.py", ["read", "bash"]);
  assert.deepEqual(context.files.map((file) => file.path), ["src/app.py", "package.json"]);
  assert.match(context.files[0].content, /ValueError/);
  assert.deepEqual(context.active_tools, ["read", "bash"]);
  assert.doesNotMatch(JSON.stringify(context), /private|secret/);
});

test("tracks tool errors, test outcomes and touched files separately from previous tasks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qwen-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "app.py"), "print('ok')");
  const collector = new ProjectContextCollector();
  collector.toolStart("read", "read", { path: "app.py" });
  collector.toolEnd("read", "read", { content: [{ type: "text", text: "print('ok')" }] }, false);
  collector.toolStart("test", "bash", { command: "pytest" });
  collector.toolEnd("test", "bash", { content: [{ type: "text", text: "AssertionError in app.py" }] }, true);
  assert.deepEqual(collector.outcome(root).files, ["app.py"]);
  assert.equal(collector.outcome(root).checks[0].success, false);
  collector.beginTurn();
  assert.deepEqual(collector.outcome(root), { files: [], checks: [] });
  const context = await collector.collect(root, "fix the failure");
  assert.equal(context.files[0].path, "app.py");
  assert.match(context.errors[0], /AssertionError/);
  assert.equal(context.checks[0].success, false);
  collector.reset();
  assert.equal((await collector.collect(root, "hello")).errors.length, 0);
});

test("project identities are stable across sessions and change with the project", () => {
  assert.equal(identities("/first").project_id, identities("/first").project_id);
  assert.notEqual(identities("/first").project_id, identities("/second").project_id);
  assert.equal(identities("/first").user_id, identities("/second").user_id);
});
