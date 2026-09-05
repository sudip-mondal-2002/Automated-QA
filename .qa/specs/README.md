# These specs are hand-authored demo fixtures, not agent output

`checkout-card.yaml`, `checkout-design.yaml`, and `checkout-saved-card.yaml` in
this directory are committed demo fixtures for the **one-skill developer
experience** (`setup` / `create` / `spec save` / `run`) — they exist so the
recorded demo (`LIVE_DEMO.md`, `artifacts/live-demo/`) and the loopback
results UI have something to show without a live session.

They are not an example of what the **autonomous orchestration agent**
(`orchestrate`) produces. That pipeline writes its own generated specs under
`.qa/runs/orchestrations/<id>/generated/`, derived entirely from crawling the
target — see [docs/architecture.md](../../docs/architecture.md) and
[docs/ORCHESTRATOR_DEMO.md](../../docs/ORCHESTRATOR_DEMO.md).
