// The consolidated live-write plan for ONE approval request. Read-only: it reads the
// dedicated test EOA, the BTC/ETH markets and the gas price, and asks the RPC to
// estimate (simulate, unsigned) the guard deployment and the USDso approval. It signs
// nothing and sends nothing; every number below is a proposal until the owner approves.
//
// The plan binds the guard build: the keccak of its creation code, of the exact
// deployment data for this owner, of its source files and of the runtime code the
// deployment must leave on chain. The executor refuses a different build and checks the
// deployed code before granting the guard anything.
import { readFileSync } from "node:fs"
import { encodeFunctionData, getContractAddress, type Abi, type Address, type PublicClient } from "viem"
import { erc20Abi, marginBankAbi, marginBankWriteAbi, PLACE_ORDER_FOR_SELECTOR, perpPoolAbi } from "./abi.js"
import { BTC_POOL, ETH_POOL, MARGIN_BANK, OPERATOR_REGISTRY, USDSO } from "./common.js"
import { alignDown } from "./book.js"
import { MAX_CLOSE_ATTEMPTS } from "./cleanup.js"
import { CLEANUP_GAS_PER_TX, CLEANUP_TX_WORST_CASE, EXIT, LIVE_TIMING } from "./executor.js"
import { guardDeployment, loadGuardArtifact } from "./guardArtifact.js"
import { sha256Hex } from "./json.js"
import { readAt, sampleBlock } from "./rpc.js"

export const TEST_EOA = "0x66C626c59EdDf06a7DCa0401cF20FA2cE7033a12" as Address

export interface LivePlanParams {
  account: Address
  depositUsd: bigint // raw USDso
  btcNotionalUsd: bigint // raw USDso, opening notional of the BTC long
  ethNotionalUsd: bigint // raw USDso, opening notional of the ETH short
  slippageBps: bigint
  lossStopUsd: bigint // SOFT stop: unwind once account equity is found this far below the deposit
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

export async function buildLivePlan(client: PublicClient, guardArtifactPath: URL | undefined, params: LivePlanParams = DEFAULT_PLAN) {
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

  const deployment = guardDeployment(loadGuardArtifact(guardArtifactPath), owner, MARGIN_BANK, [BTC_POOL, ETH_POOL])
  const guardAddress = getContractAddress({ from: owner, nonce: BigInt(nonce) })
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, params.depositUsd] })
  const [deployGas, approveGas] = await Promise.all([
    client.estimateGas({ account: owner, data: deployment.deployData }).catch((e) => `estimate failed: ${String(e.shortMessage ?? e.message).split("\n")[0]}`),
    client.estimateGas({ account: owner, to: USDSO, data: approveData }).catch((e) => `estimate failed: ${String(e.shortMessage ?? e.message).split("\n")[0]}`),
  ])
  const ORDER_GAS_CAP = 10_000_000n // the SDK's per-order gas ceiling; Somnia bills gas used
  // main: deploy, approve, deposit, 2 opens, grant (+1 if a refresh re-confirms on the
  // other pool), reduce; cleanup: the worst case the executor reserves for. Every gas
  // limit is the estimate + 30%, so a per-order ceiling of 10M means up to 13M a send.
  const mainTx = 7n
  const cleanupTx = BigInt(CLEANUP_TX_WORST_CASE)
  const txCount = mainTx + cleanupTx
  const deployCost = typeof deployGas === "bigint" ? (deployGas * 13n) / 10n : CLEANUP_GAS_PER_TX * 3n
  const worstCaseStt = (deployCost + CLEANUP_GAS_PER_TX * (mainTx - 1n) + CLEANUP_GAS_PER_TX * cleanupTx) * gasPrice
  const maxGasPrice = gasPrice * 3n
  const softLossFloor = params.depositUsd - params.lossStopUsd

  const notionalTotal = params.btcNotionalUsd + params.ethNotionalUsd
  const steps = [
    { n: 0, call: "read-only preflight", detail: "read the whole account at one block across all 21 pools: no position, order, live stop, bank balance or allowance; the account nonce (latest and pending) equal to account.nonce below; STT ≥ the gas cap; USDso ≥ the deposit; fresh marks; tick/lot/minimum/fee/MM unchanged from this plan; the local guard build hashes equal guard.* below" },
    { n: 1, call: `deploy ReduceOnlyGuard(owner=${owner}, bank=${MARGIN_BANK}, pools=[BTC, ETH])`, detail: `expected at ${guardAddress} if the account nonce is still ${nonce}; estimated gas ${deployGas}. The code at the new address must hash to guard.expectedRuntimeKeccak and OWNER/MARGIN_BANK/trustedPool must read back before any grant` },
    { n: 2, call: `USDso.approve(${MARGIN_BANK}, ${params.depositUsd})`, to: USDSO, data: approveData, detail: "exact allowance, not unlimited; read back" },
    { n: 3, call: `MarginBank.deposit(${params.depositUsd})`, to: MARGIN_BANK, data: encodeFunctionData({ abi: marginBankWriteAbi, functionName: "deposit", args: [params.depositUsd] }), detail: "afterwards the allowance is 0, so no later order can pull from the wallet" },
    { n: 4, call: `BTC PerpPool.placeOrder(isBid=true, qty=${btcQty}, IOC, limit = best ask + ${params.slippageBps} bps)`, to: BTC_POOL, detail: `opens a BTC long of ~${params.btcNotionalUsd / 10n ** 18n} USDso notional (now: limit ${buyLimit}); refused if BTC moved > 10% since this plan` },
    { n: 5, call: `ETH PerpPool.placeOrder(isBid=false, qty=${ethQty}, IOC, limit = best bid − ${params.slippageBps} bps)`, to: ETH_POOL, detail: `opens an ETH short of ~${params.ethNotionalUsd / 10n ** 18n} USDso notional (now: limit ${sellLimit})` },
    { n: 6, call: "analyse (read-only) and journal the selected candidate as NOT_SENT", detail: `scenario ${JSON.stringify(params.shocksBps)} bps, target buffer ${params.targetBufferUsd / 10n ** 18n} USDso; up to nine candidates; nothing is sent if no action is needed or none is feasible` },
    { n: 7, call: `OperatorPermissionsRegistry(${OPERATOR_REGISTRY}).setOperatorApprovalForPool(<selected pool>, <guard>, [${PLACE_ORDER_FOR_SELECTOR}], true)`, detail: "placeOrderFor only, on the one pool of the selected candidate; read back" },
    { n: 8, call: "refresh (read-only)", detail: "read the whole account again; a changed position, collateral, order, stop, allowance or risk setting, a different selection under the SAME scenario, a different expected fill at the confirmed limit, or < 30 s to the deadline invalidates the confirmation (it is never sent). One new confirmation may be made under the same scenario; a second invalidation stops the reduction" },
    { n: 9, call: "guard.reduce(<confirmed request>)", detail: `one IOC through the guard: exact expected signed position, deadline ${LIVE_TIMING.deadlineSeconds} s after the analysis block` },
    { n: 10, call: "bind the receipt and recompute (read-only)", detail: "sender, guard, calldata, action id, pool, quantity, limit and blocks must match the saved confirmation; then fills, ledger, post snapshot at the receipt block, same scenario prices" },
    { n: 11, call: "cleanup: grant the guard on the other pool, then guard.reduce(full close) per remaining leg", detail: `every cleanup order goes through the guard with the exact position just read and a ${params.slippageBps} bps protective limit; at most 3 attempts per leg; no unguarded fallback — a leg the guard cannot close is reported` },
    { n: 12, call: `setOperatorApprovalForPool(<pool>, <guard>, [${PLACE_ORDER_FOR_SELECTOR}], false) for every granted pool`, detail: "cleanup: revoke" },
    { n: 13, call: "MarginBank.withdraw(<whole unlocked balance>)", to: MARGIN_BANK, detail: "cleanup: only once no position or order remains" },
    { n: 14, call: `USDso.approve(${MARGIN_BANK}, 0)`, to: USDSO, detail: "cleanup: only if an allowance is left" },
    { n: 15, call: "verify (read-only)", detail: "one block: no position in any of the 21 pools, no order, no live stop, bank balance 0, allowance 0, no grant to the guard on any pool or globally, no unresolved transaction" },
  ]
  return {
    version: "mr-live-plan/4",
    status: "PROPOSAL — not authorised; nothing in this file has been signed or sent",
    readAt: { block: block.number, hash: block.hash, timestamp: block.timestamp },
    account: { address: owner, stt, usdso, allowanceToBank: allowance, nonce, bank: state },
    scenario: { shocksBps: params.shocksBps, targetBufferUsdso: params.targetBufferUsd },
    network: { chainId: 50383, gasPrice, maxGasPrice, forbidden: ["any other chain or mainnet", "Perps Arena / smart wallets", "transfers to any other address", "TP/SL stops", "EIP-7702"] },
    guard: {
      expectedAddress: guardAddress,
      constructorArgs: { owner, marginBank: MARGIN_BANK, pools: [BTC_POOL, ETH_POOL] },
      creationCodeKeccak: deployment.creationCodeKeccak,
      deployDataKeccak: deployment.deployDataKeccak,
      expectedRuntimeKeccak: deployment.expectedRuntimeKeccak,
      runtimeBytes: deployment.runtimeBytes,
      compiler: deployment.compiler,
      optimizer: deployment.optimizer,
      sourceSha256: deployment.sourceSha256,
    },
    markets: markets.map((m) => ({ ...m })),
    bounds: {
      maxDepositUsdso: params.depositUsd,
      maxAllowanceUsdso: params.depositUsd,
      openingNotionalUsdso: { btcLong: params.btcNotionalUsd, ethShort: params.ethNotionalUsd, total: notionalTotal },
      openingQuantities: { btc: btcQty, eth: ethQty },
      maxSlippageBpsPerOrder: params.slippageBps,
      softLossStopUsdso: params.lossStopUsd,
      softLossStop: `SOFT stopping threshold, not a loss cap: E_total is checked after each opening order and after the reduction; once it is found below ${softLossFloor / 10n ** 18n} USDso (a ${params.lossStopUsd / 10n ** 18n} USDso loss) the run stops and unwinds. Prices can move between checks and the unwind itself pays spread and slippage, so the realised loss can exceed ${params.lossStopUsd / 10n ** 18n} USDso; it cannot exceed the ${params.depositUsd / 10n ** 18n} USDso deposited`,
      gas: {
        deployEstimate: deployGas,
        approveEstimate: approveGas,
        perOrderCap: ORDER_GAS_CAP,
        transactions: txCount,
        sttCap: params.sttCap,
        worstCaseSttAtCurrentPrice: worstCaseStt,
        cleanupReserve: `every main-phase send must leave, at the current gas price and both under the cap and in the wallet, ${CLEANUP_GAS_PER_TX} gas for each cleanup transaction the run could need if it stopped right after that send (per open leg a grant and up to ${MAX_CLOSE_ATTEMPTS} guarded closes, a revoke per pool, a withdrawal, an allowance reset; at most ${CLEANUP_TX_WORST_CASE} for this plan), plus the worst-case fee of any unresolved transaction`,
      },
    },
    execution: {
      timing: LIVE_TIMING,
      unknownTransactions: "every transaction is persisted (hash, nonce, intent) before broadcast and resolved before anything else is sent, never re-sent. Only a canonical receipt settles it; it counts as not included only when the node rejected it or the transaction that consumed its nonce was located and is a different one. A failed lookup or a bare nonce increase leaves it UNKNOWN, with its worst-case fee still reserved; the run then stops with exit 40 and is resumed with --resume",
      refusal: "a run that stops before its first signature (failed preflight, read failure, a step that would revert in simulation) exits 1 and runs no cleanup, so it never touches collateral, allowances or positions it did not create; a run whose signed transactions never reached the node exits 2, also without cleanup",
      unexpectedErrors: "an error the executor does not handle is classified from the persisted run ledger and this process's own count of signatures and broadcasts: 1 only when nothing was signed, 2 when nothing was broadcast, 40 when any step is pending or unknown, 50 when transactions reached the network and none is unresolved, 60 when the ledger cannot be read. The classification is written to result.json and results.jsonl; nothing is started again automatically, and a fresh run is refused while an earlier run of the account is unresolved",
      exitCodes: EXIT,
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


// Load a plan file for execution: its SHA-256 must be the digest the owner approved.
export function readApprovedPlan(path: string, approvedDigest: string): { plan: LivePlan; digest: string } {
  const bytes = readFileSync(path)
  const digest = sha256Hex(bytes)
  if (digest !== approvedDigest.toLowerCase()) throw new Error(`plan digest ${digest} is not the approved digest; refusing`)
  const plan = JSON.parse(bytes.toString("utf8"), (_k, v) => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : v)) as LivePlan
  if (plan.version !== "mr-live-plan/4") throw new Error(`plan version ${plan.version} is not executable by this build; regenerate it with npm run mr -- live-plan`)
  if (plan.network.chainId !== 50383) throw new Error("the plan is not for chain 50383")
  return { plan, digest }
}
