// 画线工具栏自己的按钮图标（测量尺、放大、磁吸、连续绘制、锁、眼睛、删除、对象树），与 DrawToolIcon
// 同一套 28 格细线，两套外壳（专业版左栏、经典版 / 手机横条）共用。都是本项目自己画的。
// The draw bar's own button icons (ruler, zoom, magnet, stay-in-draw, lock, eye, trash, object tree)
// on the same thin 28-grid line set as DrawToolIcon, shared by the pro rail and the classic / phone
// strip. All drawn here.
const svg = (size: number) => ({
  width: size, height: size, viewBox: '0 0 28 28', fill: 'none', stroke: 'currentColor',
  strokeWidth: Math.max(1, Math.round((28 / size) * 1.05 * 100) / 100),
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
})
type P = { size?: number }

export const IcRuler = ({ size = 18 }: P) => <svg {...svg(size)}><path d="M4 19.5L19.5 4 24 8.5 8.5 24z" /><path d="M8 15.5l2 2M11 12.5l1.3 1.3M14 9.5l2 2M17 6.5l1.3 1.3" /></svg>
export const IcZoom = ({ size = 18, plus = false }: P & { plus?: boolean }) => <svg {...svg(size)}><circle cx="12.5" cy="12.5" r="7.5" /><path d="M18 18l6 6M9 12.5h7" />{plus && <path d="M12.5 9v7" />}</svg>
export const IcMagnet = ({ size = 18, strong = false }: P & { strong?: boolean }) => (
  <svg {...svg(size)}>
    <path d="M7 5v9a7 7 0 0014 0V5h-4.5v9a2.5 2.5 0 01-5 0V5z" fill={strong ? 'currentColor' : 'none'} fillOpacity={strong ? 0.22 : 0} />
    <path d="M7 9h4.5M16.5 9H21" />
  </svg>
)
export const IcStay = ({ size = 18 }: P) => <svg {...svg(size)}><path d="M5 23l1.2-4.6L17 7.6l3.4 3.4L9.6 21.8z" /><path d="M15 9.6l3.4 3.4" /><rect x="18.5" y="19" width="6" height="5" rx="1" /><path d="M19.8 19v-1.5a1.7 1.7 0 013.4 0V19" /></svg>
export const IcLock = ({ size = 18, locked = false }: P & { locked?: boolean }) => <svg {...svg(size)}><rect x="6.5" y="12.5" width="15" height="11" rx="2" /><path d={locked ? 'M9.5 12.5v-3a4.5 4.5 0 019 0v3' : 'M9.5 12.5v-3a4.5 4.5 0 018.6-1.9'} /><path d="M14 16.5v3" /></svg>
export const IcEye = ({ size = 18, off = false }: P & { off?: boolean }) => (
  <svg {...svg(size)}>
    <path d="M3.5 14s4-7 10.5-7 10.5 7 10.5 7-4 7-10.5 7S3.5 14 3.5 14z" />
    <circle cx="14" cy="14" r="3" />
    {off && <path d="M5 23L23 5" />}
  </svg>
)
export const IcTrash = ({ size = 18 }: P) => <svg {...svg(size)}><path d="M5 8h18M11 8V5.5h6V8M7.5 8l1.2 15h10.6l1.2-15M12 12v7M16 12v7" /></svg>
export const IcTree = ({ size = 18 }: P) => <svg {...svg(size)}><rect x="4.5" y="4.5" width="7" height="5.5" rx="1" /><path d="M8 10v11.5h4.5M8 15.5h4.5M16 15.5h8M16 21.5h8" /></svg>
