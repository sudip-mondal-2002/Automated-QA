# Orchestrator architecture (as implemented)

```mermaid
flowchart TB
  CLI["cli.js orchestrate --url"] --> ORC{{"orchestrator.js<br/>planStages · EXIT codes"}}
  ORC --> PROBE["probe<br/>reach · auth · cookie jar"]
  PROBE --> PLAN["planner.js<br/>fetch-only BFS crawl<br/>flow synthesis"]
  PLAN --> GATE{{"coverage.js<br/>10 rules · score · verdict"}}
  GATE -->|replan, autoFixable gaps| PLAN
  GATE -->|escalate| REP
  GATE -->|pass| GEN["generator.js<br/>planToSpecs · bindLocators<br/>validateSelectors"]
  GEN --> COORD{{"replay.js<br/>Playwright-first coordinator"}}
  COORD -->|trusted complete pass| REP
  COORD -->|missing · stale · failed · hybrid| RUN["execution.js<br/>executeRun per spec"]
  RUN -->|failure| HEAL["locator-chain.js<br/>fallback · triage<br/>expectation guard"]
  HEAL --> ORC
  RUN --> REP["reporter.js<br/>report.json · report.md"]
  ORC -.->|events| TR[("trace.jsonl")]
  TR --> UI["ui-server.js<br/>decision timeline"]
```

Semantic YAML remains the source of truth. Each web spec may have an adjacent import-free Playwright script and replay manifest. A script becomes trusted only after three consecutive zero-retry runs in fresh contexts. Trusted complete passes bypass the agent; missing, stale, unavailable, failed, or safely non-deterministic replay portions fall back through the semantic executor once.
