// 推荐官的客户看板（2026-11-28，rev 58）：直属客户里各人格几个、谁这段时间没交易了、谁的评分掉得厉害，
// 让推荐官知道该先联系谁。放在「全部客户」页签顶部。
// 开关 persona_agent_board 默认关，而且只给有「看客户报告」权限的推荐官：接口回 403（或任何错误）时
// 这一块整个不出现，不占位、不报错。数据是后端存好的（人格、最近两个月的评分、最后一次实盘下单时间）。
//
// The ambassador customer board: persona mix of direct customers, who went quiet and whose score
// dropped, so the ambassador knows whom to contact first. Shown above the customer list. The switch is
// off by default and the endpoint also needs the view-reports right; on a 403 (or any error) the whole
// block is simply absent.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { personaApi } from '../../api/client'
import type { PersonaBoard, PersonaBoardClient, PersonaFamily } from '../../api/personaTypes'
import { EMPTY } from '../../utils/format'
import { FAMILY_COLOR } from '../persona/personaMeta'
import '../persona/persona.css'

const FAMILIES: PersonaFamily[] = ['strategist', 'maverick', 'executor', 'chaser']
const SHOWN = 8
type Filter = 'attention' | 'all'

export default function AgentBoardPanel() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [board, setBoard] = useState<PersonaBoard | null>(null)
  const [filter, setFilter] = useState<Filter>('attention')
  const [more, setMore] = useState(false)

  useEffect(() => {
    let alive = true
    personaApi.clients().then((b) => { if (alive) setBoard(b) }).catch(() => { /* 开关关着或没权限：不显示 / off or not allowed: hidden */ })
    return () => { alive = false }
  }, [])

  if (!board || board.total === 0) return null
  const attention = board.clients.filter((c) => c.dropped || c.inactive)
  const list = filter === 'attention' ? attention : board.clients
  const shown = more ? list : list.slice(0, SHOWN)
  const withPersona = Math.max(1, board.withPersona)
  const last = (c: PersonaBoardClient) =>
    c.idleDays == null ? t('persona.board.never') : c.idleDays <= 0 ? t('persona.board.today') : t('persona.board.daysAgo', { n: c.idleDays })
  const open = (c: PersonaBoardClient) => navigate('/persona/client', { state: { email: c.email, name: c.nickname || c.email } })

  return (
    <section className="pr-board" aria-labelledby="pr-board-h">
      <div className="pr-board-head">
        <h3 id="pr-board-h">{t('persona.board.title')}</h3>
        <p>{t('persona.board.lead')}</p>
      </div>
      <dl className="pr-board-stats">
        <div><dt>{t('persona.board.total')}</dt><dd className="num">{board.total}</dd></div>
        <div><dt>{t('persona.board.withPersona')}</dt><dd className="num">{board.withPersona}</dd></div>
        <div className={board.dropped ? 'is-warn' : ''}><dt>{t('persona.board.dropped', { p: board.dropPoints ?? 10 })}</dt><dd className="num">{board.dropped}</dd></div>
        <div className={board.inactive ? 'is-warn' : ''}><dt>{t('persona.board.inactive', { d: board.inactiveDays ?? 30 })}</dt><dd className="num">{board.inactive}</dd></div>
      </dl>
      {board.withPersona > 0 && (
        <div className="pr-board-mix">
          <div className="pr-board-bar" aria-hidden="true">
            {FAMILIES.map((f) => (board.families[f] ? <i key={f} style={{ flexGrow: board.families[f], background: FAMILY_COLOR[f].main }} /> : null))}
          </div>
          <ul>
            {FAMILIES.map((f) => (
              <li key={f}>
                <span className="pr-board-dot" style={{ background: FAMILY_COLOR[f].main }} aria-hidden="true" />
                {t(`persona.family.${f}`)}
                <b className="num">{board.families[f] ?? 0}</b>
                <span className="num">{Math.round(((board.families[f] ?? 0) / withPersona) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="pr-board-tabs" role="group">
        {(['attention', 'all'] as Filter[]).map((f) => (
          <button key={f} type="button" aria-pressed={f === filter} className={f === filter ? 'on' : ''} onClick={() => { setFilter(f); setMore(false) }}>
            {t(`persona.board.filter.${f}`)} <span className="num">{f === 'attention' ? attention.length : board.total}</span>
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="pr-board-empty">{t('persona.board.empty')}</p>
      ) : (
        <ul className="pr-board-list">
          {shown.map((c) => (
            <li key={c.email}>
              <div className="pr-board-who">
                <b>{c.nickname || c.email}</b>
                {c.nickname && <span className="num">{c.email}</span>}
              </div>
              <div className="pr-board-persona">
                {c.code && c.family ? (
                  <><span className="pr-board-dot" style={{ background: FAMILY_COLOR[c.family].main }} aria-hidden="true" />{t(`persona.types.${c.code}.title`)}</>
                ) : <span className="pr-board-dim">{t('persona.board.noPersona')}</span>}
              </div>
              <div className="pr-board-score num">
                {c.score ?? EMPTY}
                {c.scoreDelta != null && c.scoreDelta !== 0 && (
                  <small className={c.scoreDelta > 0 ? 'is-up' : 'is-down'}>{c.scoreDelta > 0 ? '▲' : '▼'} {Math.abs(c.scoreDelta)}</small>
                )}
              </div>
              <div className="pr-board-last">
                <span>{last(c)}</span>
                {c.dropped && <span className="pr-board-tag is-down">{t('persona.board.tagDropped')}</span>}
                {c.inactive && <span className="pr-board-tag">{t('persona.board.tagInactive')}</span>}
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => open(c)}>{t('persona.client.button')}</button>
            </li>
          ))}
        </ul>
      )}
      {list.length > SHOWN && (
        <button type="button" className="pr-board-more" onClick={() => setMore((v) => !v)}>
          {more ? t('persona.tags.less') : t('persona.tags.more', { n: list.length - SHOWN })}
        </button>
      )}
    </section>
  )
}
