// The consolidated live-write plan for ONE approval request. Read-only: it reads the
// dedicated test EOA, the BTC/ETH markets and the gas price, and asks the RPC to
// estimate (simulate, unsigned) the guard deployment and the USDso approval. It signs
// nothing and sends nothing; every number below is a proposal until the owner approves.
import { readFileSync } from "node:fs"
import { encodeDeployData, encodeFunctionData, type Abi, type Address, type Hex, type PublicClient } from "viem"
import { erc20Abi, marginBankAbi, marginBankWriteAbi, PLACE_ORDER_FOR_SELECTOR, perpPoolAbi } from "./abi.js"
import { BTC_POOL, ETH_POOL, MARGIN_BANK, OPERATOR_REGISTRY, USDSO } from "./common.js"
import { alignDown } from "./book.js"
import { readAt, sampleBlock } from "./rpc.js"

export const TEST_EOA = "0x66C626c59EdDf06a7DCa0401cF20FA2cE7033a12" as Address

export interface LivePlanParams {
  account: Address
  depositUsd: bigint // raw USDso
  btcNotionalUsd: bigint // raw USDso, opening notional of the BTC long
  ethNotionalUsd: bigint // raw USDso, opening notional of the ETH short
  slippageBps: bigint
  lossStopUsd: bigint // stop and unwind if account equity falls this far below the deposit
  sttCap: bigint // raw STT for all gas
  shocksBps: Record<string, number> // the scenario the analysis will use
  targetBufferUsd: bigint // raw USDso
}

export const DEFAULT_PLAN: LivePlanParams = {
  account: TEST_EOA,
  depositUsd: 60n * 10n ** 18n,
  btcNotionalUsd: 100n * 10n ** 18n,
  ethNotionalUsd: 90n * 10n ** 18n,
  slippageBps: 50n,
  lossStopUsd: 15n * 10n ** 18n,
  sttCap: 2n * 10n ** 18n,
  // BTC down and ETH up stresses both legs of a BTC-long / ETH-short book. With the
  // opening sizes above the no-action buffer lands near 41 USDso, so a 45 USDso target
  // needs a reduction; if the baseline meets it anyway, nothing is sent but cleanup.
  shocksBps: { BTC: -1_000, ETH: 500 },
  targetBufferUsd: 45n * 10n ** 18n,
}

interface Market {
  pool: Address
  symbol: string
  mark: bigint
  bestBid: bigint
  bestAsk: bigint
  tick: bigint
  lot: bigint
  min: bigint
  oneBase: bigint
  imBps: bigint
  mmBps: bigint
  takerFee: bigint
}

export type LivePlan = Awaited<ReturnType<typeof buildLivePlan>>

export async function buildLivePlan(client: PublicClient, guardArtifactPath: URL, params: LivePlanParams = DEFAULT_PLAN) {
  const owner = params.account
  const block = await sampleBlock(client)
  const at = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => readAt<T>(client, block, { address, abi, functionName, args })
  const [stt, usdso, allowance, state, nonce, gasPrice] = await Promise.all([
    client.getBalance({ address: owner, blockNumber: block.number }),
    at<bigint>(USDSO, erc20Abi, "balanceOf", [owner]),
    at<bigint>(USDSO, erc20Abi, "allowance", [owner, MARGIN_BANK]),
    at<{ unlockedCollateralBalance: bigint; lockedCollateral: bigint; activePerpPools: readonly Address[] }>(MARGIN_BANK, marginBankAbi, "getAccountState", [owner]),
    client.getTransactionCount({ address: owner, blockNumber: block.number }),
    client.getGasPrice(),
  ])
  const markets = await Promise.all([market(at, BTC_POOL, "BTC", 8), market(at, ETH_POOL, "ETH", 18)])
  const [btc, eth] = markets
  const btcQty = alignDown((params.btcNotionalUsd * btc.oneBase) / btc.mark, btc.lot)
  const ethQty = alignDown((params.ethNotionalUsd * eth.oneBase) / eth.mark, eth.lot)
  const buyLimit = alignDown((btc.bestAsk * (10_000n + params.slippageBps)) / 10_000n, btc.tick)
  const sellLimit = ((eth.bestBid * (10_000n - params.slippageBps)) / 10_000n / eth.tick + 1n) * eth.tick

  const artifact = JSON.parse(readFileSync(guardArtifactPath, "utf8")) as { abi: Abi; bytecode: { object: Hex } }
  const deployData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner, MARGIN_BANK, [BTC_POOL, ETH_POOL]] })
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, params.depositUsd] })
  const [deployGas, approveGas] = await Promise.all([
    client.estimateGas({ account: owner, data: deployData }).catch((e) => `estimate failed: ${String(e.shortMessage ?? e.message).split("\n")[0]}`),
    client.estimateGas({ account: owner, to: USDSO, data: approveData }).catch((e) => `estimate failed: ${String(e.shortMessage ?? e.message).split("\n")[0]}`),
  ])
  const ORDER_GAS_CAP = 10_000_000n // the SDK's per-order gas ceiling; Somnia bills gas used
  const txCount = 12n
  const gasCapStt = typeof deployGas === "bigint" ? (deployGas * 2n + ORDER_GAS_CAP * (txCount - 1n)) * gasPrice : ORDER_GAS_CAP * txCount * gasPrice

  const notionalTotal = params.btcNotionalUsd + params.ethNotionalUsd
  const steps = [
    { n: 0, call: "read-only preflight", detail: "re-read STT/USDso balances, bank state, both books and marks; abort if any balance is short, a mark is stale, a fee is non-zero, or the account already holds positions" },
    { n: 1, call: `USDso.approve(${MARGIN_BANK}, ${params.depositUsd})`, to: USDSO, data: approveData, detail: "exact allowance, not unlimited" },
    { n: 2, call: `MarginBank.deposit(${params.depositUsd})`, to: MARGIN_BANK, data: encodeFunctionData({ abi: marginBankWriteAbi, functionName: "deposit", args: [params.depositUsd] }) },
    { n: 3, call: `BTC PerpPool.placeOrder(isBid=true, qty=${btcQty}, limit=${buyLimit}, IOC)`, to: BTC_POOL, detail: `opens a BTC long of ~${params.btcNotionalUsd / 10n ** 18n} USDso notional; limit re-derived at send time as best ask + ${params.slippageBps} bps` },
    { n: 4, call: `ETH PerpPool.placeOrder(isBid=false, qty=${ethQty}, limit=${sellLimit}, IOC)`, to: ETH_POOL, detail: `opens an ETH short of ~${params.ethNotionalUsd / 10n ** 18n} USDso notional; limit re-derived at send time as best bid − ${params.slippageBps} bps` },
    { n: 5, call: `deploy ReduceOnlyGuard(owner=${owner}, bank=${MARGIN_BANK}, pools=[BTC, ETH])`, detail: `estimated gas ${deployGas}` },
    { n: 6, call: `OperatorPermissionsRegistry(${OPERATOR_REGISTRY}).setOperatorApprovalForPool(<selected pool>, <guard>, [${PLACE_ORDER_FOR_SELECTOR}], true)`, detail: "placeOrderFor only, on the one pool of the selected candidate" },
    { n: 7, call: "analyse (read-only) and journal the selected candidate as NOT_SENT", detail: `scenario ${JSON.stringify(params.shocksBps)} bps, target buffer ${params.targetBufferUsd / 10n ** 18n} USDso; up to nine candidates evaluated; nothing is sent if no action is needed or none is feasible` },
    { n: 8, call: "guard.reduce(<confirmed request>)", detail: "one IOC through the guard; exact expected position, deadline ≤ 120 s" },
    { n: 9, call: "npm run mr -- recompute", detail: "receipt, fills, ledger, post snapshot, same scenario" },
    { n: 10, call: `setOperatorApprovalForPool(<pool>, <guard>, [${PLACE_ORDER_FOR_SELECTOR}], false)`, detail: "cleanup: revoke the grant" },
    { n: 11, call: "PerpPool.placeOrder IOC on each remaining leg (sell BTC / buy ETH) with protective limits", detail: "cleanup: close every remaining position; repeat only after a fresh read" },
    { n: 12, call: "MarginBank.withdraw(<unlocked balance>)", to: MARGIN_BANK, detail: "cleanup: return collateral to the EOA wallet" },
    { n: 13, call: `USDso.approve(${MARGIN_BANK}, 0)`, to: USDSO, detail: "cleanup: clear any allowance left" },
  ]
  return {
    version: "mr-live-plan/1",
    status: "PROPOSAL — not authorised; nothing in this file has been signed or sent",
    readAt: { block: block.number, hash: block.hash, timestamp: block.timestamp },
    account: { address: owner, stt, usdso, allowanceToBank: allowance, nonce, bank: state },
    scenario: { shocksBps: params.shocksBps, targetBufferUsdso: params.targetBufferUsd },
    network: { chainId: 50383, gasPrice, forbidden: ["any other chain or mainnet", "Perps Arena / smart wallets", "transfers to any other address", "TP/SL stops", "EIP-7702"] },
    markets: markets.map((m) => ({ ...m })),
    bounds: {
      maxDepositUsdso: params.depositUsd,
      maxAllowanceUsdso: params.depositUsd,
      openingNotionalUsdso: { btcLong: params.btcNotionalUsd, ethShort: params.ethNotionalUsd, total: notionalTotal },
      openingQuantities: { btc: btcQty, eth: ethQty },
      maxSlippageBpsPerOrder: params.slippageBps,
      lossStop: `unwind (steps 10–13) if E_total falls below ${(params.depositUsd - params.lossStopUsd) / 10n ** 18n} USDso, i.e. a loss of ${params.lossStopUsd / 10n ** 18n} USDso`,
      maxLossUsdso: params.lossStopUsd,
      gas: { deployEstimate: deployGas, approveEstimate: approveGas, perOrderCap: ORDER_GAS_CAP, transactions: txCount, sttCap: params.sttCap, worstCaseSttAtCurrentPrice: gasCapStt },
    },
    steps,
  }
}

async function market(at: <T>(address: Address, abi: Abi, fn: string, args?: readonly unknown[]) => Promise<T>, pool: Address, symbol: string, decimals: number): Promise<Market> {
  type Snap = readonly [boolean, { oneBase: bigint; markPrice: bigint; maintenanceMarginBps: bigint; effectiveIMFBps: bigint }]
  const [snap, grid, params, bids, asks] = await Promise.all([
    at<Snap>(pool, perpPoolAbi, "tryGetHealthSnapshot"),
    at<{ tickSize: bigint; minQuantity: bigint; lotSize: bigint }>(pool, perpPoolAbi, "getOrderBookParameters"),
    at<{ takerFeeBpsTimes1k: bigint }>(pool, perpPoolAbi, "getPerpPoolParameters"),
    at<readonly { price: bigint; quantity: bigint }[]>(pool, perpPoolAbi, "getBookLevels", [true, 1n]),
    at<readonly { price: bigint; quantity: bigint }[]>(pool, perpPoolAbi, "getBookLevels", [false, 1n]),
  ])
  if (!snap[0]) throw new Error(`${symbol}: mark is stale`)
  return {
    pool,
    symbol,
    mark: snap[1].markPrice,
    bestBid: bids[0]?.price ?? 0n,
    bestAsk: asks[0]?.price ?? 0n,
    tick: grid.tickSize,
    lot: grid.lotSize,
    min: grid.minQuantity,
    oneBase: 10n ** BigInt(decimals),
    imBps: snap[1].effectiveIMFBps,
    mmBps: snap[1].maintenanceMarginBps,
    takerFee: params.takerFeeBpsTimes1k,
  }
}

