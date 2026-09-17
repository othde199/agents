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
  BOT_STATE: DurableObjectNamespace;
}

type TelegramUpdate = { message?: { chat: { id: number }; text?: string; from?: { id: number } } };
type GithubFile = { content: string; sha: string; encoding: string; size: number };
type ConversationMessage = { role: "user" | "assistant"; content: string };

const HELP = `من یک ایجنت هوش مصنوعی هستم و می‌توانم درباره پروژه، برنامه‌نویسی و موضوعات عمومی پاسخ بدهم. برای اطلاعات جدید، وب را هم جست‌وجو می‌کنم و تاریخچه کوتاه مکالمه را به خاطر می‌سپارم.\n\nدستورات مدیریتی:\n/status — وضعیت اتصال\n/repo — ریپوزیتوری فعال\n/ask <سؤال> — سؤال از ایجنت\n/edit <درخواست> — تحلیل و ثبت تغییر کد\n/clear — پاک‌کردن حافظه مکالمه\n/stop — توقف پاسخ‌گویی\n/resume — ادامه فعالیت\n\nمی‌توانید سؤال را بدون /ask هم بفرستید.`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, service: "telegram-github-agent" });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/setup-webhook") return setupWebhook(url, env);
    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") return new Response("Not found", { status: 404 });
    if (env.TELEGRAM_WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
    const update = (await request.json()) as TelegramUpdate;
    const chatId = update.message?.chat.id;
    const text = update.message?.text?.trim();
    if (!chatId || !text || !isAllowedChat(chatId, env.ALLOWED_CHAT_IDS)) return json({ ok: true });
    const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
    if (text === "/stop") {
      await state.fetch("https://bot-state/stop", { method: "POST" });
      await sendTelegram(chatId, "⏸ ربات متوقف شد. برای ادامه /resume را بفرستید.", env);
      return json({ ok: true });
    }
    if (text === "/resume" || text === "/start") {
      await state.fetch("https://bot-state/resume", { method: "POST" });
      if (text === "/resume") {
        await sendTelegram(chatId, "▶️ ربات دوباره فعال شد.", env);
        return json({ ok: true });
      }
    }
    const stopped = (await (await state.fetch("https://bot-state/status")).json()) as { stopped?: boolean };
    if (stopped.stopped) return json({ ok: true });
    try { await handleMessage(chatId, text, env); } catch (error) {
      console.error("telegram handler failed", error);
      await sendTelegram(chatId, "❌ اجرای درخواست شکست خورد. لاگ Worker را بررسی کنید.", env);
    }
    return json({ ok: true });
  }
};

async function setupWebhook(url: URL, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get("key") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const webhookUrl = `${url.origin}/telegram/webhook`;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: webhookUrl, secret_token: env.TELEGRAM_WEBHOOK_SECRET }) });
  return json({ webhookUrl, telegram: await response.json() });
}

async function handleMessage(chatId: number, text: string, env: Env): Promise<void> {
  if (text === "/start" || text === "/help") return sendTelegram(chatId, HELP, env);
  if (text === "/status") return sendTelegram(chatId, `✅ فعال\nریپو: ${env.GITHUB_REPO}\nشاخه: ${env.GITHUB_DEFAULT_BRANCH}\nمدل: ${env.AI_MODEL ?? "پیش‌فرض"}`, env);
  if (text === "/repo") return sendTelegram(chatId, `ریپوزیتوری فعال: https://github.com/${env.GITHUB_REPO}\nشاخه: ${env.GITHUB_DEFAULT_BRANCH}`, env);
  if (text === "/clear") return clearConversation(chatId, env);
  if (text === "/ask") return sendTelegram(chatId, "سؤال را بعد از /ask بنویسید.\nمثال: /ask ساختار این پروژه چیست؟", env);
  if (text.startsWith("/ask ")) return agentReply(chatId, text.slice(5).trim(), env);
  if (text === "/edit") return sendTelegram(chatId, "درخواست تغییر را بعد از /edit بنویسید.", env);
  if (text.startsWith("/edit ")) return editCode(chatId, text.slice(6).trim(), env);
  return agentReply(chatId, text, env);
}

async function agentReply(chatId: number, question: string, env: Env): Promise<void> {
  if (!question) return sendTelegram(chatId, "سؤال خالی است.", env);
  await sendTelegram(chatId, "⏳ در حال فکر کردن...", env);
  const repoContext = needsRepo(question) ? await projectContext(env) : "";
  const webContext = needsWeb(question) ? await webSearch(question) : "";
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  const history = await readHistory(state);
  const prompt = `تو یک ایجنت عمومی و دستیار برنامه‌نویسی هستی. به فارسی و دقیق جواب بده؛ اگر سؤال انگلیسی بود می‌توانی انگلیسی جواب بدهی. اگر اطلاعات کافی نیست صادقانه بگو. از context زیر استفاده کن و ادعای بدون منبع نکن.\n\n${repoContext}\n${webContext}\nسؤال کاربر: ${question}`;
  const answer = await ai(env, prompt, history);
  await appendHistory(state, { role: "user", content: question }, { role: "assistant", content: answer });
  return sendTelegram(chatId, answer, env);
}

async function readHistory(state: DurableObjectStub): Promise<ConversationMessage[]> {
  const response = await state.fetch("https://bot-state/history");
  const data = (await response.json()) as { history?: ConversationMessage[] };
  return Array.isArray(data.history) ? data.history : [];
}

async function appendHistory(state: DurableObjectStub, user: ConversationMessage, assistant: ConversationMessage): Promise<void> {
  await state.fetch("https://bot-state/history", { method: "POST", body: JSON.stringify({ user, assistant }) });
}

async function clearConversation(chatId: number, env: Env): Promise<void> {
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  await state.fetch("https://bot-state/clear", { method: "POST" });
  return sendTelegram(chatId, "🧹 حافظه مکالمه پاک شد.", env);
}

function needsRepo(question: string): boolean { return /پروژه|ریپو|کد|فایل|گیت.?هاب|repo|code|file|github|worker|agents|package|wrangler|typescript|javascript|ساختار/i.test(question); }
function needsWeb(question: string): boolean { return /اینترنت|وب|جست.?جو|آخرین|جدیدترین|امروز|قیمت|خبر|نسخه جدید|مستندات|internet|web|search|latest|today|news|price|documentation|۲۰۲|202[4-9]|https?:\/\//i.test(question); }

async function projectContext(env: Env): Promise<string> {
  const tree = await github(`/repos/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(env.GITHUB_DEFAULT_BRANCH)}?recursive=1`, env) as { tree?: { path: string; type: string }[] };
  const files = (tree.tree ?? []).filter(x => x.type === "blob").map(x => x.path);
  const selected = files.filter(path => /(^|\/)(README|package\.json|wrangler\.jsonc?|tsconfig\.json|src\/index\.ts|src\/agent\.ts|\.md$)/i.test(path)).slice(0, 6);
  const snippets: string[] = [];
  for (const path of selected) {
    try {
      const file = await github(`/repos/${env.GITHUB_REPO}/contents/${githubPath(path)}?ref=${encodeURIComponent(env.GITHUB_DEFAULT_BRANCH)}`, env) as GithubFile;
      if (file.content && file.size < 30000) snippets.push(`FILE: ${path}\n${decodeGithub(file.content)}`);
    } catch { /* continue with other files */ }
  }
  return `PROJECT FILE LIST:\n${files.slice(0, 120).join("\n")}\n\nRELEVANT FILES:\n${snippets.join("\n\n")}`;
}

async function webSearch(question: string): Promise<string> {
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(question)}`, { headers: { "user-agent": "telegram-github-agent/1.0" } });
    const html = await response.text();
    const results = [...html.matchAll(/result__a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 5).map(match => `${stripHtml(match[2])}: ${match[1]}`);
    return results.length ? `WEB SEARCH RESULTS (verify before relying):\n${results.join("\n")}` : "WEB SEARCH: no results found";
  } catch { return "WEB SEARCH: unavailable; پاسخ را بر اساس دانش عمومی بده و بگو جست‌وجوی زنده در دسترس نبود."; }
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
  const result = await github(`/repos/${env.GITHUB_REPO}/contents/${filePath}`, env, { method: "PUT", body: JSON.stringify({ message: `feat(bot): ${parsed.summary ?? "update requested from Telegram"}`.slice(0, 120), content: btoa(unescape(encodeURIComponent(parsed.content))), sha: current.sha, branch: env.GITHUB_DEFAULT_BRANCH }) }) as { commit?: { html_url?: string } };
  return sendTelegram(chatId, `✅ تغییر در گیت‌هاب ثبت شد.\nفایل: ${parsed.path}\n${parsed.summary ?? ""}\nCommit: ${result.commit?.html_url ?? "ثبت شد"}`, env);
}

async function ai(env: Env, prompt: string, history: ConversationMessage[] = []): Promise<string> {
  const messages = [{ role: "system" as const, content: "تو یک دستیار مفید هستی. هرگز secret تولید یا افشا نکن." }, ...history, { role: "user" as const, content: prompt }];
  const result = await env.AI.run(env.AI_MODEL ?? "@cf/meta/llama-3.2-1b-instruct", { messages, max_tokens: 1200 }) as { response?: string };
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
function stripHtml(value: string): string { return value.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").trim(); }
function githubPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function decodeGithub(value: string): string { const bytes = Uint8Array.from(atob(value.replace(/\s/g, "")), char => char.charCodeAt(0)); return new TextDecoder().decode(bytes); }
function json(value: unknown, init?: ResponseInit): Response { return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) } }); }

export class BotState {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/stop") await this.state.storage.put("stopped", true);
    if (path === "/resume") await this.state.storage.put("stopped", false);
    if (path === "/clear") await this.state.storage.delete("history");
    if (path === "/history" && request.method === "POST") {
      const body = await request.json() as { user?: ConversationMessage; assistant?: ConversationMessage };
      const history = (await this.state.storage.get<ConversationMessage[]>("history")) ?? [];
      if (body.user?.content && body.assistant?.content) {
        history.push({ role: "user", content: body.user.content.slice(0, 4000) }, { role: "assistant", content: body.assistant.content.slice(0, 4000) });
        await this.state.storage.put("history", history.slice(-12));
      }
    }
    if (path === "/history" && request.method === "GET") return json({ history: (await this.state.storage.get<ConversationMessage[]>("history")) ?? [] });
    return json({ stopped: (await this.state.storage.get<boolean>("stopped")) ?? false });
  }
}
