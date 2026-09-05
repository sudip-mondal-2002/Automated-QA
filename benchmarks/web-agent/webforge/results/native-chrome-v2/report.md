# WebForge-Bench — native-chrome-v2

- Track: `operation-code-21-v2`
- Score: **18/21 (85.7%)**
- Attempted: 21/21; missing cases count as incorrect
- Wilson score interval under a 21-case binomial model: 65.4%–95.0%; this deterministic stratified sample does not support inference to the 934-task suite
- Mean runner-reported browser actions (attempted cases): 16.5
- Mean runner-reported elapsed time (attempted cases): 113.0 seconds
- Final-screenshot file coverage: 21/21 (100.0%); file presence does not constitute independent visual adjudication
- Dataset revision: `56e0903f9205577cf39a4253bb0fc163fdb3cbd5`
- Pinned assets: 422 files / 56885459 bytes

## By difficulty

| Level | Correct | Total | Accuracy |
| --- | ---: | ---: | ---: |
| L1 | 6 | 7 | 85.7% |
| L2 | 7 | 7 | 100.0% |
| L3 | 5 | 7 | 71.4% |

## By domain

| Domain | Correct | Total | Accuracy |
| --- | ---: | ---: | ---: |
| domain_1 | 3 | 3 | 100.0% |
| domain_2 | 2 | 3 | 66.7% |
| domain_3 | 3 | 3 | 100.0% |
| domain_4 | 3 | 3 | 100.0% |
| domain_5 | 2 | 3 | 66.7% |
| domain_6 | 2 | 3 | 66.7% |
| domain_7 | 3 | 3 | 100.0% |

This is the fixed 21-task offline-native operation-code track, not the full 934-task WebForge leaderboard suite.

## Claim boundary and disclosure

This is exact completion on a selected 21-case operation-code track, not an official score on the full 934-task WebForge suite. The upstream suite mixes three answer types and uses semantic LLM judging, so percentage-point deltas, ranks, outperformance, and state-of-the-art claims are invalid.

This track is **retired/disclosed**. Unredacted final-state screenshots and the expected-answer hash commitment are published for auditability and can expose or facilitate recovery of answers. Any future blind run must freeze a new held-out track and exclude this result directory from runner context.

Human-reviewed failure analysis: [native-chrome-v2](../../analyses/native-chrome-v2.md)

## Independent scoring audit

Expected hashes: [download](expected-answer-hashes.json) (SHA-256 `c6add27df5fbcadf55668868cd4916a62b0c4e384ad62a07bb18e4323134dfff`). Each case in `summary.json` publishes the submitted-answer SHA-256. Equality with that task's expected hash independently reproduces its correctness and the 18/21 total without revealing the raw submitted-answer field.

## Recorded runtime

- Agent runtime: Codex collaborative task runners
- Model: not exposed to the benchmark harness
- Reasoning setting: not exposed to the benchmark harness
- Runner instances: 3
- Execution split: three parallel runners divided by difficulty, with remaining Level-3 tasks split after Level 1 completed
- Browser executor: OpenAI Chrome plugin 26.820.60940
- Browser surfaces: Chrome extension
- Origin isolation: historical version-2 run requested an ephemeral 127.0.0.1 port per task; assigned origins were not recorded, so reuse cannot be audited
- Host: Node v25.8.1, darwin/arm64

## Final-state evidence

| Task | Screenshot | SHA-256 |
| --- | --- | --- |
| `83abbca115d4abeb` | [view](evidence/83abbca115d4abeb.jpg) | `7331de17486afa0b47dda17ba6a0a782a1052ba4ebc37c55241ae43b1e90d362` |
| `c83fb0102e594abb` | [view](evidence/c83fb0102e594abb.jpg) | `f73756ae9ca29e00891a556239beaf23247755e7413f42d35ce0049add73ba51` |
| `ea2ace1cb939a9f6` | [view](evidence/ea2ace1cb939a9f6.jpg) | `ec1e5401ccf6a1b31064bb9e4f2c58b1224b21124073155e897cee3a2972365a` |
| `8d37437e2c33cb5d` | [view](evidence/8d37437e2c33cb5d.jpg) | `aab81df5ed4517ce3a3161509894b9afc9bdc68db7eeb503a38cf26d25699ddd` |
| `5394cf3e15f3e7ec` | [view](evidence/5394cf3e15f3e7ec.jpg) | `2a3090a8b5dd06f3a11dead6f50540cecdd60b721b75a39fa5411432d987a2ad` |
| `a81115d13618fcec` | [view](evidence/a81115d13618fcec.jpg) | `1f22520f7250cb99fc147e63bf44ecf9d44a46112274df926f676d766e417b71` |
| `07537823afdd9793` | [view](evidence/07537823afdd9793.jpg) | `a6fe9d7db121a93c0abd9e9291976ffc4a6d2ce0fba3be94fd862927f5f825a9` |
| `c0575dcbc99390db` | [view](evidence/c0575dcbc99390db.jpg) | `a42a3718e60fed97b1b6574ccd30a9228c93d5d3e043af365e30ad334180a35d` |
| `75a6cd75b0335547` | [view](evidence/75a6cd75b0335547.jpg) | `a20e81010a34cb66c0ad12fc8cdb0095462d4fb71fe6c1010fe09bfbcf0e7479` |
| `7df4b1198ee9cf01` | [view](evidence/7df4b1198ee9cf01.jpg) | `68b4dcdd73d34ed01ad6c0226760583fcb1a765d25b4511e97f4c7916ebc4e74` |
| `3bd1b254f448d763` | [view](evidence/3bd1b254f448d763.jpg) | `da077a9d7ec58eb8f7bf95429fd9dbe871c0d2add23b3242c83535e8e3cf8da9` |
| `8bf50f93a202a7b5` | [view](evidence/8bf50f93a202a7b5.jpg) | `8d1ca0aaeeed2b39ed9e36004714ca556d8acc96b5df86c76fba1fcf9770170b` |
| `5ff721459019696f` | [view](evidence/5ff721459019696f.jpg) | `0b07e9fcaa70ff555813f74bdda1e418b8fbab0b7eaa334bb76cc18057d1a824` |
| `fc7ef2b1db6efa56` | [view](evidence/fc7ef2b1db6efa56.jpg) | `124dc4ef78ea0aff6c80a04b956fc36cbf01d617b52af8718aec8ca8c1a9b0f1` |
| `541e77c05263f156` | [view](evidence/541e77c05263f156.jpg) | `95ea789b13b264042377f7c2e33d5b75fa5dab21b0dfc9c5c9359e9fe1e35a69` |
| `8d1a19339800ac51` | [view](evidence/8d1a19339800ac51.jpg) | `1e37bce1c66428a669a70f82505164f9c278a86e90137193d8fd934721131481` |
| `d3ee4ad98503d301` | [view](evidence/d3ee4ad98503d301.jpg) | `5341f468d47ee4831d81487d2f4a30845512b4e5bb853709def2e5b38a717da3` |
| `13057afe9b761478` | [view](evidence/13057afe9b761478.jpg) | `8ec5c231de75146aad1337f7298516528cc0cbe3d1ea31a1afa3e3976089e5ee` |
| `e297fe296246f701` | [view](evidence/e297fe296246f701.jpg) | `0e0b7fb9e5d59d7f31b21b747df4d40732ae1b9a85bb9adbd0528df98067399f` |
| `ec58461561075b8b` | [view](evidence/ec58461561075b8b.jpg) | `8ae2b458f4daa90e48848fdd3d1741fb51d0140f4d456df34f7200f9c9e46924` |
| `83c5870bd2ce825b` | [view](evidence/83c5870bd2ce825b.jpg) | `ee5bfda50ecf1f646da2f5d4b04440a07868902de93c471157a09c15d592866f` |

Execution protocol revision: `8808291c9766bbd91f35d31ff88eea259b5b3a6c`

Publisher revision: `f0eb818585ac039dffd5c8cef52470d0f29af7c8` (benchmark protocol files verified clean before publication)
