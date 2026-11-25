// 键盘快捷键一览（Ctrl+/ 或 ?）。列表与 useChartHotkeys / DrawLayer 实际处理的按键一致。
// Keyboard shortcut reference (Ctrl+/ or ?). Matches the keys useChartHotkeys / DrawLayer handle.
import { useTranslation } from 'react-i18next'
import ChartDialog from './ChartDialog'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl'
const alt = isMac ? '⌥' : 'Alt'

export const SHORTCUTS: { group: string; items: { keys: string[]; k: string }[] }[] = [
  { group: 'chart', items: [
    { keys: ['0-9', 'A-Z'], k: 'quick' },
    { keys: [alt, 'R'], k: 'reset' },
    { keys: [alt, 'G'], k: 'goto' },
    { keys: [alt, 'A'], k: 'alert' },
    { keys: [alt, 'L'], k: 'log' },
    { keys: [alt, 'P'], k: 'percent' },
    { keys: [alt, 'I'], k: 'invert' },
    { keys: ['←', '→'], k: 'scroll' },
    { keys: ['↑', '↓'], k: 'zoom' },
    { keys: [mod, alt, 'S'], k: 'screenshot' },
    { keys: [mod, '/'], k: 'help' },
  ] },
  { group: 'draw', items: [
    { keys: [alt, 'T'], k: 'trend' },
    { keys: [alt, 'H'], k: 'hline' },
    { keys: [alt, 'V'], k: 'vline' },
    { keys: [alt, 'C'], k: 'crossline' },
    { keys: [alt, 'F'], k: 'fib' },
    { keys: [alt, 'Shift', 'R'], k: 'rect' },
    { keys: [alt, 'Shift', 'T'], k: 'ray' },
    { keys: ['Shift', '🖱'], k: 'measure' },
    { keys: ['Esc'], k: 'cancel' },
    { keys: ['Del'], k: 'delete' },
  ] },
]

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <ChartDialog title={String(t('charts.keys.title'))} onClose={onClose}>
      <div className="chart-keys">
        {SHORTCUTS.map((g) => (
          <section key={g.group}>
            <h4>{t(`charts.keys.group.${g.group}`)}</h4>
            {g.items.map((it) => (
              <div key={it.k} className="chart-keys-row">
                <span>{t(`charts.keys.${it.k}`)}</span>
                <span className="chart-keys-k">{it.keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </ChartDialog>
  )
}
