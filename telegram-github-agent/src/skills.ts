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
];

export function skillsPrompt(): string {
  return AGENT_SKILLS.map(skill => `- ${skill.name}: ${skill.purpose}\n  دستورالعمل: ${skill.instructions}`).join("\n");
}

export const SKILL_ROUTER_INSTRUCTION = "از میان Skillهای زیر هرکدام برای سؤال مناسب است انتخاب کن؛ می‌توانی چند Skill را هم‌زمان به‌کار ببری. انتخاب Skill به معنی اجرای تغییر نیست؛ برای تغییر کد باید ابزار GitHub واقعاً موفق شود.";
