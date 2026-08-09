// FAQ 页的完整题目清单（i18n key 对）。前 9 条与落地页 FaqSection 共用同一批
// landing.faqNq/a 键——文案单一来源，两处永不漂移；后 4 条是 FAQ 页独有补充。
// 页面渲染（FaqPage）与预渲染的 FAQPage JSON-LD（seo/head.ts）都从这份清单
// 取键，保证结构化数据与页面可见内容一字不差（Google 会校验一致性）。
export const FAQ_KEYS: ReadonlyArray<{ q: string; a: string }> = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ q: `landing.faq${n}q`, a: `landing.faq${n}a` })),
  { q: 'faqPage.q10', a: 'faqPage.a10' },
  { q: 'faqPage.q11', a: 'faqPage.a11' },
  { q: 'faqPage.q12', a: 'faqPage.a12' },
  { q: 'faqPage.q13', a: 'faqPage.a13' },
]
