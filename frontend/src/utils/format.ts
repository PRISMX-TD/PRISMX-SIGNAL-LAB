// 空值占位符：数值缺失（没报价、没设止损、还没成交价……）时显示的那一个字符。
// 以前混用 '—'（em dash）和 '-'（连字符），同一屏上两种横线并排；'-' 还和负号
// 长得一样，放在价格位置像「负的什么」。统一成 en dash：比连字符长、不会被读成
// 负号，也不是界面文案里禁用的 em dash。后台与客服台（components/admin、
// components/support）是内部工具，仍用各自的写法。
// The placeholder shown when a value is missing (no quote, no stop, no fill yet).
// The app mixed '—' and '-', sometimes side by side, and a bare '-' in a price slot
// reads as a minus sign. One en dash: longer than a hyphen, never mistaken for a
// negative number, and not the em dash the UI copy rules forbid. The admin and
// support consoles are internal tools and keep their own glyphs.
export const EMPTY = '–'
