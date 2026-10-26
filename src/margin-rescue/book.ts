// IOC fills against a bounded book read, with the venue's per-fill limit: a sell fills
// only at prices at or above its limit, a buy only at or below (both checked on a
// fork of the real venue with depth beyond the limit).
import type { Level } from "./snapshot.js"

export interface Fill {
  price: bigint
  quantity: bigint
}

export interface IocSimulation {
  fills: Fill[]
  filled: bigint
  unfilled: bigint
  // Every level read was inside the limit and the order was still not filled: deeper
  // levels were not read, so the fill could be larger than shown.
  depthReadExhausted: boolean
}

// `levels` are the side being taken, best first: bids for a sell, asks for a buy.
export function simulateIoc(levels: Level[], isBid: boolean, quantity: bigint, limit: bigint): IocSimulation {
  const fills: Fill[] = []
  let remaining = quantity
  let allInside = true
  for (const level of levels) {
    if (remaining === 0n) break
    if (isBid ? level.price > limit : level.price < limit) {
      allInside = false
      break
    }
    const take = level.quantity < remaining ? level.quantity : remaining
    if (take > 0n) fills.push({ price: level.price, quantity: take })
    remaining -= take
  }
  return { fills, filled: quantity - remaining, unfilled: remaining, depthReadExhausted: remaining > 0n && allInside }
}

export function alignDown(value: bigint, step: bigint): bigint {
  return (value / step) * step
}

export function alignUp(value: bigint, step: bigint): bigint {
  return ((value + step - 1n) / step) * step
}

// The protective IOC limit: `slippageBps` beyond the current touch, on the tick, rounded
// toward the trader (a sell's floor rounds up, a buy's ceiling rounds down).
export function protectiveLimit(touch: bigint, isBid: boolean, slippageBps: bigint, tick: bigint): bigint {
  return isBid ? alignDown((touch * (10_000n + slippageBps)) / 10_000n, tick) : alignUp((touch * (10_000n - slippageBps)) / 10_000n, tick)
}
