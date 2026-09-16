export interface Env {
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  GITHUB_DEFAULT_BRANCH: string;
  AI_MODEL?: string;
  MAX_FILE_BYTES?: string;
  ALLOWED_CHAT_IDS?: string;
}

type TelegramUpdate = {
  message?: { chat: { id: number }; text?: string; from?: { id: number } };
};

type GithubFile = { content: string; sha: string; encoding: string; size: number };

const HELP = `دستورات ربات:\n/status — وضعیت اتصال\n/repo — ریپوزیتوری فعال\n/ask <سؤال> — پرسش درباره کد\n/edit <درخواست> — پیشنهاد تغییر و ساخت commit\n\nنمونه:\n/edit فایل agent-think/src/index.ts را طوری تغییر بده که ...`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, service: "telegram-github-agent" });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") return new Response("Not found", { status: 404 });
    if (env.TELEGRAM_WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
    const update = (await request.json()) as TelegramUpdate;
    const chatId = update.message?.chat.id;
    const text = update.message?.text?.trim();
    if (!chatId || !text) return json({ ok: true });
    if (!isAllowedChat(chatId, env.ALLOWED_CHAT_IDS)) return json({ ok: true });
    try {
      await handleMessage(chatId, text, env);
    } catch (error) {
      console.error("telegram handler failed", error);
      await sendTelegram(chatId, "❌ اجرای درخواست شکست خورد. لاگ Worker را بررسی کنید.", env);
    }
    return json({ ok: true });
  }
};

async function handleMessage(chatId: number, text: string, env: Env): Promise<void> {
  if (text === "/start" || text === "/help") return sendTelegram(chatId, HELP, env);
  if (text === "/status") return sendTelegram(chatId, `✅ فعال\nریپو: ${env.GITHUB_REPO}\nشاخه: ${env.GITHUB_DEFAULT_BRANCH}\nمدل: ${env.AI_MODEL ?? "پیش‌فرض"}`, env);
  if (text === "/repo") return sendTelegram(chatId, `ریپوزیتوری فعال: https://github.com/${env.GITHUB_REPO}\nشاخه: ${env.GITHUB_DEFAULT_BRANCH}`, env);
  if (text.startsWith("/ask ")) return askCode(chatId, text.slice(5).trim(), env);
  if (text.startsWith("/edit ")) return editCode(chatId, text.slice(6).trim(), env);
  return sendTelegram(chatId, "دستور ناشناخته است. /help را بزنید.", env);
}

async function askCode(chatId: number, question: string, env: Env): Promise<void> {
  if (!question) return sendTelegram(chatId, "سؤال را بعد از /ask بنویسید.", env);
  await sendTelegram(chatId, "⏳ در حال بررسی فایل‌های ریپو...", env);
  const tree = await github(`/repos/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(env.GITHUB_DEFAULT_BRANCH)}?recursive=1`, env) as { tree?: { path: string; type: string }[] };
  const paths = (tree.tree ?? []).filter(x => x.type === "blob").slice(0, 80).map(x => x.path).join("\n");
  const answer = await ai(env, `به فارسی کوتاه و دقیق پاسخ بده. این فهرست فایل‌های ریپو است:\n${paths}\n\nسؤال کاربر: ${question}`);
  return sendTelegram(chatId, answer, env);
}

async function editCode(chatId: number, instruction: string, env: Env): Promise<void> {
  if (!instruction) return sendTelegram(chatId, "درخواست تغییر را بعد از /edit بنویسید.", env);
  await sendTelegram(chatId, "⏳ در حال تحلیل درخواست و آماده‌سازی تغییر...", env);
  const plan = await ai(env, `تو برنامه‌نویس ارشد هستی. فقط JSON معتبر برگردان با این شکل: {"path":"مسیر نسبی فایل","content":"کل محتوای جدید فایل","summary":"خلاصه فارسی"}. اگر درخواست مبهم است path را خالی بگذار. ریپو: ${env.GITHUB_REPO}. درخواست: ${instruction}`);
  let parsed: { path?: string; content?: string; summary?: string };
  try { parsed = JSON.parse(stripFences(plan)); } catch { return sendTelegram(chatId, `نتوانستم خروجی ساختاریافته بسازم.\n${plan.slice(0, 2500)}`, env); }
  if (!parsed.path || typeof parsed.content !== "string") return sendTelegram(chatId, "درخواست مبهم است؛ نام دقیق فایل و تغییر موردنظر را بنویسید.", env);
  if (!safePath(parsed.path) || parsed.content.length > Number(env.MAX_FILE_BYTES ?? 120000)) return sendTelegram(chatId, "این مسیر یا اندازه فایل مجاز نیست.", env);
  const filePath = githubPath(parsed.path);
  const current = await github(`/repos/${env.GITHUB_REPO}/contents/${filePath}?ref=${encodeURIComponent(env.GITHUB_DEFAULT_BRANCH)}`, env) as GithubFile;
  const result = await github(`/repos/${env.GITHUB_REPO}/contents/${filePath}`, env, {
    method: "PUT",
    body: JSON.stringify({ message: `feat(bot): ${parsed.summary ?? "update requested from Telegram"}`.slice(0, 120), content: btoa(unescape(encodeURIComponent(parsed.content))), sha: current.sha, branch: env.GITHUB_DEFAULT_BRANCH })
  }) as { commit?: { html_url?: string } };
  return sendTelegram(chatId, `✅ تغییر در گیت‌هاب ثبت شد.\nفایل: ${parsed.path}\n${parsed.summary ?? ""}\nCommit: ${result.commit?.html_url ?? "ثبت شد"}`, env);
}

async function ai(env: Env, prompt: string): Promise<string> {
  const result = await env.AI.run(env.AI_MODEL ?? "@cf/meta/llama-3.2-1b-instruct", { messages: [{ role: "system", content: "پاسخ کوتاه بده و هرگز secret تولید یا افشا نکن." }, { role: "user", content: prompt }], max_tokens: 1200 }) as { response?: string };
  return result.response ?? "پاسخی دریافت نشد.";
}

async function github(path: string, env: Env, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "telegram-github-agent", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}

async function sendTelegram(chatId: number, text: string, env: Env): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }) });
}

function isAllowedChat(chatId: number, allow?: string): boolean { return !allow || allow.split(",").map(x => x.trim()).includes(String(chatId)); }
function safePath(path: string): boolean { return path.length > 0 && path.length < 240 && !path.startsWith("/") && !path.includes("..") && !path.startsWith(".github/workflows/") && !path.endsWith(".env"); }
function stripFences(value: string): string { return value.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim(); }
function githubPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function json(value: unknown, init?: ResponseInit): Response { return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) } }); }
