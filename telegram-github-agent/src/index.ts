import { skillsPrompt, SKILL_ROUTER_INSTRUCTION } from "./skills";

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

type TelegramUpdate = { message?: { chat: { id: number }; text?: string; from?: { id: number } }; callback_query?: { id: string; data?: string; message?: { chat: { id: number } } } };
type GithubFile = { content: string; sha: string; encoding: string; size: number };
type GithubRepo = { full_name: string; private: boolean; html_url: string; default_branch?: string; archived?: boolean };
type GithubRepoDetails = { full_name: string; default_branch: string };
type ConversationMessage = { role: "user" | "assistant"; content: string };
type ProjectMemory = { history: ConversationMessage[]; summary: string; preferences: string[] };
type MemoryStore = { activeProject: string; repo?: string; projects: Record<string, ProjectMemory> };

const MAIN_MENU = { inline_keyboard: [
  [{ text: "🤖 سؤال از ایجنت", callback_data: "menu:ask" }, { text: "🌐 جست‌وجوی وب", callback_data: "menu:search" }],
  [{ text: "📚 فهرست ریپوها", callback_data: "menu:repos" }, { text: "📌 ریپوی فعال", callback_data: "menu:repo" }],
  [{ text: "📊 وضعیت", callback_data: "menu:status" }, { text: "🧠 حافظه", callback_data: "menu:memory" }],
  [{ text: "✏️ تغییر کد", callback_data: "menu:edit" }, { text: "❓ راهنما", callback_data: "menu:help" }],
  [{ text: "⏸ توقف", callback_data: "menu:stop" }, { text: "▶️ ادامه", callback_data: "menu:resume" }]
] };
const QUICK_MENU = { keyboard: [
  [{ text: "🤖 سؤال از ایجنت" }, { text: "🌐 جست‌وجوی وب" }],
  [{ text: "📚 فهرست ریپوها" }, { text: "📊 وضعیت" }],
  [{ text: "🧠 حافظه" }, { text: "✏️ تغییر کد" }],
  [{ text: "⏸ توقف" }, { text: "▶️ ادامه" }]
], resize_keyboard: true, is_persistent: true, input_field_placeholder: "پیام یا سؤال خود را بنویسید" };

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
    const callback = update.callback_query;
    const chatId = update.message?.chat.id ?? callback?.message?.chat.id;
    const text = update.message?.text?.trim();
    if (!chatId || (!text && !callback) || !isAllowedChat(chatId, env.ALLOWED_CHAT_IDS)) return json({ ok: true });
    if (callback) {
      await answerCallback(callback.id, env);
      if (callback.data?.startsWith("repoidx:")) {
        const index = Number(callback.data.slice(8));
        const option = await (await stateForChat(env, chatId).fetch(`https://bot-state/repo-option/${index}`)).json() as { repo?: string };
        if (option.repo) await saveRepo(chatId, option.repo, env);
      } else if (callback.data?.startsWith("menu:")) await handleMenuCallback(chatId, callback.data.slice(5), env);
      return json({ ok: true });
    }
    if (!text) return json({ ok: true });
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
    const pending = await (await state.fetch("https://bot-state/pending")).json() as { action?: string };
    if (pending.action) {
      await state.fetch("https://bot-state/pending", { method: "DELETE" });
      await handleMessage(chatId, `/${pending.action} ${text}`, env);
      return json({ ok: true });
    }
    try { await handleMessage(chatId, text, env); } catch (error) {
      console.error("telegram handler failed", error);
      const detail = error instanceof Error ? error.message : "خطای نامشخص";
      await sendTelegram(chatId, `❌ اجرای درخواست شکست خورد.\nجزئیات: ${detail.slice(0, 300)}`, env);
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
  if (text === "/start" || text === "/help") {
    await sendTelegram(chatId, HELP, env, MAIN_MENU);
    return sendTelegram(chatId, "منوی سریع کنار کادر پیام:", env, QUICK_MENU);
  }
  if (text === "🤖 سؤال از ایجنت") return handleMenuCallback(chatId, "ask", env);
  if (text === "🌐 جست‌وجوی وب") return handleMenuCallback(chatId, "search", env);
  if (text === "📚 فهرست ریپوها") return handleMenuCallback(chatId, "repos", env);
  if (text === "📊 وضعیت") return handleMenuCallback(chatId, "status", env);
  if (text === "🧠 حافظه") return handleMenuCallback(chatId, "memory", env);
  if (text === "✏️ تغییر کد") return handleMenuCallback(chatId, "edit", env);
  if (text === "⏸ توقف") return handleMenuCallback(chatId, "stop", env);
  if (text === "▶️ ادامه") return handleMenuCallback(chatId, "resume", env);
  if (text === "/status") return showStatus(chatId, env);
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
  if (looksLikeEditRequest(text)) return editCode(chatId, text, env);
  return agentReply(chatId, text, env);
}

async function handleMenuCallback(chatId: number, action: string, env: Env): Promise<void> {
  if (action === "status") return showStatus(chatId, env);
  if (action === "repos") return listRepositories(chatId, env);
  if (action === "repo") return showRepo(chatId, env);
  if (action === "help") return sendTelegram(chatId, HELP, env, MAIN_MENU);
  if (action === "memory") return sendTelegram(chatId, "🧠 مدیریت حافظه را انتخاب کنید:", env, { inline_keyboard: [[{ text: "💾 ذخیره ترجیح", callback_data: "menu:remember" }, { text: "📁 انتخاب پروژه", callback_data: "menu:project" }], [{ text: "🔎 جست‌وجوی تاریخچه", callback_data: "menu:history" }, { text: "🧹 پاک‌کردن حافظه", callback_data: "menu:clear_memory" }], [{ text: "⬅️ منوی اصلی", callback_data: "menu:help" }]] });
  if (action === "stop") { await stateForChat(env, chatId).fetch("https://bot-state/stop", { method: "POST" }); return sendTelegram(chatId, "⏸ ربات متوقف شد.", env, MAIN_MENU); }
  if (action === "resume") { await stateForChat(env, chatId).fetch("https://bot-state/resume", { method: "POST" }); return sendTelegram(chatId, "▶️ ربات دوباره فعال شد.", env, MAIN_MENU); }
  if (action === "clear_memory") return clearConversation(chatId, env);
  const actions = ["ask", "search", "edit", "remember", "project", "history"];
  if (actions.includes(action)) {
    await stateForChat(env, chatId).fetch("https://bot-state/pending", { method: "POST", body: JSON.stringify({ action }) });
    const labels: Record<string, string> = { ask: "سؤال خود را بفرستید", search: "عبارت جست‌وجوی وب را بفرستید", edit: "درخواست تغییر کد را بفرستید", remember: "ترجیح یا نکته را بفرستید", project: "نام پروژه را بفرستید", history: "عبارت جست‌وجو در تاریخچه را بفرستید" };
    return sendTelegram(chatId, `✍️ ${labels[action]}:`, env, MAIN_MENU);
  }
}

async function agentReply(chatId: number, question: string, env: Env): Promise<void> {
  if (!question) return sendTelegram(chatId, "سؤال خالی است.", env);
  await sendTelegram(chatId, "⏳ در حال فکر کردن...", env);
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  const memory = await readMemory(state);
  const activeEnv = memory.repo ? { ...env, GITHUB_REPO: memory.repo } : env;
  const repoEnv = await resolveRepoEnv(activeEnv);
  const repoContext = needsRepo(question) ? await projectContext(repoEnv) : "";
  const prompt = `تو یک ایجنت عمومی و دستیار برنامه‌نویسی هستی. به فارسی و دقیق جواب بده. اگر سؤال به اطلاعات زنده، آخرین نسخه، خبر، قیمت، سایت یا URL نیاز دارد از ابزار search_web استفاده کن؛ از حافظه‌ات حدس نزن. اگر ابزار نتیجه کافی نداد، صادقانه بگو اطلاعات قابل‌تأیید نیست.\n\n${SKILL_ROUTER_INSTRUCTION}\n${skillsPrompt()}\n\nریپوی زمینه: ${repoEnv.GITHUB_REPO}\nپروژه فعال: ${memory.activeProject}\nخلاصه حافظه: ${memory.project.summary}\nترجیحات کاربر: ${memory.project.preferences.join(" | ")}\n${repoContext}\nسؤال کاربر: ${question}`;
  const toolResult = await aiWithSearchTool(repoEnv, prompt, memory.project.history);
  const answer = toolResult.answer;
  await appendMemory(state, { role: "user", content: question }, { role: "assistant", content: answer });
  const sources = [...toolResult.context.matchAll(/(?:URL|SOURCE):\s*(https?:\/\/[^\s]+)/g)].map(match => match[1]).slice(0, 5);
  return sendTelegram(chatId, sources.length ? `${answer}\n\nمنابع بررسی‌شده:\n${sources.join("\n")}` : answer, env);
}

async function aiWithSearchTool(env: Env, prompt: string, history: ConversationMessage[] = []): Promise<{ answer: string; context: string }> {
  const messages = [{ role: "system" as const, content: `تو یک ایجنت دقیق هستی. برای اطلاعات به‌روز از ابزار استفاده کن و هرگز موفقیت یا منبعی را جعل نکن.\n${SKILL_ROUTER_INSTRUCTION}\n${skillsPrompt()}` }, ...history.slice(-6), { role: "user" as const, content: prompt }];
  const result = await env.AI.run(env.AI_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages, max_tokens: 1800, temperature: 0.2, tools: [{ name: "search_web", description: "Search the public web and read pages relevant to the user's question. Use this for current or unknown information.", parameters: { type: "object", properties: { query: { type: "string", description: "The exact web search query" } }, required: ["query"] } }] }) as { response?: unknown; tool_calls?: unknown; result?: { tool_calls?: unknown; response?: unknown } };
  const calls = result.tool_calls ?? result.result?.tool_calls;
  const toolList = Array.isArray(calls) ? calls as { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }[] : [];
  const tool = toolList.find(call => call.name === "search_web" || call.function?.name === "search_web");
  if (!tool) {
    const modelAnswer = typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? result.result?.response ?? "پاسخی دریافت نشد.");
    if (!needsWeb(prompt) || !/قابل.?تأیید|اطلاعات کافی|نمی.?دانم|cannot|don't know|unknown/i.test(modelAnswer)) return { answer: modelAnswer, context: "" };
    const fallbackContext = await webSearch(prompt);
    const fallbackAnswer = await ai(env, `${prompt}\n\nابزار search_web به‌صورت خودکار فراخوانی نشد. این نتیجه جست‌وجوی اجباری است:\n${fallbackContext}\n\nفقط بر اساس شواهد پاسخ بده و منابع را ذکر کن.`, history);
    return { answer: fallbackAnswer, context: fallbackContext };
  }
  const rawArguments = tool.arguments ?? tool.function?.arguments;
  const args = typeof rawArguments === "string" ? JSON.parse(rawArguments) as { query?: string } : rawArguments as { query?: string };
  const context = await webSearch(args?.query?.trim() || prompt);
  const final = await ai(env, `${prompt}\n\nنتیجه ابزار search_web:\n${context}\n\nاکنون پاسخ نهایی را فقط بر اساس این نتیجه و context بده. اگر شواهد کافی نیست بگو قابل تأیید نیست.`, history);
  return { answer: final, context };
}

async function decideWebSearch(env: Env, question: string, history: ConversationMessage[] = []): Promise<{ search: boolean; query?: string }> {
  try {
    const result = await env.AI.run(env.AI_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [
      { role: "system", content: "تو router یک ایجنت عمومی هستی. تشخیص بده آیا پاسخ دقیق به سؤال به اطلاعات زنده اینترنت یا خواندن یک صفحه نیاز دارد. برای احوالپرسی، توضیح مفاهیم پایدار و سؤال‌های عمومی که دانش مدل کافی است false بده. برای آخرین/امروز/قیمت/خبر/نسخه فعلی، URL، یا درخواست بررسی سایت true بده. فقط JSON معتبر در یک خط برگردان: {\"search\":true|false,\"query\":\"عبارت جست‌وجو\"}." },
      ...history.slice(-2),
      { role: "user", content: question }
    ], max_tokens: 180, temperature: 0 }) as { response?: unknown };
    const raw = typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? "");
    const parsed = JSON.parse(extractJson(raw)) as { search?: boolean; query?: string };
    if (typeof parsed.search === "boolean") return { search: parsed.search, query: parsed.query?.trim() || question };
  } catch { /* fallback only if router fails */ }
  return { search: needsWeb(question), query: question };
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

async function showStatus(chatId: number, env: Env): Promise<void> {
  const memory = await readMemory(stateForChat(env, chatId));
  return sendTelegram(chatId, `✅ فعال\nریپو: ${memory.repo ?? env.GITHUB_REPO}\nپروژه حافظه: ${memory.activeProject}\nشاخه: ${env.GITHUB_DEFAULT_BRANCH}\nمدل: ${env.AI_MODEL ?? "پیش‌فرض"}`, env);
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
  await stateForChat(env, chatId).fetch("https://bot-state/repo-options", { method: "POST", body: JSON.stringify({ repos: repositories.map(repo => repo.full_name) }) });
  const chunks: GithubRepo[][] = [];
  for (let index = 0; index < repositories.length; index += 30) chunks.push(repositories.slice(index, index + 30));
  for (let index = 0; index < chunks.length; index++) {
    const offset = index * 30;
    const keyboard = chunks[index].map((repo, itemIndex) => [{ text: `${repo.private ? "🔒" : "🌐"} ${repo.full_name}`, callback_data: `repoidx:${offset + itemIndex}` }]);
    await sendTelegram(chatId, `📚 ریپوهای قابل‌دسترسی (${index + 1}/${chunks.length})\n\nبرای انتخاب، روی نام ریپو کلیک کنید:`, env, { inline_keyboard: keyboard });
  }
}

async function saveRepo(chatId: number, repo: string, env: Env): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return sendTelegram(chatId, "فرمت ریپو باید owner/name باشد.\nمثال: /repo othde199/agents", env);
  const state = env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId)));
  await state.fetch("https://bot-state/repo", { method: "POST", body: JSON.stringify({ repo }) });
  return sendTelegram(chatId, `✅ ریپو برای زمینه پاسخ ذخیره شد:\nhttps://github.com/${repo}`, env);
}

function stateForChat(env: Env, chatId: number): DurableObjectStub { return env.BOT_STATE.get(env.BOT_STATE.idFromName(String(chatId))); }

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

async function resolveRepoEnv(env: Env): Promise<Env> {
  try {
    const details = await github(`/repos/${env.GITHUB_REPO}`, env) as GithubRepoDetails;
    return { ...env, GITHUB_DEFAULT_BRANCH: details.default_branch || env.GITHUB_DEFAULT_BRANCH };
  } catch { return env; }
}

function needsRepo(question: string): boolean { return /پروژه|ریپو|کد|فایل|گیت.?هاب|repo|code|file|github|worker|agents|package|wrangler|typescript|javascript|ساختار/i.test(question); }
function looksLikeEditRequest(question: string): boolean { return /(?:می.?خوام|میخام|می.?خواهم|تغییر بده|عوض کن|جایگزین کن|change|replace|update|modify|set)/i.test(question) && /(?:رو\s+به|به|to|with|به‌جای|instead)/i.test(question); }
function needsWeb(question: string): boolean { return /اینترنت|وب|سایت|صفحه|لینک|برو داخل|محتوای سایت|جست.?جو|آخرین|اخرین|جدیدترین|امروز|قیمت|خبر|ورژن|نسخه جدید|مستندات|internet|web|site|page|url|link|search|latest|today|news|price|documentation|۲۰۲|202[4-9]|https?:\/\//i.test(question); }

async function projectContext(env: Env): Promise<string> {
  let files: string[] = [];
  try {
    const tree = await github(`/repos/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(env.GITHUB_DEFAULT_BRANCH)}?recursive=1`, env) as { tree?: { path: string; type: string }[] };
    files = (tree.tree ?? []).filter(x => x.type === "blob").map(x => x.path);
  } catch {
    const root = await github(`/repos/${env.GITHUB_REPO}/contents?ref=${encodeURIComponent(env.GITHUB_DEFAULT_BRANCH)}`, env) as { path: string; type: string }[];
    files = root.filter(x => x.type === "file").map(x => x.path);
  }
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
    const directUrls = [...question.matchAll(/https?:\/\/[^\s<>"'،،]+/gi)].map(match => match[0].replace(/[).،،]+$/g, ""));
    const searchResults = directUrls.length ? directUrls.map(url => ({ url, title: url, snippet: "" })) : await searchResultDetails(question);
    const urls = directUrls.length ? directUrls : searchResults.map(item => item.url);
    if (!urls.length) return "WEB SEARCH: no results found";
    const pages: string[] = [];
    for (const url of urls.slice(0, 4)) {
      const page = await fetchPageText(url);
      if (page) pages.push(`SOURCE: ${url}\n${page}`);
    }
    if (pages.length) return `WEB SEARCH AND PAGE CONTENT (use sources carefully):\n${pages.join("\n\n").slice(0, 24000)}\n\nSOURCES:\n${urls.join("\n")}`;
    const snippets = searchResults.map(item => `TITLE: ${item.title}\nURL: ${item.url}\nSNIPPET: ${item.snippet}`).join("\n\n");
    return snippets ? `WEB SEARCH RESULTS (page fetch unavailable; use only these snippets and cite URLs):\n${snippets.slice(0, 18000)}` : "WEB SEARCH FAILED: live search returned no readable results. Do not answer current-version questions from memory.";
  } catch { return "WEB SEARCH: unavailable; پاسخ را بر اساس دانش عمومی بده و بگو جست‌وجوی زنده در دسترس نبود."; }
}

async function searchResultUrls(question: string): Promise<string[]> {
  return (await searchResultDetails(question)).map(item => item.url);
}

async function searchResultDetails(question: string): Promise<{ url: string; title: string; snippet: string }[]> {
  const queries = [question, translateSearchQuery(question)].filter((value, index, all) => value && all.indexOf(value) === index);
  const allResults: { url: string; title: string; snippet: string }[] = [];
  for (const query of queries.slice(0, 2)) {
    let html = "";
    for (const endpoint of ["https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"]) {
      const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, { headers: { "user-agent": "telegram-github-agent/1.0", accept: "text/html" } });
      html = await response.text();
      if (html.includes("result__a") || html.includes("result-link")) break;
    }
    const matches = [...html.matchAll(/result__a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 6);
    allResults.push(...matches.map(match => {
    const raw = match[1].replace(/&amp;/g, "&");
    let url = raw;
    try { url = new URL(raw, "https://html.duckduckgo.com").searchParams.get("uddg") ?? raw; } catch { /* keep raw */ }
    const start = match.index ?? 0;
    const following = html.slice(start, start + 5000);
    const snippetMatch = following.match(/result__snippet[^>]*>([\s\S]*?)<\//i);
      return { url, title: stripHtml(match[2]), snippet: stripHtml(snippetMatch?.[1] ?? "") };
    }).filter(item => /^https?:\/\//i.test(item.url)));
  }
  return allResults.filter((item, index, all) => all.findIndex(other => other.url === item.url) === index);
}

function translateSearchQuery(question: string): string {
  return question.replace(/اخرین|آخرین/gi, "latest").replace(/ورژن|نسخه/gi, "version").replace(/بازی/gi, "game").replace(/موبایل/gi, "mobile").replace(/ویندوز|کامپیوتر|پی.?سی/gi, "PC Windows").replace(/چیه|چیست|چی هست/gi, "what is");
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    const response = await fetch(parsed.toString(), { headers: { "user-agent": "telegram-github-agent/1.0", accept: "text/html,text/plain,application/json" }, redirect: "follow" });
    if (!response.ok) return `[page unavailable: HTTP ${response.status}]`;
    const contentType = response.headers.get("content-type") ?? "";
    const raw = (await response.text()).slice(0, 120000);
    if (contentType.includes("application/json")) return raw.slice(0, 7000);
    return stripPageText(raw).slice(0, 7000);
  } catch { return ""; }
}

function stripPageText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, " ").trim();
}

async function editCode(chatId: number, instruction: string, env: Env): Promise<void> {
  if (!instruction) return sendTelegram(chatId, "درخواست تغییر را بعد از /edit بنویسید.", env);
  await sendTelegram(chatId, "⏳ در حال تحلیل درخواست و آماده‌سازی تغییر...", env);
  const memory = await readMemory(stateForChat(env, chatId));
  const activeEnv = memory.repo ? { ...env, GITHUB_REPO: memory.repo } : env;
  const details = await github(`/repos/${activeEnv.GITHUB_REPO}`, activeEnv) as GithubRepoDetails;
  const branch = details.default_branch || activeEnv.GITHUB_DEFAULT_BRANCH;
  const repoEnv = { ...activeEnv, GITHUB_DEFAULT_BRANCH: branch };
  const explicitPath = extractRequestedPath(instruction);
  const located = explicitPath ? undefined : await locateFileForInstruction(repoEnv, branch, instruction);
  const requestedPath = explicitPath ?? located?.path;
  if (!requestedPath) return sendTelegram(chatId, "نتوانستم فایل و عبارت موردنظر را در ریپوی انتخاب‌شده پیدا کنم.", env);
  const filePath = githubPath(requestedPath);
  const current = located?.path === requestedPath ? located.file : await github(`/repos/${repoEnv.GITHUB_REPO}/contents/${filePath}?ref=${encodeURIComponent(branch)}`, repoEnv) as GithubFile;
  const currentContent = located?.path === requestedPath ? located.content : decodeGithub(current.content);
  const deterministic = applyDeterministicEdit(requestedPath, currentContent, instruction);
  const textEdit = applyTextReplacement(currentContent, instruction);
  const plan = deterministic ? JSON.stringify({ path: requestedPath, content: deterministic.content, summary: deterministic.summary }) : textEdit ? JSON.stringify({ path: requestedPath, content: textEdit.content, summary: textEdit.summary }) : await ai(repoEnv, `فقط یک JSON معتبر و بدون markdown برگردان؛ هیچ توضیحی بیرون JSON ننویس. شکل دقیق: {"path":"${requestedPath}","content":"کل محتوای کامل جدید فایل","summary":"خلاصه کوتاه فارسی"}. مسیر فایل دقیقاً باید ${requestedPath} باشد و content هرگز نباید placeholder باشد.\nمحتوای فعلی فایل:\n${currentContent.slice(0, 50000)}\nدرخواست کاربر: ${instruction}`);
  let parsed: { path?: string; content?: string; summary?: string };
  try { parsed = JSON.parse(extractJson(String(plan))); } catch { return sendTelegram(chatId, `مدل نتوانست تغییر فایل را به شکل معتبر تولید کند. محتوای فایل تغییر نکرد.\n${String(plan).slice(0, 1200)}`, env); }
  if (!parsed.path || typeof parsed.content !== "string") return sendTelegram(chatId, "درخواست مبهم است؛ نام دقیق فایل و تغییر موردنظر را بنویسید.", env);
  if (parsed.content.includes("کل محتوای جدید فایل") || parsed.path.includes("/" ) && parsed.path.startsWith(activeEnv.GITHUB_REPO)) return sendTelegram(chatId, "خروجی مدل معتبر نبود و برای جلوگیری از خراب‌شدن فایل، Commit انجام نشد.", env);
  if (!safePath(parsed.path) || parsed.content.length > Number(env.MAX_FILE_BYTES ?? 120000)) return sendTelegram(chatId, "این مسیر یا اندازه فایل مجاز نیست.", env);
  const result = await github(`/repos/${repoEnv.GITHUB_REPO}/contents/${filePath}`, repoEnv, { method: "PUT", body: JSON.stringify({ message: `feat(bot): ${parsed.summary ?? "update requested from Telegram"}`.slice(0, 120), content: btoa(unescape(encodeURIComponent(parsed.content))), sha: current.sha, branch }) }) as { commit?: { html_url?: string } };
  return sendTelegram(chatId, `✅ تغییر در گیت‌هاب ثبت شد.\nفایل پیدا‌شده: ${parsed.path}\n${parsed.summary ?? ""}\nCommit: ${result.commit?.html_url ?? "ثبت شد"}`, env);
}

async function locateFileForInstruction(env: Env, branch: string, instruction: string): Promise<{ path: string; file: GithubFile; content: string } | undefined> {
  const tree = await github(`/repos/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`, env) as { tree?: { path: string; type: string; size?: number }[] };
  const candidates = (tree.tree ?? []).filter(item => item.type === "blob" && (item.size ?? 0) < 100000 && /\.(tsx?|jsx?|vue|svelte|html|css|scss|md|json)$/i.test(item.path) && !/(node_modules|dist|build|coverage|\.lock$)/i.test(item.path)).sort((a, b) => (/(src|app|components)/i.test(b.path) ? 1 : 0) - (/(src|app|components)/i.test(a.path) ? 1 : 0)).slice(0, 24);
  const needles = extractSearchNeedles(instruction);
  for (const candidate of candidates) {
    try {
      const file = await github(`/repos/${env.GITHUB_REPO}/contents/${githubPath(candidate.path)}?ref=${encodeURIComponent(branch)}`, env) as GithubFile;
      const content = decodeGithub(file.content);
      const normalized = normalizeSearchText(content);
      if (needles.some(needle => normalized.includes(normalizeSearchText(needle)))) return { path: candidate.path, file, content };
    } catch { /* skip inaccessible or binary files */ }
  }
  return undefined;
}

function extractSearchNeedles(instruction: string): string[] {
  const quoted = [...instruction.matchAll(/["“”'`](.{3,120}?)["“”'`]/g)].map(match => match[1].trim()).filter(value => !/^package\.json$/i.test(value));
  const english = instruction.match(/[A-Za-z][A-Za-z0-9 ,.!?'_-]{4,100}/g) ?? [];
  const beforeTo = instruction.match(/([A-Za-z][^،,\n]{3,200}?)\s+رو\s+به/i)?.[1] ?? "";
  return [...new Set([...quoted, ...english, beforeTo].map(value => value.replace(/^(?:میخام|می.?خوام|می.?خواهم)\s+/i, "").trim()).filter(value => value.length >= 4))];
}
function normalizeSearchText(value: string): string { return value.toLowerCase().replace(/[“”’`"]+/g, "'").replace(/\s+/g, " ").trim(); }

async function ai(env: Env, prompt: string, history: ConversationMessage[] = []): Promise<string> {
  const messages = [{ role: "system" as const, content: "تو یک ایجنت حرفه‌ای برنامه‌نویسی هستی. قبل از پاسخ context را دقیق بررسی کن، حدس نزن، مسیر فایل‌ها و تغییرات را دقیق نگه دار، و هرگز secret یا توکن تولید یا افشا نکن. اگر اطلاعات کافی نیست، سؤال روشن‌کننده بپرس." }, ...history.slice(-8), { role: "user" as const, content: prompt }];
  const result = await env.AI.run(env.AI_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages, max_tokens: 2000, temperature: 0.2 }) as { response?: unknown; result?: { response?: unknown }; output_text?: unknown };
  const response = result.response ?? result.result?.response ?? result.output_text;
  return typeof response === "string" ? response : response == null ? "پاسخی دریافت نشد." : JSON.stringify(response);
}

async function github(path: string, env: Env, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "telegram-github-agent", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.text();
    let message = "";
    try { message = (JSON.parse(body) as { message?: string }).message ?? ""; } catch { /* non-JSON error */ }
    throw new Error(`GitHub API ${response.status}${message ? `: ${message}` : ""}`);
  }
  return response.json();
}

async function sendTelegram(chatId: number, text: string, env: Env, replyMarkup?: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }) });
}

async function answerCallback(callbackId: string, env: Env): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: callbackId, text: "ریپو انتخاب شد" }) });
}

function isAllowedChat(chatId: number, allow?: string): boolean { return !allow || allow.split(",").map(x => x.trim()).includes(String(chatId)); }
function safePath(path: string): boolean { return path.length > 0 && path.length < 240 && !path.startsWith("/") && !path.includes("..") && !path.startsWith(".github/workflows/") && !path.endsWith(".env"); }
function stripFences(value: string): string { return value.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim(); }
function extractJson(value: string): string {
  const cleaned = stripFences(value);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}
function extractRequestedPath(instruction: string): string | undefined {
  const match = instruction.match(/(?:فایل|file|path)\s+[`'"“]?([^`'"”\s،,]+)[`'"”]?/i) ?? instruction.match(/(?:^|\s)([\w./-]+\.(?:json|ts|tsx|js|jsx|md|yml|yaml|css|html))\b/i);
  return match?.[1]?.replace(/^`|`$/g, "");
}
function applyDeterministicEdit(path: string, content: string, instruction: string): { content: string; summary: string } | undefined {
  if (path !== "package.json") return undefined;
  const dependency = instruction.match(/(?:نسخه|version)\s+(?:پکیج\s+)?([@\w./-]+)\s+را\s+از\s+["'`^~]?([\d.]+)["'`]?\s+به\s+["'`^~]?([\d.]+)["'`]?/i) ?? instruction.match(/([@\w./-]+)\s*["']?\^?([\d.]+)["']?\s*(?:به|to)\s*["']?\^?([\d.]+)["']?/i);
  if (!dependency) return undefined;
  const packageName = dependency[1];
  const oldVersion = dependency[2];
  const newVersion = dependency[3];
  const versionPattern = new RegExp(`(["']${escapeRegExp(packageName)}["']\\s*:\\s*["'])[^"']+(["'])`, "i");
  if (!versionPattern.test(content)) return undefined;
  return { content: content.replace(versionPattern, `$1^${newVersion}$2`), summary: `نسخه ${packageName} از ${oldVersion} یا نسخه فعلی به ${newVersion} تغییر کرد` };
}
function applyTextReplacement(content: string, instruction: string): { content: string; summary: string } | undefined {
  const quoted = [...instruction.matchAll(/["“”'`](.{3,200}?)["“”'`]/g)].map(match => match[1].trim());
  const replacementMatch = instruction.match(/(.{3,240}?)\s+رو\s+به\s+(.+?)(?:\s+(?:تغییر|عوض|کن|بده)|[،,؛;]|$)/i);
  const oldCandidates = replacementMatch ? [replacementMatch[1], ...quoted] : quoted;
  const oldText = oldCandidates.map(value => value.replace(/^(?:میخام|می.?خوام|می.?خواهم)\s+/i, "").trim()).sort((a, b) => b.length - a.length).find(value => normalizeSearchText(content).includes(normalizeSearchText(value)));
  const replacement = replacementMatch?.[2]?.trim() ?? instruction.match(/(?:رو\s+به|به|to)\s+["“”'`]?(.+?)["“”'`]?(?:\s+(?:تغییر|عوض|کن|بده)|$)/i)?.[1]?.trim();
  if (!oldText || !replacement) return undefined;
  const newText = replacement.replace(/["“”'`]+$/g, "").trim();
  if (!newText) return undefined;
  const variants = [oldText, oldText.replace(/["“”`]/g, "'"), oldText.replace(/[’']/g, '"'), oldText.replace(/"/g, "'")];
  const actual = variants.find(value => content.includes(value));
  if (!actual) return undefined;
  return { content: content.split(actual).join(newText), summary: `عبارت «${actual}» به «${newText}» تغییر کرد` };
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
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
    if (path === "/repo-options" && request.method === "POST") {
      const body = await request.json() as { repos?: string[] };
      await this.state.storage.put("repo-options", body.repos ?? []);
    }
    if (path.startsWith("/repo-option/") && request.method === "GET") {
      const index = Number(path.slice("/repo-option/".length));
      const repos = (await this.state.storage.get<string[]>("repo-options")) ?? [];
      return json({ repo: Number.isInteger(index) && index >= 0 ? repos[index] : undefined });
    }
    if (path === "/pending" && request.method === "POST") {
      const body = await request.json() as { action?: string };
      await this.state.storage.put("pending", body.action ?? "");
    }
    if (path === "/pending" && request.method === "DELETE") await this.state.storage.delete("pending");
    if (path === "/pending" && request.method === "GET") return json({ action: await this.state.storage.get<string>("pending") });
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
