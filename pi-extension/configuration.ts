import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function loadEnvironment(): NodeJS.ProcessEnv {
  let local: Record<string, string> = {};
  try {
    local = parseEnv(readFileSync(new URL(".env", import.meta.url), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Keep settings local to this extension so /reload can reread the file.
  const settings = Object.fromEntries(Object.entries(local).filter(([key]) => key.startsWith("QWEN_PROXY_")));
  return { ...settings, ...process.env };
}
