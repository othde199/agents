import type { Env } from "./index";

export async function runRepositorySkill(skill: "database-analyzer" | "documentation-generator" | "security-auditor", env: Env): Promise<string> {
  const tree = await github(`/repos/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(env.GITHUB_DEFAULT_BRANCH)}?recursive=1`, env) as { tree?: { path: string; type: string; size?: number }[] };
  const patterns = skill === "database-analyzer" ? /(schema|migration|\.sql$|prisma|drizzle|supabase|firebase)/i : skill === "documentation-generator" ? /(README|docs\/|openapi|swagger|package\.json|\.md$)/i : /(src\/|api|server|auth|security|\.env|wrangler|package\.json)/i;
  const paths = (tree.tree ?? []).filter(item => item.type === "blob" && (item.size ?? 0) < 30000 && patterns.test(item.path) && !/(node_modules|dist|build|\.lock$)/i.test(item.path)).slice(0, 16);
  const files: string[] = [];
  for (const item of paths.slice(0, 8)) {
    try { const file = await github(`/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(item.path)}?ref=${encodeURIComponent(env.GITHUB_DEFAULT_BRANCH)}`, env) as { content: string }; files.push(`FILE: ${item.path}\n${decode(file.content).slice(0, 7000)}`); } catch { /* continue */ }
  }
  const supabase = skill === "database-analyzer" ? await supabaseContext(env) : "";
  return `SKILL: ${skill}\nREPOSITORY: ${env.GITHUB_REPO}\nFILES:\n${paths.map(item => item.path).join("\n")}\n\nCONTENT:\n${files.join("\n\n")}\n${supabase}`;
}

async function supabaseContext(env: Env): Promise<string> {
  const key = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) return "SUPABASE: متصل نیست؛ فقط فایل‌های schema و migration تحلیل شدند.";
  try {
    const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    return response.ok ? "SUPABASE: اتصال برقرار شد؛ metadata endpoint در دسترس است. داده‌های رکوردی خوانده نشد." : `SUPABASE: اتصال ناموفق HTTP ${response.status}`;
  } catch { return "SUPABASE: اتصال ناموفق بود؛ تحلیل فایل‌های ریپو ادامه یافت."; }
}

async function github(path: string, env: Env): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "telegram-github-agent" } });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}
function decode(value: string): string { try { return decodeURIComponent(escape(atob(value))); } catch { return atob(value); } }
