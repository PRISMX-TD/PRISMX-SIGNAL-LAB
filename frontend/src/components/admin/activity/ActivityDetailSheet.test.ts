// 详情抽屉「修改前 / 修改后」表：项目列是和句子同一套的人话标签（不是 plan_expires_at、
// setting:pricing:pro_monthly_price 这类字段名），值能翻的翻（角色、自动仓管的 R），审计表里
// Python str(datetime) 写法的时刻（空格分隔、可能不带时区）也换成北京时间。
// The drawer's before / after table: the field column uses the sentences' human labels (not
// plan_expires_at or setting:pricing:pro_monthly_price), values are translated where possible
// (roles, auto-manage R), and Python str(datetime) instants (space separated, maybe zoneless)
// are shown in Beijing time like everything else.
import { describe, expect, it } from 'vitest'
import { changeCells, changeRows, showValue } from './ActivityDetailSheet'
import { makeT } from './testT'

const zh = makeT('zh')
const en = makeT('en')

const auditRow = (field: string, old: string | null, nw: string | null) => ({
  id: `a-${field}`,
  field,
  old,
  new: nw,
  actor: null,
  target: { id: 'u1', nickname: '美琳', email: 'meilin@example.com' },
  op_id: null,
  created_at: '2026-10-09T06:00:00.000000Z',
})

describe('修改前 / 修改后 / before and after table', () => {
  it('修改用户：字段翻成人话、角色翻译、str(datetime) 换北京时间 / user edit: labels, roles and stored times', () => {
    const raw = {
      rows: [
        auditRow('role', 'user', 'admin'),
        // services/audit.log_change 存的是 str(datetime)：空格分隔，可能不带时区（按 UTC）
        // log_change stores str(datetime): a space, maybe no zone (UTC)
        auditRow('plan_expires_at', '2026-10-09 00:00:00', '2026-11-09 00:00:00+00:00'),
        auditRow('plan_note', null, '老客户续费'),
      ],
    }
    const cells = changeCells('admin.user_edit', raw, null, zh)
    expect(cells.map((c) => [c.label, c.before, c.after])).toEqual([
      ['角色', '普通用户', '管理员'],
      ['到期时间', '2026-10-09 08:00:00 UTC+8', '2026-11-09 08:00:00 UTC+8'],
      ['备注', '—', '老客户续费'],
    ])
    // 原字段名还在（单元格的 title 里给查问题的人）/ the raw field name is kept for the cell title
    expect(cells.map((c) => c.field)).toEqual(['role', 'plan_expires_at', 'plan_note'])
    expect(changeCells('admin.user_edit', raw, null, en).map((c) => c.label)).toEqual(['Role', 'Expiry', 'Note'])
  })

  it('平台设置、游戏化、邀请链接、停用、工单：都不出原字段名 / settings, gamification, invite, disable, ticket: no raw names', () => {
    const label = (kind: string, field: string, old: string | null, nw: string | null) =>
      changeCells(kind, { rows: [auditRow(field, old, nw)] }, null, zh).map((c) => c.label)
    expect(label('admin.setting', 'setting:pricing:pro_monthly_price', '29', '39')).toEqual(['月付价格'])
    expect(label('admin.setting', 'setting:broker_lock_enabled', 'false', 'true')).toEqual(['启用券商限制'])
    // 旧式整组行：JSON 拆开后每一项是该组的一个设置 / legacy whole-group row: each split key is a setting
    expect(label('admin.setting', 'setting:pricing', null, '{"pro_monthly_price": 39, "sale_enabled": true}')).toEqual(['月付价格', '促销'])
    expect(label('admin.gamification', 'gamification:min_trades_return', '5', '8')).toEqual(['收益榜最少交易笔数'])
    expect(label('admin.invite_link', 'invite:ab12cd34', '{"isActive": true}', '{"isActive": false}')).toEqual(['启用'])
    expect(label('admin.user_disable', 'account:disable', '{"disabledAt": null, "reason": null}', '{"disabledAt": "2026-10-09T06:00:00+00:00", "reason": "刷单"}')).toEqual(['停用时间', '原因'])
    expect(label('admin.ticket', 'ticket:t1:status', 'open', 'closed')).toEqual(['状态'])
    expect(label('plan.trial_claim', 'plan:trial_claim', 'FREE', 'PRO(7d)')).toEqual(['等级'])
    // 认不出的原样显示，绝不丢 / unknown names show verbatim, never dropped
    expect(label('admin.other', 'something:new', null, 'x')).toEqual(['something:new'])
  })

  it('会员审计值 PRO(<时间>) / PRO(7d) 也翻成人话 / membership values PRO(<time>) and PRO(7d)', () => {
    expect(showValue('PRO(2026-11-09 00:00:00+00:00)', zh)).toBe('PRO，到期 2026-11-09 08:00:00 UTC+8')
    expect(showValue('PRO(7d)', zh)).toBe('PRO，7 天')
    expect(showValue('FREE(None)', zh)).toBe('FREE')
    expect(showValue('2026-10-09T06:00:00+00:00', zh)).toBe('2026-10-09 14:00:00 UTC+8')
    expect(showValue('普通文字', zh)).toBe('普通文字')
  })

  it('自动仓管设置：用列表行的 changes，标签与 R 倍数和句子一致 / auto-manage settings match the sentence', () => {
    const params = { changes: [{ field: 'beTriggerR', old: 1.5, new: 2 }, { field: 'trailEnabled', old: false, new: true }, { field: 'ptpFraction', old: 0.5, new: 0.3 }] }
    expect(changeCells('auto.settings', { kind: 'auto.settings', data: {} }, params, zh).map((c) => [c.label, c.before, c.after])).toEqual([
      ['保本触发', '1.5R', '2R'],
      ['追踪止损', '关', '开'],
      ['分批止盈比例', '50%', '30%'],
    ])
  })

  it('详情没到之前用列表行的 changes，设置项按组拼回字段 / before the detail lands, list-row changes are used', () => {
    const params = { group: 'pricing', changes: [{ group: 'pricing', key: 'pro_monthly_price', old: 29, new: 39 }] }
    expect(changeRows(null, params).map((r) => r.field)).toEqual(['setting:pricing:pro_monthly_price'])
    expect(changeCells('admin.setting', null, params, zh).map((c) => [c.label, c.before, c.after])).toEqual([['月付价格', '29', '39']])
  })
})
