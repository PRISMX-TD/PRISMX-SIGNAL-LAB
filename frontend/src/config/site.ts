// 站点级常量：不属于任何单个页面、也不该被翻译的东西。
//
// 邮箱地址不进 i18n：它在中英两份文案里必须完全一致，放进翻译文件等于给自己
// 留一个「改了中文忘了改英文」的坑，而联系方式写错的后果是客户联系不上。
//
// Site-level constants: things that belong to no single page and must not be
// translated. The email address deliberately stays out of i18n — it has to be
// byte-identical in both languages, and putting it in the translation files
// invites the classic "updated zh, forgot en" bug, whose consequence here is a
// customer who cannot reach you.

// 客服邮箱。**这一个常量控制全站所有「联系我们」入口**——留空即全部隐藏：
//   · 三个法务页底部的「联系我们」区块
//   · 落地页页脚的「需要帮助？」一栏
//   · 登录后 Layout 页脚的「联系客服」链接
//
// 目前留空，因为邮箱转发还没配好。**暴露一个收不到信的地址比没有地址更糟**：
// 客户按它写信、石沉大海，那不是「找不到客服」，是「被无视了」——尤其升级页的
// 少付款兜底提示会让客户拿着一笔真金白银来找人。
//
// 配好转发并**实际发一封测试信确认能收到**之后，把地址填回来即可，三处入口
// 同时恢复，不需要改任何组件。
//
// Support inbox. **This single constant gates every "contact us" surface** —
// leaving it empty hides them all:
//   - the contact block at the foot of the three legal pages
//   - the "Need help?" column in the landing-page footer
//   - the "Contact support" link in the logged-in Layout footer
//
// Empty for now because mail forwarding isn't set up yet. **Publishing an address
// that can't receive mail is worse than publishing none**: a customer writes to it,
// hears nothing, and that reads as being ignored rather than as "no support" —
// especially since the underpayment notice on the upgrade page sends people here
// holding real money.
//
// Once forwarding is configured and you have **actually sent a test message and
// confirmed it arrives**, put the address back. All three surfaces return at once;
// no component needs changing.
export const SUPPORT_EMAIL = ''

// 法务文本的生效日期，三份文档共用。改动任何一份的实质内容时同步更新这里。
// Effective date shown on all three legal documents. Bump it whenever any of
// them changes substantively.
export const LEGAL_UPDATED = '2026-07-28'
