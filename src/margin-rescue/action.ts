// A confirmed reduction, as the ReduceOnlyGuard sees it. The action id is computed
// here exactly as the contract's actionIdOf computes it (test vector shared with
// contracts/test/unit), so the id persisted before broadcast is the id the guard
// records on chain.
import { randomBytes } from "node:crypto"
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, toBytes, toHex, type Address, type Hex } from "viem"
import { ORDER_TYPE_IOC, reduceGuardAbi } from "./abi.js"
import type { CandidateAnalysis, CandidateResult } from "./candidates.js"
import { sameAddress, type AccountSnapshot } from "./snapshot.js"

export const REDUCE_ACTION_TYPE =
  "ReduceAction(uint256 chainId,address guard,address marginBank,address owner,address pool,int128 expectedSignedSize,bool isBid,uint256 quantity,uint256 limitPrice,uint64 deadline,uint8 orderType,bytes32 nonce)"
export const REDUCE_TYPEHASH = keccak256(toBytes(REDUCE_ACTION_TYPE))

export interface ReduceRequest {
  pool: Address
  expectedSignedSize: bigint
  isBid: boolean
  quantity: bigint
  limitPrice: bigint
  deadline: bigint // unix seconds
  nonce: Hex
}

export interface ActionBinding {
  chainId: number
  guard: Address
  marginBank: Address
  owner: Address
}

export function actionIdOf(b: ActionBinding, r: ReduceRequest): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, uint256, address, address, address, address, int128, bool, uint256, uint256, uint64, uint8, bytes32"), [
      REDUCE_TYPEHASH,
      BigInt(b.chainId),
      b.guard,
      b.marginBank,
      b.owner,
      r.pool,
      r.expectedSignedSize,
      r.isBid,
      r.quantity,
      r.limitPrice,
      r.deadline,
      ORDER_TYPE_IOC,
      r.nonce,
    ]),
  )
}

export function reduceCalldata(r: ReduceRequest): Hex {
  return encodeFunctionData({ abi: reduceGuardAbi, functionName: "reduce", args: [r] })
}

export function newNonce(): Hex {
  return toHex(randomBytes(32))
}

// The request a selected candidate becomes. The expected signed size is the position
// the analysis saw; the guard refuses it if the position has moved since.
export function requestFromCandidate(
  analysis: CandidateAnalysis,
  candidateId: string,
  snapshot: AccountSnapshot,
  opts: { deadlineSeconds: number; nowSeconds: bigint; nonce?: Hex },
): { request: ReduceRequest; candidate: CandidateResult } {
  const candidate = analysis.candidates.find((c) => c.id === candidateId)
  if (!candidate) throw new Error(`no candidate ${candidateId}`)
  if (candidate.kind !== "REDUCE" || candidate.status !== "EVALUATED" || !candidate.reduce) throw new Error(`${candidateId} is not an executable reduction`)
  if (analysis.outcome === "BLOCKED") throw new Error(`analysis is blocked: ${analysis.blockers.join("; ")}`)
  if (candidate.goal !== "MEETS") throw new Error(`${candidateId} does not meet the target under the scenario (${candidate.goal})`)
  const position = snapshot.positions.find((p) => sameAddress(p.pool, candidate.reduce!.pool))
  if (!position) throw new Error("position not in the snapshot")
  if (!Number.isInteger(opts.deadlineSeconds) || opts.deadlineSeconds < 1 || opts.deadlineSeconds > 3600) throw new Error("deadline must be 1..3600 seconds ahead")
  return {
    candidate,
    request: {
      pool: candidate.reduce.pool as Address,
      expectedSignedSize: position.size,
      isBid: candidate.reduce.isBid,
      quantity: candidate.reduce.requestedQuantity,
      limitPrice: candidate.reduce.limitPrice,
      deadline: opts.nowSeconds + BigInt(opts.deadlineSeconds),
      nonce: opts.nonce ?? newNonce(),
    },
  }
}
