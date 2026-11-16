import { describe, expect, it } from 'vitest'
import type { Order, Position } from '../api/types'
import { createOverlay, overlayRows, rowFromReceipt, rowKey, OPTIMISTIC_TTL_MS } from './optimisticRows'

const pos = (ticket: number, login = '100959', extra: Partial<Position> = {}): Position => ({
  ticket, symbol: 'XAUUSD', side: 'BUY', volume: 0.01, profit: 1, login, ...extra,
})

const order = (extra: Partial<Order> = {}): Order => ({
  id: 'o1',
  clientOrderId: 'c1',
  signalId: null,
  action: 'ORDER',
  symbol: 'XAUUSD',
  side: 'BUY',
  volume: 0.01,
  mt5Login: '100959',
  status: 'FILLED',
  mt5Ticket: 555,
  filledPrice: 2650.5,
  message: null,
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  ...extra,
})

describe('overlayRows', () => {
  it('returns the server frame itself when nothing is overlaid', () => {
    const server = [pos(1)]
    expect(overlayRows(server, createOverlay<Position>(), 0)).toBe(server)
  })

  it('shows an added row until a frame contains it, then drops the overlay', () => {
    const ov = createOverlay<Position>()
    const mine = pos(9, '100959', { profit: 0 })
    ov.added.set(rowKey(mine)!, { item: mine, at: 1000 })
    // 早于成交的一帧还没有它：叠加层补上 / a frame from before the fill: overlay fills it in
    const before = overlayRows([pos(1)], ov, 1500)
    expect(before.map((p) => p.ticket)).toEqual([1, 9])
    // 服务器帧带上了它：以服务器的为准，叠加项撤掉 / the server has it now: server wins
    const real = pos(9, '100959', { profit: -0.2 })
    const after = overlayRows([pos(1), real], ov, 2500)
    expect(after[1]).toBe(real)
    expect(ov.added.size).toBe(0)
  })

  it('expires an added row the server never confirms', () => {
    const ov = createOverlay<Position>()
    const mine = pos(9)
    ov.added.set(rowKey(mine)!, { item: mine, at: 0 })
    const server = [pos(1)]
    expect(overlayRows(server, ov, OPTIMISTIC_TTL_MS + 1)).toBe(server)
    expect(ov.added.size).toBe(0)
  })

  it('hides a removed row until a frame no longer has it', () => {
    const ov = createOverlay<Position>()
    ov.removed.set(rowKey(pos(2))!, 1000)
    expect(overlayRows([pos(1), pos(2)], ov, 1500).map((p) => p.ticket)).toEqual([1])
    expect(ov.removed.size).toBe(1)
    // 服务器那边也没了：撤掉叠加项 / the server dropped it too: overlay entry goes
    overlayRows([pos(1)], ov, 2000)
    expect(ov.removed.size).toBe(0)
  })

  it('keys by login so the same ticket on another account is untouched', () => {
    const ov = createOverlay<Position>()
    ov.removed.set(rowKey(pos(2, 'A'))!, 0)
    expect(overlayRows([pos(2, 'B')], ov, 10).map((p) => p.login)).toEqual(['B'])
  })
})

describe('rowFromReceipt', () => {
  it('builds a position from a filled market order with the SL/TP that was sent', () => {
    const r = rowFromReceipt(order(), { stopLoss: 2600, takeProfit: null })
    expect(r).toEqual({
      kind: 'position',
      row: {
        ticket: 555, symbol: 'XAUUSD', side: 'BUY', volume: 0.01, profit: 0,
        entryPrice: 2650.5, currentPrice: 2650.5, stopLoss: 2600, takeProfit: undefined, login: '100959',
      },
    })
  })

  it('builds a pending order from a placed pending command', () => {
    const r = rowFromReceipt(order({ action: 'PENDING', status: 'PLACED', pendingType: 'BUY_LIMIT', price: 2600, filledPrice: null }))
    expect(r?.kind).toBe('pending')
    expect(r?.row).toMatchObject({ ticket: 555, type: 'BUY_LIMIT', price: 2600 })
  })

  it('draws nothing for unanswered, rejected or ticketless receipts', () => {
    expect(rowFromReceipt(order({ status: 'PENDING' }))).toBeNull()
    expect(rowFromReceipt(order({ status: 'REJECTED' }))).toBeNull()
    expect(rowFromReceipt(order({ mt5Ticket: null }))).toBeNull()
    // 平仓 / 改单回执不是开仓 / close and modify receipts open nothing
    expect(rowFromReceipt(order({ action: 'CLOSE' }))).toBeNull()
  })
})
