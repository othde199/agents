import type { Env } from "./index";

type TreeItem = { path: string; type: string; size?: number; sha?: string };
type IndexedFile = { path: string; size: number; sha?: string; content?: string; imports: string[]; symbols: string[] };
export type RepositoryIndex = { repo: string; branch: string; generatedAt: string; files: IndexedFile[] };

type GithubFile = { content?: string; size?: number };

const EXCLUDED = /(node_modules|dist|build|coverage|\.git|\.next|vendor|\.lock$|\.map$)/i;
const CODE_FILE = /\.(tsx?|jsx?|vue|svelte|py|go|rs|java|kt|rb|php|cs|cpp|c|h|css|scss|html|md|json|ya?ml)$/i;

export async function buildRepositoryIndex(env: Env, branch: string, maxFiles = 80): Promise<RepositoryIndex> {
  const tree = await github(`/repos/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`, env) as { tree?: TreeItem[] };
  const candidates = (tree.tree ?? []).filter(item => item.type === "blob" && CODE_FILE.test(item.path) && !EXCLUDED.test(item.path) && (item.size ?? 0) <= 100000).slice(0, maxFiles);
  const files: IndexedFile[] = [];
  for (const item of candidates) {
    try {
      const file = await github(`/repos/${env.GITHUB_REPO}/contents/${githubPath(item.path)}?ref=${encodeURIComponent(branch)}`, env) as GithubFile;
      const content = file.content ? decodeGithub(file.content) : "";
      files.push({ path: item.path, size: item.size ?? content.length, sha: item.sha, content: content.slice(0, 18000), imports: extractImports(content), symbols: extractSymbols(content) });
    } catch { /* inaccessible or binary files are skipped */ }
  }
  return { repo: env.GITHUB_REPO, branch, generatedAt: new Date().toISOString(), files };
}

export function searchIndexedCode(index: RepositoryIndex, query: string): string {
  const terms = normalize(query).split(/\s+/).filter(term => term.length > 2);
  const ranked = index.files.map(file => {
    const haystack = normalize(`${file.path} ${file.content ?? ""} ${file.symbols.join(" ")}`);
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? (file.path.toLowerCase().includes(term) ? 4 : 1) : 0), 0);
    return { file, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
  if (!ranked.length) return `CODE SEARCH: موردی برای «${query}» در ایندکس پیدا نشد.`;
  return `CODE SEARCH برای «${query}» در ${index.repo}:\n${ranked.map(({ file, score }) => `- ${file.path} (امتیاز ${score})\n  symbols: ${file.symbols.slice(0, 12).join(", ") || "—"}\n  imports: ${file.imports.slice(0, 10).join(", ") || "—"}\n  excerpt: ${(findExcerpt(file.content ?? "", terms) || "بدون قطعه متنی").slice(0, 900)}`).join("\n")}`;
}

export function traceIndexedCode(index: RepositoryIndex, question: string): string {
  const terms = normalize(question).split(/\s+/).filter(term => term.length > 2);
  const relevant = index.files.map(file => ({ file, score: terms.reduce((n, term) => n + (normalize(`${file.path} ${file.content ?? ""}`).includes(term) ? 1 : 0), 0) })).filter(x => x.score).sort((a, b) => b.score - a.score).slice(0, 6).map(x => x.file);
  const nodes = new Set(relevant.map(file => file.path));
  for (const file of relevant) for (const imported of file.imports) {
    const target = resolveImport(file.path, imported, index.files.map(item => item.path));
    if (target) nodes.add(target);
  }
  return `PROGRAM TRACE برای «${question}» در ${index.repo}:\n${relevant.length ? relevant.map(file => `- ${file.path}\n  symbols: ${file.symbols.slice(0, 12).join(", ") || "—"}\n  imports: ${file.imports.slice(0, 12).join(", ") || "—"}`).join("\n") : "فایل مرتبطی پیدا نشد."}\n\nمسیرهای وابسته شناسایی‌شده:\n${[...nodes].map(path => `- ${path}`).join("\n") || "—"}\n\nاین trace استاتیک و مبتنی بر importها و متن کد است؛ اجرای runtime انجام نشده است.`;
}

function extractImports(content: string): string[] {
  const found = [...content.matchAll(/(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\s*\(|from\s+)["'`]([^"'`]+)["'`]/g)].map(match => match[1]);
  return [...new Set(found)].slice(0, 40);
}
function extractSymbols(content: string): string[] {
  const found = [...content.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
  return [...new Set(found)].slice(0, 80);
}
function resolveImport(source: string, imported: string, paths: string[]): string | undefined {
  if (!imported.startsWith(".")) return undefined;
  const base = source.split("/").slice(0, -1).join("/");
  const raw = `${base}/${imported}`.replace(/\/\.\//g, "/");
  return paths.find(path => path === raw || [".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", "/index.ts", "/index.js"].some(ext => path === raw + ext));
}
function findExcerpt(content: string, terms: string[]): string { const lines = content.split(/\r?\n/); const index = lines.findIndex(line => terms.some(term => normalize(line).includes(term))); return index < 0 ? "" : lines.slice(Math.max(0, index - 2), index + 5).join("\n"); }
function normalize(value: string): string { return value.toLowerCase().replace(/[“”’`"]+/g, "'").replace(/[^\p{L}\p{N}_./-]+/gu, " ").trim(); }
function githubPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function decodeGithub(value: string): string { const bytes = Uint8Array.from(atob(value.replace(/\s/g, "")), char => char.charCodeAt(0)); return new TextDecoder().decode(bytes); }
async function github(path: string, env: Env): Promise<unknown> { const response = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "telegram-github-agent" } }); if (!response.ok) throw new Error(`GitHub API ${response.status}`); return response.json(); }
