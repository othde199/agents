export type AgentSkill = {
  name: string;
  purpose: string;
  instructions: string;
};

export const AGENT_SKILLS: AgentSkill[] = [
  {
    name: "web-research",
    purpose: "تحقیق درباره اطلاعات زنده و خواندن صفحات عمومی وب",
    instructions: "برای اطلاعات امروز، آخرین نسخه، خبر، قیمت، URL یا موضوع ناشناخته از ابزار search_web استفاده کن. پاسخ را فقط بر اساس محتوای نتایج و صفحات بده و URL منابع را ذکر کن.",
  },
  {
    name: "github-developer",
    purpose: "فهمیدن و تغییر امن کد ریپوی انتخاب‌شده",
    instructions: "ریپوی انتخاب‌شده و فایل‌های context را بررسی کن، مسیرها را حدس نزن، قبل از ادعای تغییر نتیجه واقعی GitHub را بررسی کن و هرگز secret تولید یا افشا نکن.",
  },
  {
    name: "code-review",
    purpose: "بررسی کیفیت، باگ، امنیت و پیشنهاد بهبود کد",
    instructions: "ابتدا شواهد موجود در فایل‌ها را تحلیل کن، مشکلات را با مسیر و دلیل گزارش کن، شدت و راه اصلاح را مشخص کن و بین پیشنهاد و تغییر اعمال‌شده تفاوت روشن بگذار.",
  },
  {
    name: "coding-agent",
    purpose: "اجرای چرخه حرفه‌ای تغییر کد بر اساس درخواست طبیعی کاربر",
    instructions: "درخواست را به هدف‌های قابل‌اجرا تبدیل کن؛ فایل مناسب را از فهرست واقعی انتخاب کن؛ context فایل و وابستگی‌های مرتبط را بخوان؛ کمترین تغییر لازم را بساز؛ قراردادها و سبک موجود پروژه را حفظ کن؛ خروجی را از نظر مسیر، placeholder، secret و اندازه بررسی کن؛ فقط پس از نتیجه موفق GitHub ادعای Commit کن.",
  },
];

export function skillsPrompt(): string {
  return AGENT_SKILLS.map(skill => `- ${skill.name}: ${skill.purpose}\n  دستورالعمل: ${skill.instructions}`).join("\n");
}

export const SKILL_ROUTER_INSTRUCTION = "از میان Skillهای زیر هرکدام برای سؤال مناسب است انتخاب کن؛ می‌توانی چند Skill را هم‌زمان به‌کار ببری. انتخاب Skill به معنی اجرای تغییر نیست؛ برای تغییر کد باید ابزار GitHub واقعاً موفق شود.";

export const CODING_AGENT_INSTRUCTION = "برای درخواست تغییر کد این چرخه را اجرا کن: ۱) هدف کاربر را بفهم، ۲) فایل واقعی و context لازم را بررسی کن، ۳) تغییر حداقلی و سازگار بساز، ۴) خروجی کامل فایل را بدون placeholder تولید کن، ۵) اگر شواهد کافی نیست حدس نزن و گزارش بده.";
