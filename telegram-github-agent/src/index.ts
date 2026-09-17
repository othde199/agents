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
type GithubRepo = { full_name: string; private: boolean; html_url: string; default_branch?: string; archived?: boolean };
type ConversationMessage = { role: "user" | "assistant"; content: string };
type ProjectMemory = { history: ConversationMessage[]; summary: string; preferences: string[] };
type MemoryStore = { activeProject: string; repo?: string; projects: Record<string, ProjectMemory> };

const HELP = `🤖 Agent Think — نسخه Free\n\nپیام را مستقیم بفرست؛ Agent خودش تصمیم می‌گیرد آیا بررسی پروژه یا جست‌وجوی وب لازم است.\n\nدستورات اصلی:\n/ask <سؤال> — پرسش از ایجنت\n/search <عبارت> — جست‌وجوی اجباری وب\n/repos — نمایش همه ریپوهای قابل‌دسترسی GitHub\n/repo owner/name — ذخیره ریپو برای زمینه پاسخ\n/repo — نمایش ریپوی ذخیره‌شده\n/status — وضعیت Worker\n\nمدیریت حافظه:\n/project <نام> — انتخاب حافظه جدا برای پروژه\n/remember <نکته> — ذخیره ترجیح در حافظه بلندمدت\n/history <عبارت> — جست‌وجو در تاریخچه مکالمه\n/clear-memory — پاک‌کردن حافظه پروژه فعال\n/clear — پاک‌کردن ریپوی ذخیره‌شده؛ ریپوزیتوری GitHub حذف نمی‌شود\n\nکنترل ربات:\n/stop — توقف پاسخ‌گویی\n/resume — ادامه فعالیت\n/help — نمایش این راهنما\n\nبرای تغییر کد، از /edit <درخواست> استفاده کنید.`;

const TELEGRAM_COMMANDS = [
  { command: "start", description: "شروع و نمایش راهنما" },
  { command: "help", description: "نمایش راهنمای کامل" },
  { command: "ask", description: "پرسش از ایجنت" },
  { command: "search", description: "جست‌وجوی اجباری وب" },
  { command: "repos", description: "نمایش همه ریپوهای GitHub" },
  { command: "repo", description: "نمایش یا ذخیره ریپو" },
  { command: "status", description: "وضعیت Worker" },
  { command: "project", description: "انتخاب پروژه و حافظه جدا" },
  { command: "remember", description: "ذخیره ترجیح در حافظه" },
  { command: "history", description: "جست‌وجو در تاریخچه" },
  { command: "clear", description: "پاک‌کردن ریپوی ذخیره‌شده" },
  { command: "clear_memory", description: "پاک‌کردن حافظه مکالمه" },
  { command: "stop", description: "توقف پاسخ‌گویی" },
  { command: "resume", description: "ادامه فعالیت" },
  { command: "edit", description: "درخواست تغییر کد" }
];

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
  const webhookResult = await response.json();
  const commandsResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commands: TELEGRAM_COMMANDS }) });
  const menuResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setChatMenuButton`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ menu_button: { type: "commands" } }) });
  return json({ webhookUrl, telegram: webhookResult, commands: await commandsResponse.json(), menu: await menuResponse.json() });
}

async function handleMessage(chatId: number, text: string, env: Env): Promise<void> {
  if (text === "/start" || text === "/help") return sendTelegram(chatId, HELP, env);
  if (text === "/status") return sendTelegram(chatId, `✅ فعال\nریپو: ${env.GITHUB_REPO}\nشاخه: ${env.GITHUB_DEFAULT_BRANCH}\nمدل: ${env.AI_MODEL ?? "پیش‌فرض"}`, env);
  if (text === "/repo") return showRepo(chatId, env);
  if (text.startsWith("/repo ")) return saveRepo(chatId, text.slice(6).trim(), env);
  if (text === "/repos") return listRepositories(chatId, env);
  if (text === "/project") return sendTelegram(chatId, "نام پروژه را بعد از /project بنویسید.\nمثال: /project ربات تلگرام", env);
  if (text.startsWith("/project ")) return switchProject(chatId, text.slice(9).trim(), env);
  if (text === "/remember") return sendTelegram(chatId, "نکته یا ترجیح را بعد از /remember بنویسید.", env);
  if (text.startsWith("/remember ")) return rememberPreference(chatId, text.slice(10).trim(), env);
  if (text === "/search") return sendTelegram(chatId, "عبارت جست‌وجو را بعد از /search بنویسید.", env);
  if (text.startsWith("/search ")) return forcedWebSearch(chatId, text.slice(8).trim(), env);
  if (text === "/history") return sendTelegram(chatId, "عبارت جست‌وجو را بعد از /history بنویسید.", env);
  if (text.startsWith("/history ")) return searchHistory(chatId, text.slice(9).trim(), env);
  if (text === "/clear") return clearSavedRepo(chatId, env);
  if (text === "/clear-memory" || text === "/clear_memory") return clearConversation(chatId, env);
  if (text === "/ask") return sendTelegram(chatId, "سؤال را بعد از /ask بنویسید.\nمثال: /ask ساختار این پروژه چیست؟", env);
  if (text.startsWith("/ask ")) return agentReply(chatId, text.slice(5).trim(), env);
  if (text === "/edit") return sendTelegram(chatId, "درخواست تغییر را بعد از /edit بنویسید.", env);
  if (text.startsWith("/edit ")) return editCode(chatId, text.slice(6).trim(), env);
  return agentReply(chatId, text, env);
}

async function agentReply(chatId: number, question: string, env: Env): Promise<void> {
  if (!question) return sendTelegram(chatId, "سؤال خالی است.", env);
  await sendTelegram(chatId, "⏳ در حال فکر کردن...", env);
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  const memory = await readMemory(state);
  const activeEnv = memory.repo ? { ...env, GITHUB_REPO: memory.repo } : env;
  const repoContext = needsRepo(question) ? await projectContext(activeEnv) : "";
  const webContext = needsWeb(question) ? await webSearch(question) : "";
  const prompt = `تو یک ایجنت عمومی و دستیار برنامه‌نویسی هستی. به فارسی و دقیق جواب بده؛ اگر سؤال انگلیسی بود می‌توانی انگلیسی جواب بدهی. اگر اطلاعات کافی نیست صادقانه بگو. از context زیر و حافظه استفاده کن.\n\nریپوی زمینه: ${activeEnv.GITHUB_REPO}\nپروژه فعال: ${memory.activeProject}\nخلاصه حافظه: ${memory.project.summary}\nترجیحات کاربر: ${memory.project.preferences.join(" | ")}\n${repoContext}\n${webContext}\nسؤال کاربر: ${question}`;
  const answer = await ai(env, prompt, memory.project.history);
  await appendMemory(state, { role: "user", content: question }, { role: "assistant", content: answer });
  return sendTelegram(chatId, answer, env);
}

async function readMemory(state: DurableObjectStub): Promise<{ activeProject: string; repo?: string; project: ProjectMemory }> {
  const response = await state.fetch("https://bot-state/memory");
  return await response.json() as { activeProject: string; repo?: string; project: ProjectMemory };
}

async function appendMemory(state: DurableObjectStub, user: ConversationMessage, assistant: ConversationMessage): Promise<void> {
  await state.fetch("https://bot-state/memory", { method: "POST", body: JSON.stringify({ user, assistant }) });
}

async function clearConversation(chatId: number, env: Env): Promise<void> {
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  await state.fetch("https://bot-state/clear", { method: "POST" });
  return sendTelegram(chatId, "🧹 حافظه پروژه فعال پاک شد.", env);
}

async function showRepo(chatId: number, env: Env): Promise<void> {
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  const data = await (await state.fetch("https://bot-state/repo")).json() as { repo?: string };
  return sendTelegram(chatId, `ریپوزیتوری متصل: ${data.repo ?? env.GITHUB_REPO}\n\nبرای ذخیره ریپو: /repo owner/name\nبرای پاک‌کردن ریپوی ذخیره‌شده: /clear`, env);
}

async function listRepositories(chatId: number, env: Env): Promise<void> {
  await sendTelegram(chatId, "⏳ در حال دریافت فهرست ریپوهای GitHub...", env);
  const repositories: GithubRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await github(`/user/repos?per_page=100&page=${page}&sort=updated&direction=desc`, env) as GithubRepo[];
    repositories.push(...batch);
    if (batch.length < 100) break;
  }
  if (!repositories.length) return sendTelegram(chatId, "هیچ ریپویی با این GitHub Token پیدا نشد.", env);
  const lines = repositories.map((repo, index) => `${index + 1}. ${repo.private ? "🔒 خصوصی" : "🌐 عمومی"} ${repo.full_name}${repo.archived ? " (archived)" : ""}\n${repo.html_url}`);
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += 15) chunks.push(lines.slice(index, index + 15).join("\n\n"));
  for (let index = 0; index < chunks.length; index++) await sendTelegram(chatId, `📚 ریپوهای قابل‌دسترسی (${index + 1}/${chunks.length})\n\n${chunks[index]}`, env);
}

async function saveRepo(chatId: number, repo: string, env: Env): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return sendTelegram(chatId, "فرمت ریپو باید owner/name باشد.\nمثال: /repo othde199/agents", env);
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  await state.fetch("https://bot-state/repo", { method: "POST", body: JSON.stringify({ repo }) });
  return sendTelegram(chatId, `✅ ریپو برای زمینه پاسخ ذخیره شد:\nhttps://github.com/${repo}`, env);
}

async function clearSavedRepo(chatId: number, env: Env): Promise<void> {
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  await state.fetch("https://bot-state/repo", { method: "DELETE" });
  return sendTelegram(chatId, "🧹 ریپوی ذخیره‌شده پاک شد. خود ریپوزیتوری GitHub حذف نشده است و حافظه مکالمه هم باقی می‌ماند.", env);
}

async function forcedWebSearch(chatId: number, query: string, env: Env): Promise<void> {
  if (!query) return sendTelegram(chatId, "عبارت جست‌وجو را بعد از /search بنویسید.", env);
  await sendTelegram(chatId, "🌐 در حال جست‌وجوی وب...", env);
  const results = await webSearch(query);
  const answer = await ai(env, `با استفاده از نتایج جست‌وجوی زیر، به فارسی دقیق پاسخ بده. اگر نتیجه کافی نیست صادقانه بگو.\n${results}\nسؤال: ${query}`);
  return sendTelegram(chatId, answer, env);
}

async function switchProject(chatId: number, name: string, env: Env): Promise<void> {
  if (!name) return sendTelegram(chatId, "نام پروژه خالی است.", env);
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  await state.fetch("https://bot-state/project", { method: "POST", body: JSON.stringify({ name }) });
  return sendTelegram(chatId, `📁 پروژه فعال شد: ${name}\nحافظه این پروژه جداست.`, env);
}

async function rememberPreference(chatId: number, note: string, env: Env): Promise<void> {
  if (!note) return sendTelegram(chatId, "نکته خالی است.", env);
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  await state.fetch("https://bot-state/preference", { method: "POST", body: JSON.stringify({ note }) });
  return sendTelegram(chatId, "🧠 در حافظه بلندمدت ذخیره شد.", env);
}

async function searchHistory(chatId: number, query: string, env: Env): Promise<void> {
  if (!query) return sendTelegram(chatId, "عبارت جست‌وجو خالی است.", env);
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  const data = await (await state.fetch("https://bot-state/search", { method: "POST", body: JSON.stringify({ query }) })).json() as { results?: ConversationMessage[] };
  const results = data.results ?? [];
  return sendTelegram(chatId, results.length ? `🔎 نتایج حافظه:\n${results.map(item => `${item.role === "user" ? "شما" : "ربات"}: ${item.content}`).join("\n\n").slice(0, 3800)}` : "نتیجه‌ای در حافظه پیدا نشد.", env);
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
    const store = await this.getStore();
    if (path === "/clear") {
      store.projects[store.activeProject] = emptyProject();
      await this.state.storage.put("memory", store);
    }
    if (path === "/repo" && request.method === "POST") {
      const body = await request.json() as { repo?: string };
      store.repo = body.repo?.trim();
      await this.state.storage.put("memory", store);
    }
    if (path === "/repo" && request.method === "DELETE") {
      delete store.repo;
      await this.state.storage.put("memory", store);
    }
    if (path === "/repo" && request.method === "GET") return json({ repo: store.repo });
    if (path === "/project" && request.method === "POST") {
      const body = await request.json() as { name?: string };
      if (body.name?.trim()) {
        store.activeProject = cleanProjectName(body.name);
        store.projects[store.activeProject] ??= emptyProject();
        await this.state.storage.put("memory", store);
      }
    }
    if (path === "/preference" && request.method === "POST") {
      const body = await request.json() as { note?: string };
      if (body.note?.trim()) {
        const project = store.projects[store.activeProject] ??= emptyProject();
        project.preferences = [...project.preferences, body.note.trim().slice(0, 500)].slice(-20);
        await this.state.storage.put("memory", store);
      }
    }
    if (path === "/memory" && request.method === "GET") return json({ activeProject: store.activeProject, repo: store.repo, project: store.projects[store.activeProject] });
    if (path === "/memory" && request.method === "POST") {
      const body = await request.json() as { user?: ConversationMessage; assistant?: ConversationMessage };
      const project = store.projects[store.activeProject] ??= emptyProject();
      if (body.user?.content && body.assistant?.content) {
        project.history.push({ role: "user", content: body.user.content.slice(0, 4000) }, { role: "assistant", content: body.assistant.content.slice(0, 4000) });
        if (project.history.length > 12) {
          const old = project.history.splice(0, project.history.length - 8);
          project.summary = `${project.summary}\n${old.map(item => `${item.role}: ${item.content}`).join("\n")}`.slice(-6000);
        }
        await this.state.storage.put("memory", store);
      }
    }
    if (path === "/search" && request.method === "POST") {
      const body = await request.json() as { query?: string };
      const query = body.query?.toLowerCase() ?? "";
      const results = Object.values(store.projects).flatMap(project => [...project.history, { role: "assistant" as const, content: project.summary }, ...project.preferences.map(content => ({ role: "assistant" as const, content }))]).filter(item => item.content.toLowerCase().includes(query)).slice(-10);
      return json({ results });
    }
    return json({ stopped: (await this.state.storage.get<boolean>("stopped")) ?? false });
  }

  private async getStore(): Promise<MemoryStore> {
    return (await this.state.storage.get<MemoryStore>("memory")) ?? { activeProject: "default", projects: { default: emptyProject() } };
  }
}

function emptyProject(): ProjectMemory { return { history: [], summary: "", preferences: [] }; }
function cleanProjectName(value: string): string { return value.trim().replace(/[^\p{L}\p{N}_ -]/gu, "").slice(0, 60) || "default"; }
