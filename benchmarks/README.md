# Benchmark suites

The benchmark tree separates software quality assurance from general browser
task completion:

- [`qa/`](qa/) is the primary Auto-QA benchmark. It derives fixed, content-bound
  generation and regression lanes from WebTestBench and a conservative
  self-healing lane from ReproBreak.
- [`web-agent/`](web-agent/) contains secondary web-agent capability checks.
  Its WebForge track is useful for browser-operation coverage, but it is not
  evidence of test generation, safe healing, or regression identification.

Each suite owns its source pins, licenses, protocol, scorer, verifier, and
checked-in evidence. Start with the README inside the relevant folder.
