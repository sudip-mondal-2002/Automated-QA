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
  GEN --> RUN["execution.js<br/>executeRun per spec"]
  RUN -->|failure| HEAL["locator-chain.js<br/>fallback · triage<br/>expectation guard"]
  HEAL --> ORC
  RUN --> REP["reporter.js<br/>report.json · report.md"]
  ORC -.->|events| TR[("trace.jsonl")]
  TR --> UI["ui-server.js<br/>decision timeline"]
```

Two honest notes: shell mode without an executor reports `blocked` with the missing-capability reason rather than guessing, and generated Playwright files are portable artifacts validated against the live DOM — execution runs on the semantic engine.
