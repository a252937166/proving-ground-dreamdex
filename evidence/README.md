# Execution evidence

All files were produced on 2026-10-21 (UTC) by this repository's own commands, against the live Somnia Hideki ("Tokyo") testnet, chain 50383, and the dreamDEX Hideki indexer. All of it is read-only: no transaction was signed or sent.

Capture machine: macOS, Node.js 22.23.1, `@somnia-chain/markets-sdk` 0.32.1. Its clock ran about 7 s behind NTP (measured against `time.apple.com`), so each `queriedAt` is earlier than the block time it reports.

| File | Command | Block |
|---|---|---|
| `snapshot.txt`, `snapshot.json` | `npm run snapshot -- --save evidence/snapshot` | 29364018 (13:12:35Z) |
| `precheck-buy-0.01.*` | `npm run precheck -- --side buy --qty 0.01 --save evidence/precheck-buy-0.01` | 29362416 (13:09:55Z) |
| `precheck-sell-0.01.*` | `npm run precheck -- --side sell --qty 0.01 --save evidence/precheck-sell-0.01` | 29362493 (13:10:02Z) |
| `precheck-reversal-blocked.*` | `npm run precheck -- --side sell --qty 0.02 --position 0.01 --save evidence/precheck-reversal-blocked` | 29362561 (13:10:09Z) |
| `test-unit.txt` | `npm test` (38 tests, fixtures only, no network) | n/a |
| `test-live.txt` | `npm run test:live` (8 read-only tests on the live network) | 29362692 (13:10:22Z) |
| `page.png` | `npm run serve`, then a sell 0.01 pre-check in the page | 29363543 (13:11:47Z) |

Each `.txt`/`.json` pair comes from one network read. The `.json` files keep every integer exact as a decimal string: prices and USDso amounts in 18 decimals, BTC quantities in 8.

Pre-check results are **local calculations** of the Proving Ground v2.2 rules on live market data. No Proving Ground contract is deployed, so none of these results is enforced on-chain.

Each block number can be checked against the public RPC, for example:

```bash
curl -s -X POST https://api.hideki2.infra.testnet.somnia.network \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x1c00f32",false]}'
```

(`0x1c00f32` is block 29364018.)
