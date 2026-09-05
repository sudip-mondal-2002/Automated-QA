const state = {
  workspace: null,
  document: null,
  selectedRunId: null,
  orchestrations: [],
  selectedOrchestration: null,
  toastTimer: null,
};

const elements = Object.fromEntries([
  "connection-status", "copy-rerun", "refresh", "test-count", "run-count", "environment-count",
  "tests-badge", "tests-list", "fixtures-badge", "fixtures-list", "editor-kind", "editor-title",
  "save-state", "yaml-editor", "validation-message", "validate-document", "save-document", "runs-list",
  "result-panel", "empty-result", "result-detail", "result-title", "result-status", "result-explanation",
  "delete-run", "result-metadata", "step-count", "step-list", "screenshot-count", "screenshot-grid",
  "design-findings", "execution-detail", "toast",
  "orchestration-panel", "orchestrations-badge", "orchestrations-list", "orchestration-detail",
  "orchestration-empty", "orchestration-body", "orchestration-metadata", "gate-score", "gate-list",
  "timeline", "timeline-count", "flow-list", "flow-count", "scenario-list", "scenario-count",
  "unknown-list", "unknown-count",
].map((id) => [id, document.getElementById(id)]));

const statusLabels = {
  passed: "Passed",
  healed: "Healed",
  functional_regression: "Functional regression",
  design_regression: "Design regression",
  blocked: "Blocked",
  not_run: "Not run",
  failed: "Failed",
  skipped: "Skipped",
};

function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === "className") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else element.setAttribute(key, value);
  }
  for (const child of children) element.append(child);
  return element;
}

function statusBadge(status) {
  return node("span", {
    className: `status status-${status}`,
    text: statusLabels[status] ?? status.replaceAll("_", " "),
  });
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...options.headers } : options.headers,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = body?.error;
    const issue = detail?.issues?.[0];
    throw new Error(issue ? `${detail.message} — ${issue.path}: ${issue.message}` : detail?.message ?? "Request failed");
  }
  return body;
}

async function copy(value, message = "Copied to clipboard") {
  await navigator.clipboard.writeText(value);
  showToast(message);
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

function renderTests() {
  elements["tests-list"].replaceChildren();
  elements["fixtures-list"].replaceChildren();
  const { tests, fixtures } = state.workspace;
  elements["tests-badge"].textContent = tests.length;
  elements["fixtures-badge"].textContent = fixtures.length;
  elements["test-count"].textContent = tests.length;

  for (const test of tests) {
    const selected = state.document?.kind === "spec" && state.document.id === test.id;
    const openButton = node("button", {
      type: "button",
      className: `list-button${selected ? " selected" : ""}`,
      "aria-pressed": String(selected),
    }, [
      node("div", { className: "list-row" }, [
        node("span", { className: "list-title", text: test.title }),
        statusBadge(test.lastStatus),
      ]),
      node("div", { className: "list-meta" }, [
        node("span", { className: "list-id", text: test.id }),
        node("span", { text: "·" }),
        node("span", { text: test.lastEnvironment }),
      ]),
    ]);
    openButton.addEventListener("click", () => loadDocument("specs", test.id));
    const copyButton = node("button", { type: "button", className: "copy-command", text: "Copy run prompt" });
    copyButton.addEventListener("click", () => copy(test.runPrompt, "Run prompt copied"));
    elements["tests-list"].append(node("div", { className: "test-entry" }, [openButton, copyButton]));
  }

  for (const fixture of fixtures) {
    const selected = state.document?.kind === "fixture" && state.document.id === fixture.id;
    const button = node("button", {
      type: "button",
      className: `list-button fixture-button${selected ? " selected" : ""}`,
      "aria-pressed": String(selected),
    }, [
      node("span", { className: "fixture-icon", text: "↳" }),
      node("span", { className: "list-title", text: fixture.title }),
    ]);
    button.addEventListener("click", () => loadDocument("fixtures", fixture.id));
    elements["fixtures-list"].append(button);
  }
}

function renderRuns() {
  elements["runs-list"].replaceChildren();
  const runs = state.workspace.recentRuns;
  elements["run-count"].textContent = runs.length;
  for (const run of runs) {
    const selected = state.selectedRunId === run.runId;
    const button = node("button", {
      type: "button",
      className: `list-button${selected ? " selected" : ""}`,
      "aria-pressed": String(selected),
    }, [
      node("div", { className: "list-row" }, [
        node("span", { className: "list-title", text: run.specId }),
        statusBadge(run.classification),
      ]),
      node("div", { className: "list-meta" }, [
        node("span", { className: "run-time", text: formatTime(run.completedAt) }),
        node("span", { text: "·" }),
        node("span", { text: run.environment }),
        node("span", { text: `· ${run.screenshotCount} images` }),
      ]),
      node("p", { className: "run-explanation", text: run.explanation }),
    ]);
    button.addEventListener("click", () => loadRun(run.runId));
    elements["runs-list"].append(button);
  }
  if (runs.length === 0) {
    elements["runs-list"].append(node("div", { className: "no-evidence", text: "No completed runs yet." }));
  }
}

function setValidation(kind, message) {
  elements["validation-message"].className = `validation-message ${kind}`;
  elements["validation-message"].textContent = message;
}

async function loadDocument(collection, id) {
  try {
    const documentValue = await api(`/api/documents/${collection}/${encodeURIComponent(id)}`);
    state.document = { ...documentValue, collection };
    elements["editor-kind"].textContent = `${documentValue.kind} YAML`;
    elements["editor-title"].textContent = documentValue.title;
    elements["yaml-editor"].value = documentValue.yaml;
    elements["yaml-editor"].disabled = false;
    elements["validate-document"].disabled = false;
    elements["save-document"].disabled = false;
    elements["save-state"].textContent = "Saved on disk";
    setValidation("neutral", "Edit semantic intent and observable outcomes, then validate before saving.");
    renderTests();
  } catch (error) {
    setValidation("invalid", error.message);
  }
}

async function validateDocument() {
  if (!state.document) return false;
  try {
    await api(`/api/documents/${state.document.collection}/validate`, {
      method: "POST",
      body: JSON.stringify({ id: state.document.id, yaml: elements["yaml-editor"].value }),
    });
    setValidation("valid", "Valid YAML. References and document structure are consistent.");
    return true;
  } catch (error) {
    setValidation("invalid", error.message);
    return false;
  }
}

async function saveDocument() {
  if (!state.document || !await validateDocument()) return;
  elements["save-document"].disabled = true;
  try {
    const response = await api(`/api/documents/${state.document.collection}/${encodeURIComponent(state.document.id)}`, {
      method: "PUT",
      body: JSON.stringify({ yaml: elements["yaml-editor"].value }),
    });
    elements["yaml-editor"].value = response.document.yaml;
    elements["editor-title"].textContent = response.document.title;
    elements["save-state"].textContent = "Saved just now";
    setValidation("valid", "Saved atomically to the file-backed QA workspace.");
    await refreshWorkspace({ quiet: true });
    showToast("Document saved");
  } catch (error) {
    setValidation("invalid", error.message);
  } finally {
    elements["save-document"].disabled = false;
  }
}

function metadataItem(label, value) {
  return node("div", {}, [node("dt", { text: label }), node("dd", { text: value })]);
}

function renderResult(result) {
  elements["empty-result"].hidden = true;
  elements["result-detail"].hidden = false;
  elements["result-title"].textContent = result.runId;
  elements["result-status"].replaceChildren(statusBadge(result.classification));
  elements["result-explanation"].textContent = result.explanation ?? "No explanation was recorded.";
  elements["result-metadata"].replaceChildren(
    metadataItem("Test", result.specId),
    metadataItem("Environment", result.environment),
    metadataItem("Started", formatTime(result.startedAt)),
    metadataItem("Completed", formatTime(result.completedAt)),
    ...(result.execution ? [
      metadataItem("Execution", result.execution.mode.replaceAll("_", " ")),
      metadataItem("Agent calls", String(result.execution.agentCalls)),
      metadataItem("Replay", result.execution.script?.state ?? "missing"),
    ] : []),
  );
  elements["execution-detail"].replaceChildren();
  if (result.execution) {
    const attempts = node("div", { className: "execution-attempts" });
    for (const attempt of result.execution.attempts) {
      attempts.append(node("span", {
        className: `execution-attempt execution-${attempt.status}`,
        text: `${attempt.engine}${attempt.validation ? " validation" : ""} · ${attempt.status} · ${attempt.durationMs}ms${attempt.browserChannel ? ` · ${attempt.browserChannel}` : ""}`,
      }));
    }
    elements["execution-detail"].append(attempts);
    if (result.execution.fallbackReason) {
      elements["execution-detail"].append(node("p", { className: "execution-reason", text: `Fallback: ${result.execution.fallbackReason}` }));
    }
    const errors = [...(result.evidence?.consoleErrors ?? []), ...(result.evidence?.networkErrors ?? [])];
    if (errors.length > 0) elements["execution-detail"].append(node("pre", { className: "execution-logs", text: errors.join("\n") }));
  }

  elements["step-count"].textContent = `${result.steps.length} steps`;
  elements["step-list"].replaceChildren();
  for (const step of result.steps) {
    const card = node("article", { className: "step-card" }, [
      node("header", {}, [
        node("h4", {}, [
          node("span", { className: "step-index", text: `${step.index}.` }),
          document.createTextNode(step.intent),
        ]),
        statusBadge(step.status),
      ]),
    ]);
    const expectations = node("ul", { className: "expectation-list" });
    for (const expectation of step.expectations) {
      expectations.append(node("li", {
        className: expectation.status,
        text: expectation.observation
          ? `${expectation.expectation} — ${expectation.observation}`
          : expectation.expectation,
      }));
    }
    card.append(expectations);
    if (step.selectedTarget) {
      card.append(node("div", {
        className: "target",
        text: `Selected target: ${step.selectedTarget.summary}`,
      }));
    }
    if (step.healing) {
      card.append(node("div", {
        className: "healing-note",
        text: `Healing: ${step.healing.replacement} — ${step.healing.verification}`,
      }));
    }
    elements["step-list"].append(card);
  }
  if (result.steps.length === 0) {
    elements["step-list"].append(node("div", { className: "no-evidence", text: "No test steps were recorded." }));
  }

  const screenshots = result.evidence?.screenshots ?? [];
  elements["screenshot-count"].textContent = `${screenshots.length} images`;
  elements["screenshot-grid"].replaceChildren();
  for (const screenshot of screenshots) {
    const fileName = screenshot.split("/").at(-1);
    elements["screenshot-grid"].append(node("figure", { className: "screenshot-card" }, [
      node("img", {
        src: `/api/runs/${encodeURIComponent(result.runId)}/screenshots/${encodeURIComponent(fileName)}`,
        alt: `Evidence from ${result.runId}: ${fileName}`,
        loading: "lazy",
      }),
      node("figcaption", { text: screenshot }),
    ]));
  }
  if (screenshots.length === 0) {
    elements["screenshot-grid"].append(node("div", { className: "no-evidence", text: "No screenshots were recorded." }));
  }

  elements["design-findings"].replaceChildren();
  for (const finding of result.design?.findings ?? []) {
    elements["design-findings"].append(node("div", { className: "design-card" }, [
      node("strong", { text: `${finding.category} · ${finding.status}` }),
      node("p", { text: finding.explanation }),
    ]));
  }
}

async function loadRun(runId) {
  try {
    const { result } = await api(`/api/runs/${encodeURIComponent(runId)}`);
    state.selectedRunId = runId;
    renderRuns();
    renderResult(result);
    elements["result-panel"].scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteRun() {
  if (!state.selectedRunId) return;
  const runId = state.selectedRunId;
  if (!window.confirm(`Delete ${runId}? Its result and screenshots will be removed.`)) return;
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    state.selectedRunId = null;
    elements["empty-result"].hidden = false;
    elements["result-detail"].hidden = true;
    await refreshWorkspace({ quiet: true });
    showToast("Run deleted");
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshWorkspace({ quiet = false } = {}) {
  try {
    state.workspace = await api("/api/workspace");
    elements["connection-status"].className = "connection ready";
    elements["connection-status"].lastChild.textContent = " Ready";
    elements["environment-count"].textContent = state.workspace.environments.length;
    renderTests();
    renderRuns();
    if (!quiet) showToast("Workspace refreshed");
  } catch (error) {
    elements["connection-status"].className = "connection error";
    elements["connection-status"].lastChild.textContent = " Disconnected";
    if (!quiet) showToast(error.message);
  }
}

// ---------------------------------------------------------------- orchestration

const STAGE_ORDER = ["bootstrap", "probe", "crawl", "plan", "gate", "generate", "run", "triage", "report"];

const STAGE_LABELS = {
  bootstrap: "Bootstrap",
  probe: "Probe target",
  crawl: "Crawl",
  plan: "Plan",
  gate: "Coverage gate",
  generate: "Generate",
  run: "Execute",
  triage: "Triage",
  report: "Report",
};

/** A gate rule fails; it does not regress. Borrow the palette, not the wording. */
function ruleBadge(status) {
  const label = status === "pass" ? "Passed" : status === "skipped" ? "Skipped" : "Failed";
  const tone = status === "pass" ? "passed" : status === "skipped" ? "skipped" : "functional_regression";
  return node("span", { className: `status status-${tone}`, text: label });
}

function renderOrchestrationList() {
  const list = elements["orchestrations-list"];
  list.replaceChildren();
  elements["orchestrations-badge"].textContent = state.orchestrations.length;
  elements["orchestration-panel"].hidden = state.orchestrations.length === 0;
  for (const entry of state.orchestrations) {
    const button = node("button", {
      className: `list-button${entry.orchestrationId === state.selectedOrchestration ? " active" : ""}`,
      type: "button",
      dataset: { id: entry.orchestrationId },
    }, [
      node("span", { className: "list-row" }, [
        node("span", { className: "list-title", text: entry.target ?? entry.orchestrationId }),
        statusBadge(entry.verdict === "clean" ? "passed" : entry.verdict === "defects_found" ? "functional_regression" : "blocked"),
      ]),
      node("span", { className: "list-meta" }, [
        node("span", { className: "list-id", text: entry.orchestrationId }),
        node("span", { text: `${entry.planner ?? "—"} · score ${entry.score ?? "—"} · exit ${entry.exitCode ?? "—"}` }),
      ]),
    ]);
    button.addEventListener("click", () => selectOrchestration(entry.orchestrationId));
    list.append(button);
  }
}

function renderGate(detail) {
  const list = elements["gate-list"];
  list.replaceChildren();
  const score = detail.report?.summary?.coverage?.score;
  const blocking = detail.checklist.filter((entry) => entry.severity === "blocking" && entry.status === "fail").length;
  elements["gate-score"].textContent = `score ${score ?? "—"} · ${blocking} blocking`;
  for (const entry of detail.checklist) {
    const related = detail.gaps.filter((candidate) => candidate.ruleId === entry.ruleId);
    // A gap either explains itself (hint) or proposes a concrete flow
    // (suggestion). Show whichever it carries — this is what the planner would
    // be handed on a replan, so it should be legible here too.
    const advice = related.find((gap) => gap.hint)?.hint
      ?? (related.some((gap) => gap.suggestion)
        ? `Suggested: ${related.filter((gap) => gap.suggestion).map((gap) => gap.suggestion.title).join("; ")}`
        : null);
    list.append(node("div", { className: `gate-row gate-${entry.status}` }, [
      node("div", { className: "gate-row-head" }, [
        node("span", { className: "gate-rule", text: entry.ruleId }),
        node("span", { className: `severity severity-${entry.severity}`, text: entry.severity }),
        ruleBadge(entry.status),
      ]),
      node("p", { className: "gate-detail", text: entry.detail ?? "" }),
      ...(advice ? [node("p", { className: "gate-hint", text: advice })] : []),
    ]));
  }
}

function renderTimeline(events) {
  const timeline = elements.timeline;
  timeline.replaceChildren();
  const stages = new Map();
  for (const event of events) {
    const stage = event.stage ?? "bootstrap";
    if (!stages.has(stage)) stages.set(stage, []);
    stages.get(stage).push(event);
  }
  const ordered = [...stages.keys()].sort((a, b) => {
    const rank = (value) => (STAGE_ORDER.indexOf(value) === -1 ? STAGE_ORDER.length : STAGE_ORDER.indexOf(value));
    return rank(a) - rank(b);
  });
  elements["timeline-count"].textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  for (const stage of ordered) {
    const entries = stages.get(stage);
    const warned = entries.some((event) => event.level === "warn" || event.level === "error");
    timeline.append(node("li", { className: `timeline-stage${warned ? " warned" : ""}` }, [
      node("div", { className: "timeline-marker" }, []),
      node("div", { className: "timeline-body" }, [
        node("p", { className: "timeline-stage-name", text: STAGE_LABELS[stage] ?? stage }),
        ...entries.map((event) => node("p", {
          className: `timeline-event${event.level === "warn" || event.level === "error" ? " warn" : ""}`,
        }, [
          node("code", { text: event.event ?? event.type ?? "event" }),
          node("span", { text: event.message ?? "" }),
        ])),
      ]),
    ]));
  }
  if (events.length === 0) {
    timeline.append(node("li", { className: "no-evidence", text: "No trace events were recorded for this orchestration." }));
  }
}

function renderFlows(detail) {
  const list = elements["flow-list"];
  list.replaceChildren();
  elements["flow-count"].textContent = `${detail.flows.length}`;
  for (const flow of detail.flows) {
    list.append(node("div", { className: "flow-row" }, [
      node("div", { className: "flow-row-head" }, [
        node("span", { className: "list-title", text: flow.title ?? flow.id }),
        node("span", { className: `chip chip-${flow.category}`, text: flow.category ?? "—" }),
      ]),
      node("span", { className: "list-meta", text: `${flow.steps} step${flow.steps === 1 ? "" : "s"} · ${flow.priority ?? "—"} · ${(flow.pages ?? []).join(", ") || "no page declared"}` }),
    ]));
  }
  if (detail.flows.length === 0) list.append(node("p", { className: "no-evidence", text: "No flows were planned." }));
}

function renderScenarios(detail) {
  const list = elements["scenario-list"];
  list.replaceChildren();
  const runs = detail.report?.scenarios ?? detail.report?.runs ?? [];
  elements["scenario-count"].textContent = `${runs.length}`;
  for (const run of runs) {
    list.append(node("div", { className: "scenario-row" }, [
      node("div", { className: "flow-row-head" }, [
        node("span", { className: "list-title", text: run.title ?? run.id ?? run.specId ?? "scenario" }),
        statusBadge(run.status ?? "not_run"),
      ]),
      node("span", { className: "list-meta", text: `${run.classification ?? "—"}${run.confidence ? ` · confidence ${run.confidence}` : ""}${run.blockedReason ? ` · ${run.blockedReason}` : ""}` }),
    ]));
  }
  if (runs.length === 0) list.append(node("p", { className: "no-evidence", text: "No scenarios were executed." }));
}

function renderUnknowns(detail) {
  const list = elements["unknown-list"];
  list.replaceChildren();
  const prdGaps = (detail.report?.prdGap?.requirements ?? [])
    .filter((requirement) => requirement.status !== "covered")
    .map((requirement) => ({
      kind: "PRD gap",
      tone: "prd",
      text: `${requirement.id} — ${requirement.note || "not covered"}: ${String(requirement.text ?? "").slice(0, 160)}`,
    }));
  const items = [
    // What the planner said it could not determine, rather than resolving it
    // by assumption. This is the ambiguity trail, and it is the point.
    ...detail.openQuestions.map((text) => ({ kind: "Open question", tone: "unknown", text })),
    ...prdGaps,
    ...detail.untestedRisks.map((risk) => ({ kind: "Untested", tone: risk.risk === "low" ? "low" : "unknown", text: `${risk.area} — ${risk.reason}` })),
  ];
  elements["unknown-count"].textContent = `${items.length}`;
  for (const item of items) {
    list.append(node("p", { className: "unknown-row" }, [
      node("span", { className: `chip chip-${item.tone ?? "unknown"}`, text: item.kind }),
      node("span", { text: item.text }),
    ]));
  }
  if (items.length === 0) list.append(node("p", { className: "no-evidence", text: "The agent declared no open questions or untested surface." }));
}

async function selectOrchestration(orchestrationId) {
  state.selectedOrchestration = orchestrationId;
  renderOrchestrationList();
  try {
    const [detail, trace] = await Promise.all([
      api(`/api/orchestrations/${encodeURIComponent(orchestrationId)}`),
      api(`/api/orchestrations/${encodeURIComponent(orchestrationId)}/trace`),
    ]);
    elements["orchestration-empty"].hidden = true;
    elements["orchestration-body"].hidden = false;
    const summary = detail.report?.summary ?? {};
    elements["orchestration-metadata"].replaceChildren(...[
      ["Target", detail.report?.target ?? "—"],
      ["Verdict", `${summary.verdict ?? "—"} (exit ${summary.exitCode ?? "—"})`],
      ["Planner", `${detail.planSource?.planner ?? "—"}${detail.planSource?.fellBack ? " — fell back" : ""}`],
      ["Coverage", `${summary.coverage?.score ?? "—"} over ${summary.coverage?.attempts ?? 1} attempt(s)`],
      ["Assertions", `${summary.generation?.assertions?.withPredicates ?? 0}/${summary.generation?.assertions?.total ?? 0} checkable · ${summary.generation?.assertions?.verified ?? 0} verified · ${summary.generation?.assertions?.refuted ?? 0} refuted`],
      ["Healing", `${summary.healing?.succeeded ?? 0}/${summary.healing?.attempted ?? 0} recovered`],
    ].map(([term, value]) => node("div", {}, [node("dt", { text: term }), node("dd", { text: String(value) })])));
    if (detail.planSource?.fellBack && detail.planSource.fallbackReason) {
      elements["orchestration-metadata"].append(node("div", {}, [
        node("dt", { text: "Fallback reason" }),
        node("dd", { text: detail.planSource.fallbackReason }),
      ]));
    }
    renderGate(detail);
    renderTimeline(trace.events ?? []);
    renderFlows(detail);
    renderScenarios(detail);
    renderUnknowns(detail);
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshOrchestrations() {
  try {
    const payload = await api("/api/orchestrations");
    state.orchestrations = payload.orchestrations ?? [];
    renderOrchestrationList();
    // Open the newest run on first load so the panel is never empty when there
    // is something to show.
    if (!state.selectedOrchestration && state.orchestrations.length > 0) {
      await selectOrchestration(state.orchestrations[0].orchestrationId);
    }
  } catch {
    // The workspace may simply have no orchestrations yet.
  }
}

elements.refresh.addEventListener("click", () => refreshWorkspace());
elements["copy-rerun"].addEventListener("click", () => {
  if (state.workspace) copy(state.workspace.rerunPrompt, "Rerun prompt copied");
});
elements["validate-document"].addEventListener("click", validateDocument);
elements["save-document"].addEventListener("click", saveDocument);
elements["delete-run"].addEventListener("click", deleteRun);
elements["yaml-editor"].addEventListener("input", () => {
  elements["save-state"].textContent = "Unsaved changes";
  setValidation("neutral", "Changes have not been validated yet.");
});

await refreshWorkspace({ quiet: true });
await refreshOrchestrations();
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  refreshWorkspace({ quiet: true });
  refreshOrchestrations();
}, 2500);
