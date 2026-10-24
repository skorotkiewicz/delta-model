import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export type Check = { command: string; success: boolean; output: string };
export type ProjectContext = {
  files: { path: string; content: string }[];
  errors: string[];
  checks: Check[];
  active_tools: string[];
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".css", ".html", ".md", ".json", ".toml", ".yaml", ".yml", ".sql", ".sh", ".txt"]);
const isCheck = (command: string) => /\b(?:pytest|unittest|vitest|jest)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint)\b|\b(?:cargo|go)\s+test\b|\bjust\s+(?:test|check|vet)\b/.test(command);

export function identities(cwd: string) {
  return {
    project_id: process.env.QWEN_PROXY_PROJECT_ID || `project_${hash(resolve(cwd)).slice(0, 64)}`,
    user_id: process.env.QWEN_PROXY_USER_ID || `user_${hash(hostname() + "\0" + userInfo().username).slice(0, 64)}`,
  };
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

export class ProjectContextCollector {
  private recentFiles: string[] = [];
  private errors: string[] = [];
  private recentChecks: Check[] = [];
  private turnFiles = new Set<string>();
  private turnChecks: Check[] = [];
  private calls = new Map<string, { name: string; args: Record<string, unknown> }>();

  reset() {
    this.recentFiles = [];
    this.errors = [];
    this.recentChecks = [];
    this.beginTurn();
  }

  beginTurn() {
    this.turnFiles.clear();
    this.turnChecks = [];
    this.calls.clear();
  }

  toolStart(id: string, name: string, args: Record<string, unknown>) {
    if (this.calls.size >= 64) this.calls.delete(this.calls.keys().next().value!);
    this.calls.set(id, { name, args });
  }

  toolEnd(id: string, name: string, result: unknown, isError: boolean) {
    const call = this.calls.get(id);
    this.calls.delete(id);
    const output = contentText((result as { content?: unknown })?.content);
    const path = call?.args.path;
    if (["read", "write", "edit"].includes(name) && typeof path === "string" && !isError) {
      this.recentFiles = [path, ...this.recentFiles.filter((old) => old !== path)].slice(0, 12);
      this.turnFiles.add(path);
    }
    if (isError && output.trim()) this.errors = [...this.errors, `${name}: ${output.slice(-950)}`].slice(-3);
    const command = call?.args.command;
    if (["bash", "powershell"].includes(name) && typeof command === "string" && isCheck(command)) {
      const check = { command: command.slice(0, 500), success: !isError, output: output.slice(-1000) };
      this.recentChecks = [...this.recentChecks.filter((old) => old.command !== check.command), check].slice(-3);
      this.turnChecks = [...this.turnChecks, check].slice(-3);
    }
  }

  outcome(cwd: string) {
    return {
      files: [...this.turnFiles].map((path) => relative(cwd, resolve(cwd, path)).split(sep).join("/"))
        .filter((path) => path && !path.startsWith("../") && path.length <= 240).slice(0, 12),
      checks: this.turnChecks,
    };
  }

  async collect(cwd: string, prompt: string, activeTools: string[] = []): Promise<ProjectContext> {
    if (process.env.QWEN_PROXY_CONTEXT === "0") return { files: [], errors: [], checks: [], active_tools: [] };
    const base = { files: [], errors: [...this.errors], checks: [...this.recentChecks], active_tools: activeTools.slice(0, 64) };
    const mentioned = prompt.match(/(?:[\w@.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|py|rs|go|java|css|html|md|json|toml|ya?ml|sql|sh|txt)\b/g) || [];
    const candidates = [...new Set([...mentioned, ...this.recentFiles,
      "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"])];
    const files: ProjectContext["files"] = [];
    let root: string;
    try { root = await realpath(cwd); } catch { return base; }
    for (const candidate of candidates) {
      if (files.length >= 3) break;
      const absolute = resolve(root, candidate);
      const path = relative(root, absolute);
      if (!path || isAbsolute(path) || path.startsWith(".." + sep) ||
          path.split(sep).some((part) => part.startsWith(".") || ["node_modules", "dist", "target"].includes(part)) ||
          !TEXT_EXTENSIONS.has(extname(path)) && path !== "go.mod") continue;
      let handle;
      try {
        const actual = await realpath(absolute);
        if (actual !== absolute) continue; // Skip symlinks, including parent-directory links.
        const info = await stat(actual);
        if (!info.isFile() || info.size > 64 * 1024) continue;
        handle = await open(actual, "r");
        const buffer = Buffer.alloc(Math.min(info.size, 8192));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
        if (text.includes("\0") || !text.trim()) continue;
        let excerpt = text;
        if (text.length > 1800) {
          const terms = prompt.toLowerCase().match(/\w{3,}/g) || [];
          const lines = text.split("\n");
          const score = (line: string) => terms.filter((term) => line.toLowerCase().includes(term)).length;
          let best = 0;
          for (let i = 1; i < lines.length; i++) if (score(lines[i]) > score(lines[best])) best = i;
          excerpt = lines.slice(Math.max(0, best - 3), best + 15).join("\n").slice(0, 1800);
        }
        files.push({ path: path.split(sep).join("/"), content: excerpt });
      } catch { /* Missing, non-text or unreadable files are optional context. */ }
      finally { await handle?.close(); }
    }
    return { files, errors: [...this.errors], checks: [...this.recentChecks], active_tools: activeTools.slice(0, 64) };
  }
}
