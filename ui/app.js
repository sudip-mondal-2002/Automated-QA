const state = {
  workspace: null,
  document: null,
  selectedRunId: null,
  toastTimer: null,
};

const elements = Object.fromEntries([
  "connection-status", "copy-rerun", "refresh", "test-count", "run-count", "environment-count",
  "tests-badge", "tests-list", "fixtures-badge", "fixtures-list", "editor-kind", "editor-title",
  "save-state", "yaml-editor", "validation-message", "validate-document", "save-document", "runs-list",
  "result-panel", "empty-result", "result-detail", "result-title", "result-status", "result-explanation",
  "delete-run", "result-metadata", "step-count", "step-list", "screenshot-count", "screenshot-grid",
  "design-findings", "toast",
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
    const copyButton = node("button", { type: "button", className: "copy-command", text: "Copy run command" });
    copyButton.addEventListener("click", () => copy(test.runCommand, "Run command copied"));
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
  );

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

elements.refresh.addEventListener("click", () => refreshWorkspace());
elements["copy-rerun"].addEventListener("click", () => {
  if (state.workspace) copy(state.workspace.rerunCommand, "Rerun command copied");
});
elements["validate-document"].addEventListener("click", validateDocument);
elements["save-document"].addEventListener("click", saveDocument);
elements["delete-run"].addEventListener("click", deleteRun);
elements["yaml-editor"].addEventListener("input", () => {
  elements["save-state"].textContent = "Unsaved changes";
  setValidation("neutral", "Changes have not been validated yet.");
});

await refreshWorkspace({ quiet: true });
setInterval(() => {
  if (document.visibilityState === "visible") refreshWorkspace({ quiet: true });
}, 2500);
