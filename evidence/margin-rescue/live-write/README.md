# live-write: run 1, verified (`VERIFIED_COMPLETE`)

One live run of Margin Rescue on the Somnia Hideki testnet (chain 50383), 2026-10-28 between
08:00 and 08:09 UTC, on the project's dedicated test account
`0x66C626c59EdDf06a7DCa0401cF20FA2cE7033a12`, under the plan authorized before it:
`mr-live-plan/4`, read at block 34,756,532, SHA-256
`7f0903286d5f59cbb98abb739aea9873ef68e6466231bdd355bcd4e1ea3d1175` (committed on 2026-10-27 as
`../live-read-only/live-plan.json` and `../live-read-only/authorized/<sha256>.json`). The owner
explicitly authorized the run, which was signed by a local process using the account's key.
The key was never printed, embedded in command text, or included in this repository or the run's files. The
code was the working tree at commit `83dc3f9`, whose contracts, `src/` and `tools/` are those of
`9fd1c0e` (`../versions.json`). Its evidence is `run-1/`.

| | Result | Evidence |
|---|---|---|
| Execution | `COMPLETE` (exit 0): 13 transactions, every one successful; one guarded reduction; 0.173503 STT of gas against the 2 STT cap | `run-1/result.json`, `run-1/run-ledger.json` |
| Rescue goal | `GOAL_MET`: the buffer under the fixed scenario went from 40.538097 to 46.785772 USDso against a 45 USDso target | `run-1/recompute.txt`, `run-1/recompute.json` |
| Cleanup | Verified: both legs closed through the guard, both grants revoked, collateral withdrawn, allowance zero; nothing remains | `run-1/cleanup.json` |
| Independent read-back | 93 / 93 checks hold, read from the chain without the executor's code | `run-1/verification.txt`, `run-1/verification.json` |

## The fixed scenario and the candidates

The run analysed the account right after both opening orders, at block 35,214,112, and fixed
the scenario there (id `e6e9aecb…c68b2097b`, `run-1/scenario.json`): BTC −10% and ETH +5% from
that block's marks, held as absolute prices for every later valuation.

| Market | Mark at block 35,214,112 | Fixed scenario price |
|---|---|---|
| BTC | 81,030.0913 | 72,927.0822 (−10%) |
| ETH | 2,361.6713 | 2,479.7549 (+5%) |

Doing nothing leaves a scenario buffer of 40.538097 USDso, below the 45 USDso target. Every
candidate was previewed against the order book at that block (`run-1/analysis.txt`):

| Candidate | Notional cut now (USDso) | Scenario buffer (USDso) | Target |
|---|---|---|---|
| None | 0 | 40.538097 | fails |
| BTC-25 | 25.11 | 43.676040 | fails |
| **BTC-50** | **50.23** | **46.813982** | **meets: selected** |
| BTC-75 | 75.35 | 49.951925 | meets |
| BTC-100 | 100.47 | 53.089867 | meets |
| ETH-25 | 22.67 | 42.260422 | fails |
| ETH-50 | 45.34 | 43.982746 | fails |
| ETH-75 | 68.01 | 45.705071 | meets |
| ETH-100 | 90.68 | 47.427395 | meets |

Among the candidates that meet the target, the smallest current notional cut is preferred:
BTC-50, a sell of 0.00062 BTC (half the long) with a limit of 80,820.2. That is a choice among
the evaluated candidates, not a global optimum.

## The guarded reduction and the recomputation

The account was read again right before sending (`run-1/refresh-1.json`: `STILL_VALID`, no
funding drift), and the reduction was sent through the guard under the journalled confirmation
(action `0x8b144300…db3f7fcb`): transaction
`0xa2d0956700fffed458c615b33c3129464e23b119012b5fb2356501478cbe3800`, block 35,214,789. It
filled the requested 0.00062 BTC at 81,180.8, inside its limit; the receipt is bound to the
confirmation and the bank's ledger is explained by the transaction's own rows (17 / 17 checks,
realized PnL −0.038243 USDso, no funding, no fee). Valued again at the same fixed prices:

| At the fixed scenario prices | E_risk | MM | Buffer (USDso) |
|---|---|---|---|
| Before (block 35,214,788) | 45.179402 | 4.641304 | 40.538097 |
| Forecast | 50.303589 | 3.510934 | 46.792654 |
| Actual (block 35,214,789) | 50.296707 | 3.510934 | 46.785772 |

The actual buffer is 0.006882 USDso below the forecast and 1.785772 above the target: `GOAL_MET`.

## Every transaction

| # | Step | Block | Fee (STT, exact) | Transaction |
|---|---|---|---|---|
| 1 | Deploy `ReduceOnlyGuard` at `0x8EE26fFEEeB61A91b0fCdfb4E026D1A2650A367F` (runtime keccak `0x83729369…1271a14b`, as the plan states) | 35,213,160 | 0.0922275 | `0x217790669ccdbe2f3cfb2e49e3d1a98430eed711dc028c34a7b41b2f0f18c01e` |
| 2 | Approve 60 USDso to the bank | 35,213,431 | 0.001563606 | `0x2bdbecd06c72a9c5359416116a9a58081319e00b11c386ddf11dbe28c35b4c8b` |
| 3 | Deposit 60 USDso | 35,213,634 | 0.003127782 | `0xb036b655197957f339ab38373b2933214aebe15287e264c919c4c42c941f44f3` |
| 4 | Open the BTC long (IOC) | 35,214,008 | 0.020350572 | `0x573b4ba25ae67a6b5f0da33d4fb29c7c8359c508f151698c28f84ddf33a5f6ec` |
| 5 | Open the ETH short (IOC) | 35,214,080 | 0.016545066 | `0xdfed8630aca72acb751dc99b864bb1cb807030b6ca505e335d0a28e218308813` |
| 6 | Grant the guard `placeOrderFor` on the BTC pool | 35,214,394 | 0.001820526 | `0xa5c643c5501990951b91fd0dfb606ad048615a6a7a50a91f4265f857bcf7a6bb` |
| 7 | The guarded reduction (BTC-50) | 35,214,789 | 0.011484582 | `0xa2d0956700fffed458c615b33c3129464e23b119012b5fb2356501478cbe3800` |
| 8 | Cleanup: guarded close of the BTC long | 35,215,789 | 0.011630616 | `0x417d4382ded716c2610c22a447dc8759ff1c6cc6b1055ee9c7e9f79592764f43` |
| 9 | Cleanup: grant on the ETH pool | 35,216,273 | 0.001820526 | `0xaddc5fa5a73f2d86637ded21c4cf3e7fc1aa1010337067b083d93996c349f5a1` |
| 10 | Cleanup: guarded close of the ETH short | 35,216,323 | 0.011146356 | `0x582cd390f27b783091a14f0c8ab8879c4db8480d8fb5262352dfd0dea2626d6d` |
| 11 | Cleanup: revoke the BTC grant | 35,216,787 | 0.000620544 | `0xb2fa781249f8ef62bdf60fa7e8ddf937ca3a023579c7ac36398915d7053ba0c0` |
| 12 | Cleanup: revoke the ETH grant | 35,216,840 | 0.000620544 | `0x00e662c3dda41f32cf429ec729a5c8a0e18110aa0fe39106d1f7c13c3147e376` |
| 13 | Cleanup: withdraw the collateral | 35,217,219 | 0.000544686 | `0xed977169d710ccd9df3716e762cee51367754f22e07b2294a181201be99aa528` |

No other transaction came from the account. The deposit used exactly the approved 60 USDso, so
the allowance was already zero and the plan's allowance reset was not needed.

The account's own IOC orders filled:

| Order | Side | Quantity | Price | Limit |
|---|---|---|---|---|
| Open the BTC long | buy | 0.00019 BTC | 81,234.10 | 81,645.10 |
| | buy | 0.00105 BTC | 81,244.00 | 81,645.10 |
| Open the ETH short | sell | 0.0384 ETH | 2,362.32 | 2,350.36 |
| The guarded reduction | sell | 0.00062 BTC | 81,180.80 | 80,820.20 |
| Guarded close, BTC | sell | 0.00062 BTC | 81,270.20 | 80,848.10 |
| Guarded close, ETH | buy | 0.0384 ETH | 2,362.61 | 2,374.74 |

## Cleanup, gas and collateral

The end state was verified at block 35,217,243 by the run and again at block 35,218,241 by the
read-back: no position in any of the 21 factory pools, no resting order, no live TP/SL stop, the
bank account empty (unlocked 0, locked 0), the USDso allowance to the bank and to the guard
zero, neither grant to the guard left nor a global one, no unresolved transaction, and every
cleanup order sent through the guard.

| | Before | After | Reconciliation |
|---|---|---|---|
| STT | 50.000000 | 49.826497 | spent 0.173502906 = the sum of the 13 receipt fees; cap 2 STT |
| USDso (wallet) | 100.000000 | 99.967805 | deposited 60, withdrawn 59.967805 |
| Result | | | −0.032195 USDso = realized PnL −0.032195 − funding 0 − fees 0; the fills alone imply the same |

The guard stays deployed at `0x8EE2…367F` with no grant: it can place no order for the account
unless the owner grants it again.

## How the evidence got here, and how to check it

1. `npm run mr:verify-run -- --run .margin-rescue/live/run-1 --plan
   evidence/margin-rescue/live-read-only/live-plan.json --approved 7f0903…1175`, from the
   repository root, read every transaction, receipt and the end state again from the chain and
   wrote `verification.json` and `verification.txt` into the private run folder: 93 / 93 checks
   hold.
2. `npm run mr:publish-run` copied the run folder to `run-1/` after scanning every file: no
   signed transaction (14 hex strings of 80 bytes or more, compared with the 13 transaction
   hashes and parsed as transactions), no key (281 32-byte values, none derives the account),
   no BIP-39 phrase. No file held a local path or a non-public URL, so all 25 (the run folder's
   24 files and the plan) were copied unchanged; `PUBLICATION.json` lists their SHA-256 and that
   of `SANITIZATION.md`, which reports the scan.
3. The published copy alone was then read back again against the chain (93 / 93, end block
   35,220,185). Anyone can repeat it; it signs nothing:

```bash
npm run mr:verify-run -- --run evidence/margin-rescue/live-write/run-1 \
  --approved 7f0903286d5f59cbb98abb739aea9873ef68e6466231bdd355bcd4e1ea3d1175 --out "$(mktemp -d)"
```

The site's build accepts `run-1/` only if it passes the bundle check again from scratch, and
shows the run as verified only because `verification.json` is valid for exactly these files and
was made against the plan authorized before the run. Sizes are small by design: about 100 USDso
of BTC and 90 USDso of ETH. One run shows the loop working on the live venue once; it is not a
statistic about fills, slippage or how often a rescue is needed.
