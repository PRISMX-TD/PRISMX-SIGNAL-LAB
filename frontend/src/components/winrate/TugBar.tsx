// 拔河条：全页唯一的胜率图元。绿段是赢的比例、红段是输的比例，中间一根白线
// 是 50%——"绿的过没过线"就是新手要看的全部。
//
// 刻意不再画置信区间的横杠：那个图形需要先懂"区间"才读得出来。样本厚薄改由
// 旁边的判定芯片用词表达（「笔数还少」），图形本身只负责一件事。
// 绿段用 transform 做一次进场生长（.grow-x），不动 width，不触发布局。
// 全部用 <span>：策略卡把它放在 <button> 里，按钮内只允许短语内容。
//
// The tug-of-war bar, the page's only win-rate glyph: green is the share of
// wins, red the share of losses, the white tick is 50% — "did green cross the
// line" is everything a newcomer needs. The confidence whisker is gone on
// purpose (it requires knowing what an interval is first); sample thickness is
// carried by the verdict chip's wording instead. The green segment grows in
// once via transform (.grow-x), never by animating width. Spans throughout:
// the strategy card places this inside a <button>, which only allows phrasing
// content.
export default function TugBar({ hitTp, hitSl, size = 'md', label, className = '' }: {
  hitTp: number
  hitSl: number
  size?: 'lg' | 'md' | 'sm'
  label: string
  className?: string
}) {
  const n = hitTp + hitSl
  const h = { lg: 12, md: 8, sm: 6 }[size]
  if (n === 0) {
    return (
      <span className={`block w-full rounded-full bg-white/[0.06] ${className}`} style={{ height: h }}
            role="img" aria-label={label} />
    )
  }
  const share = hitTp / n
  return (
    <span className={`relative block w-full ${className}`} style={{ height: h }} role="img" aria-label={label}>
      <span className="absolute inset-0 block overflow-hidden rounded-full">
        <span className="absolute inset-0 block" style={{ background: 'var(--down)', opacity: 0.55 }} />
        <span
          className="grow-x absolute inset-y-0 left-0 block rounded-full"
          style={{ width: `${share * 100}%`, background: 'var(--up)', boxShadow: '2px 0 0 var(--surface)' }}
        />
      </span>
      {/* 50% 线 / the 50% tick */}
      <span aria-hidden className="absolute left-1/2 block w-px -translate-x-1/2 bg-white/80"
            style={{ top: -3, bottom: -3 }} />
    </span>
  )
}
