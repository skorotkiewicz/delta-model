import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

async function status(t: any, dotenv?: string, overrides = {}, flags = {}) {
  const dir = await mkdtemp(join(tmpdir(), "qwen-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../", import.meta.url));
  const extensionDir = join(dir, "extension");
  const project = join(dir, "project");
  await mkdir(extensionDir);
  await mkdir(project);
  for (const name of await readdir(source)) {
    if (name.endsWith(".ts")) await copyFile(join(source, name), join(extensionDir, name));
  }
  if (dotenv !== undefined) await writeFile(join(extensionDir, ".env"), dotenv);
  // A project .env must not configure the installed extension.
  await writeFile(join(project, ".env"), "QWEN_PROXY_URL=http://wrong-project.invalid/prepare\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("QWEN_PROXY_")));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import extension from ${JSON.stringify(pathToFileURL(join(extensionDir, "index.ts")).href)};
    const commands = new Map();
    const flags = ${JSON.stringify(flags)};
    extension({ registerFlag() {}, getFlag(name) { return flags[name]; }, on() {},
      registerCommand(name, def) { commands.set(name, def.handler); } });
    await commands.get('qwen')('status', { cwd: process.cwd(), hasUI: true,
      sessionManager: { getSessionId: () => 'config-test' },
      ui: { notify(text) { console.log(JSON.stringify(text)); } } });
  `], { cwd: project, env: { ...env, ...overrides }, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("loads .env beside the installed extension when Pi runs in another project", async (t) => {
  const text = await status(t, [
    '# Extension settings',
    'export QWEN_PROXY_URL="http://proxy.example:8765/prepare" # comment',
    'QWEN_PROXY_PROJECT_ID=custom-project',
    "QWEN_PROXY_USER_ID='custom-user'",
    'QWEN_PROXY_ENABLED=0',
  ].join('\n'));
  assert.match(text, /^Qwen proxy off: http:\/\/proxy\.example:8765\/prepare/);
  assert.match(text, /Project: custom-project\nUser: custom-user/);
});

test("exported environment and CLI flags override extension .env settings", async (t) => {
  const dotenv = 'QWEN_PROXY_URL=http://file.example/prepare\nQWEN_PROXY_ENABLED=0\n';
  const env = { QWEN_PROXY_URL: 'http://shell.example/prepare', QWEN_PROXY_ENABLED: '1' };
  assert.match(await status(t, dotenv, env), /^Qwen proxy on: http:\/\/shell\.example\/prepare/);
  assert.match(await status(t, dotenv, env, { 'qwen-proxy-url': 'http://cli.example/prepare' }),
    /^Qwen proxy on: http:\/\/cli\.example\/prepare/);
});

test("missing extension .env keeps defaults and ignores the working directory .env", async (t) => {
  assert.match(await status(t), /^Qwen proxy on: http:\/\/127\.0\.0\.1:8765\/prepare/);
});
