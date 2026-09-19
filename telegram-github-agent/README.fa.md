# ربات تلگرام برای کار با GitHub و Cloudflare Workers

این پروژه یک Worker مستقل و سبک است که روی پلن رایگان Cloudflare قابل اجراست. ربات از طریق **Telegram webhook** پیام می‌گیرد، برای پاسخ‌های کوتاه از **Workers AI** استفاده می‌کند و با **GitHub Contents API** فایل را می‌خواند و commit می‌کند.

## Skillهای داخلی ایجنت

ایجنت چهار Skill داخلی دارد که در `src/skills.ts` تعریف شده‌اند: `web-research` برای تحقیق زنده و خواندن صفحات عمومی، `github-developer` برای فهم و تغییر امن ریپوی انتخاب‌شده، `code-review` برای بررسی باگ، امنیت و کیفیت کد، و `coding-agent` برای چرخه انتخاب فایل، تحلیل context، تولید تغییر حداقلی و اعتبارسنجی قبل از Commit. مدل می‌تواند بر اساس سؤال یک یا چند Skill را انتخاب کند؛ Skillها سرویس خارجی یا binding پولی نیستند و به‌صورت prompt سبک داخل Worker اجرا می‌شوند.

## چرا نمونه `agent-think` مستقیماً deploy نشده است؟

نمونه `agent-think` موجود در این ریپو برای بازتولید issue و اجرای کد به Container، چند Durable Object، R2 و warm pool متکی است. این اجزا برای نیاز فعلی ربات تلگرام ضروری نیستند و برای حساب رایگان انتخاب مناسبی نیستند. Worker این پوشه عمداً بدون Container، D1، KV، R2، Cron و polling نوشته شده است.

## سکرت‌های لازم در Cloudflare

در مسیر **Workers & Pages → telegram-github-agent → Settings → Variables and Secrets** این موارد را به‌صورت **Encrypted secret** بسازید:

| نام | مقدار | سطح دسترسی پیشنهادی |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | توکن BotFather | فقط secret |
| `TELEGRAM_WEBHOOK_SECRET` | یک رشته تصادفی حداقل 32 کاراکتری | فقط secret |
| `GITHUB_TOKEN` | Fine-grained PAT | فقط secret؛ فقط ریپوی هدف |
| `SUPABASE_ANON_KEY` | کلید Publishable پروژه Supabase | برای تحلیل read-only؛ قابل‌استفاده به‌عنوان Variable |
| `SUPABASE_SERVICE_ROLE_KEY` | کلید Service Role پروژه Supabase | اختیاری؛ فقط برای عملیات مدیریتی و Encrypted secret |

متغیرهای غیرحساس داخل `wrangler.jsonc` هستند: `GITHUB_REPO`، `GITHUB_DEFAULT_BRANCH`، `AI_MODEL` و `MAX_FILE_BYTES`. برای تحلیل read-only، `SUPABASE_URL` و `SUPABASE_ANON_KEY` کافی هستند. `SUPABASE_SERVICE_ROLE_KEY` برای این نسخه لازم نیست.

## Skillهای تحلیلی

فرمان `/analyze-db` فایل‌های schema، migration و SQL را تحلیل می‌کند. اگر `SUPABASE_URL` و `SUPABASE_ANON_KEY` تنظیم شده باشند، اتصال read-only پایه به Supabase را نیز بررسی می‌کند؛ این نسخه داده‌های رکوردی را نمی‌خواند. بدون تنظیمات Supabase، تحلیل فایل‌های ریپو همچنان فعال است.

فرمان `/docs` وضعیت README، مستندات API و راه‌اندازی را بررسی می‌کند و `/security` ممیزی امنیتی کد و تنظیمات را انجام می‌دهد. این دو فرمان فقط گزارش می‌دهند و خودکار Commit نمی‌کنند. برای اعمال پیشنهادها از `/edit` استفاده کنید.

کلید Service Role دسترسی بالایی دارد؛ آن را هرگز در GitHub، چت تلگرام یا prompt قرار ندهید و فقط در Cloudflare به‌صورت Encrypted secret ذخیره کنید. برای تحلیل صرفاً فایل‌های ریپو نیازی به اتصال Supabase نیست.

### ساخت GitHub Token

یک **Fine-grained personal access token** بسازید، آن را فقط به `othde199/agents` یا ریپوی موردنظر محدود کنید و حداقل مجوزها را بدهید:

- `Contents: Read and write`
- برای `/run-tests`، مجوز `Actions: Read and write` نیز لازم است؛ اگر این فرمان را استفاده نمی‌کنید، این مجوز را اضافه نکنید.
- به Issues، Secrets یا Administration نیازی نیست.

توکن را در کد، `wrangler.jsonc` یا چت تلگرام قرار ندهید.

## نصب و انتشار

```bash
cd telegram-github-agent
pnpm install
pnpm exec wrangler login
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm run typecheck
pnpm run deploy
```

بعد از deploy، آدرس Worker را بردارید و وبهوک را فقط یک‌بار تنظیم کنید:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://telegram-github-agent.<ACCOUNT>.workers.dev/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

برای محدود کردن ربات به چت خودتان، شناسه عددی چت را به‌صورت secret یا variable با نام `ALLOWED_CHAT_IDS` ثبت کنید؛ برای چند چت از کاما استفاده کنید.

## دستورات

- `/start` و `/help`
- `/status`
- `/repo`
- `/ask سؤال`
- `/edit درخواست تغییر`
- `/analyze-db`
- `/docs`
- `/security`
- `/index-project` برای خواندن فایل‌های واقعی و ساخت ایندکس محلی در Durable Object
- `/search-code عبارت` برای جست‌وجوی رتبه‌بندی‌شده در مسیر، symbol، import و قطعه‌کد
- `/trace درخواست` برای trace استاتیک مسیرهای مرتبط و وابستگی‌های import
- `/run-tests` برای dispatch کردن Workflow `agent-check.yml` در GitHub

در نسخه فعلی `/edit` مستقیماً یک فایل موجود را با commit روی شاخه پیش‌فرض به‌روزرسانی می‌کند. `/trace` تحلیل static است و runtime را اجرا نمی‌کند. `/run-tests` نیز اجرای کد را داخل Cloudflare انجام نمی‌دهد؛ فقط Workflow موجود در ریپو را از طریق GitHub Actions فراخوانی می‌کند. فایل `.github/workflows/agent-check.yml` نمونه‌ای رایگان برای build، test، typecheck و audit است و باید در ریپوی هدف نیز وجود داشته باشد.

## نکات امنیتی مهم

این نسخه فقط مسیر فایل‌های معمولی را می‌پذیرد، `.env` و `.github/workflows` را مسدود می‌کند، اندازه فایل را محدود می‌کند و به چت‌های مجاز محدودشدنی است. با این حال، چون `/edit` می‌تواند commit بسازد، **توکن GitHub را با دسترسی بیشتر از Contents ندهید** و `ALLOWED_CHAT_IDS` را تنظیم کنید.

## محدودیت‌های پلن رایگان

طبق مستندات رسمی Cloudflare، Workers Free شامل ۱۰۰٬۰۰۰ درخواست در روز، ۱۰ میلی‌ثانیه CPU برای هر invocation، ۵۰ subrequest در هر invocation و حداکثر ۱۲۸MB حافظه است. Workers AI نیز ۱۰٬۰۰۰ Neurons رایگان در روز دارد. بنابراین این پروژه برای استفاده شخصی و پیام‌های کم‌حجم مناسب است؛ برای ریپوی بزرگ، context کامل را به مدل نمی‌فرستد و در هر پرسش فقط فهرست محدودی از فایل‌ها را می‌خواند.

برای جلوگیری از هزینه ناخواسته، در این Worker هیچ binding پولی، سرویس بیرونی اجباری، cron یا Container فعال نشده است. Skillهای داخلی نیز هزینه جداگانه ندارند و فقط همراه درخواست Workers AI اجرا می‌شوند. اگر سهمیه Workers AI روزانه تمام شود، پاسخ‌های AI تا reset روزانه کار نمی‌کنند، اما خود Worker و GitHub API همچنان از نظر کد مستقل هستند.
