# Publication of this run's evidence

The run was written to a private, git-ignored folder; `tools/publish-live-run.ts` copied it here on 2026-10-28T08:11:30.714Z. The originals are kept unchanged outside the repository. `live-plan.json` is the plan file the run was started under: its SHA-256 is the run's plan digest `7f0903286d5f59cbb98abb739aea9873ef68e6466231bdd355bcd4e1ea3d1175`. `PUBLICATION.json` lists the SHA-256 of every file here and of every original copied unchanged; the original of a redacted file is hashed only in the private provenance record, since its hash would let anyone test guesses for what was redacted. The site's build checks this folder against the manifest, and scans every file again, before publishing it.

Scanned for, and not found (any one of them stops the publication):

- signed transaction bytes: 14 hex strings of 80 bytes or more were hashed and compared with the 13 transaction hashes in the run ledger, and parsed as transactions
- the signing key: 281 32-byte values were each tried as a private key; none derives the account `0x66C626c59EdDf06a7DCa0401cF20FA2cE7033a12`
- a BIP-39 mnemonic: 22567 words checked for a phrase of 12 to 24 words of the English list with a valid checksum, in any case, separated by spaces, line breaks, commas, list numbers or bullets, or written as a JSON array

Replaced: absolute local paths, and every URL other than the fixed public Hideki RPC and dreamDEX indexer addresses.

| File | SHA-256 of the original | SHA-256 here | Changes |
| --- | --- | --- | --- |
| `analysis-snapshot.json` | `c0035d6e24882d2b520e211a92482e4ac1e169102e672f363b2d7101a3d7afc7` | same | copied unchanged |
| `analysis.txt` | `1b7894c030fba1fa738193840635e304ae9517e1c5b95b994303170bde67c081` | same | copied unchanged |
| `candidates.json` | `1319317255f40c6684101637e6ab5986b7aa71038c52f56d3aafa8679685ebc3` | same | copied unchanged |
| `cleanup.json` | `d0576c273717bd6229b6d33bf524c8a086032ff957aa9e7ce9acb85f18c82d14` | same | copied unchanged |
| `guard.json` | `e6df1f3e0368f92740c58f03beb46d8ea5f67c9c3087842d5d9d6cf2d6d8a601` | same | copied unchanged |
| `journal/0x18776b1d43ced6dc94aaf05d79e13ba0eebedee19a782a10338682439ffdff92.json` | `3baad99a9c6cde2527d528cc72fe92e16a55c587c896f113a9e54c1fdebda21d` | same | copied unchanged |
| `journal/0x4f44a0b16e58c74c768e5051d5828e6a33c0d3f3abab8a992753e99c6550ab60.json` | `33481e2593c7acf910038b8bcead39c276f36bdcc77bec8ffc5a16bf15368ee3` | same | copied unchanged |
| `journal/0x8b14430059e395cfe2a83d9142d7405c95a2f564aa06aea4a79cc43bdb3f7fcb.json` | `c9e19d358a87a33485d99cc66e180a525234f01fa5fd0abb730765bb77dd0665` | same | copied unchanged |
| `post-snapshot.json` | `4a9dc4f6e4784ed089b2900215837adb5d21c8c640f690307cc8147b03323b0e` | same | copied unchanged |
| `preflight-snapshot.json` | `7fc5297a79db31778506e6eac3c8befad2c976d8914ee9341a46d9fbdb38850b` | same | copied unchanged |
| `preflight.json` | `c8089b2f084a0812a698d985876ecad1c2dfa1c07f11f334115ffe0ebe6b8643` | same | copied unchanged |
| `receipt.json` | `3457c0b43cf3fbc769b1960a33e9b0390135dc5f6a37c36bb4a7d7f3d0cf9382` | same | copied unchanged |
| `recompute.json` | `a42b4efa9d39ff54b0c57ae858f59b8a5cde42fa09c4745161502a5f2f8148b6` | same | copied unchanged |
| `recompute.txt` | `bce282fc293e802b88a88093bedb5a2c5cb3c857755f9bf40315f0d3eb716a1e` | same | copied unchanged |
| `refresh-1.json` | `2749711b85b0c6de9c239a7be2b6d03af03aa1cebf23b23a054a54fd2f82754c` | same | copied unchanged |
| `refresh-analysis.json` | `72be689bbe88351af062b28aa8113173956adfa8e803151af0998c49be0297bb` | same | copied unchanged |
| `result.json` | `79a8ab6553f6c003dc1b258063d305dd1861b3eac2b1109edfe472be4d8561ab` | same | copied unchanged |
| `results.jsonl` | `a557a7e2eacf6340bec185c79e7a0f305732ab6393399ce4fedb6d5b01ae168e` | same | copied unchanged |
| `run-ledger.json` | `2fe454ad0f5a06cf8e426dd06378e30a1f5983b317d443fd8f121a4cec593ddf` | same | copied unchanged |
| `run-log.jsonl` | `2ab5731052134e997fd76ad3748a7054be7b3940ad6b017c7379cb7b1224d649` | same | copied unchanged |
| `run-state.json` | `14dc11eb19d7ce1e6355f10c8a727bb408740544c555c16c847ccf33a9bb2c27` | same | copied unchanged |
| `scenario.json` | `027aa3c00543bc755a6f70d078c35ad7d4ba7be09b29326640a9efc1862b5b59` | same | copied unchanged |
| `verification.json` | `469d25e0cfb8d1112402ed1bd0054d929ce9c340696d423def2b0720c2a7d5e9` | same | copied unchanged |
| `verification.txt` | `12983af60acce38f2c826f094ff89e4662c31b6e15bf726676254afd3ee5310c` | same | copied unchanged |
| `live-plan.json` | `7f0903286d5f59cbb98abb739aea9873ef68e6466231bdd355bcd4e1ea3d1175` | same | copied unchanged |

Nothing was left out.
