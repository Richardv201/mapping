// Store source-derived content by role, stage, and analysis layer.
const roleNames = [
  "Patient",
  "Referring clinician",
  "Referring admin",
  "Receiving clinician",
  "Contact centre and booking",
  "RTT and funding team"
];

const stageTotal = 10;
const stageTitles = [
  "",
  "Need identified",
  "Referral created",
  "Referral received",
  "Triage and advice",
  "Booking and preparation",
  "Waiting and RTT",
  "Seen and followed up",
  "Onward to another trust",
  "Funding and prior approval",
  "Complete and close"
];
const sourceTagColors = {
  EPR: "epr",
  PH: "phone",
  APP: "app",
  LTR: "letter",
  EML: "email",
  ICE: "ice",
  PAS: "pas",
  XLS: "spreadsheet",
  SOM: "somerset",
  CCS: "ccs",
  RTT: "rtt"
};
const roleEvents = roleNames.map(() => Array.from({ length: stageTotal + 1 }, () => []));
const responsibilityByStage = Array(stageTotal + 1).fill(null);
const analysisLayerDefinitions = [
  { key: "handoffs", title: "Handoffs", itemName: "Handoffs", rowName: "Handoffs" },
  { key: "visibility", title: "Visibility / audit trail", itemName: "Visibility", rowName: "Visibility" },
  { key: "policy", title: "Policy / clinical safety", itemName: "Policy and clinical safety", rowName: "Policy and clinical safety" },
  { key: "opportunities", title: "Opportunities", itemName: "Opportunity", rowName: "Opportunities" }
];
const analysisLayerData = Object.fromEntries(
  analysisLayerDefinitions.map((layer) => [layer.key, Array(stageTotal + 1).fill(null)])
);
const board = document.getElementById("board-scroll");
const matrix = document.getElementById("journey-matrix");
const matrixGrid = document.getElementById("matrix-grid");
const linksSvg = document.getElementById("journey-links");
const emptyBoard = document.getElementById("empty-board");
const stageNav = document.getElementById("stage-nav");
const nextButton = document.getElementById("next-button");
const previousButton = document.getElementById("previous-button");
const progressTrack = document.querySelector("#journey-app [role='progressbar']");
const progressLabel = document.getElementById("progress-label");
const progressNumber = document.getElementById("progress-number");
const progressBar = document.getElementById("progress-bar");
const boardStatus = document.getElementById("board-status");
const zoomLabel = document.getElementById("zoom-label");

let currentStage = 0;
let zoom = 1;
let ready = false;
let openAnalysisStage = 0;

// Normalize SVG labels, including known text-encoding artifacts.
function normalizeSvgLabel(value) {
  const text = value.trim().replace(/Â·/g, "·").replace(/â/g, "–").replace(/_\d+$/, "");
  const attribution = text.match(/^Anecdotal\b.*?\buser\b.*?(\d+\+?)\s+sessions?$/i);
  if (!attribution) return text;

  const count = attribution[1];
  return `Anecdotal - user ${count} ${count === "1" ? "session" : "sessions"}`;
}

function parseGroupText(group, defaultSection) {
  const content = { activity: [], friction: [], workaround: [], consequence: [], tags: [] };
  let section = defaultSection;

  for (const path of group.querySelectorAll("path[id]")) {
    const text = normalizeSvgLabel(path.id);
    if (!text || /^(?:Vector|XMLID|clipPath|mask|pattern)/i.test(text)) continue;

    const heading = text.toUpperCase();
    if (heading === "FAILURE POINT") {
      section = "friction";
      continue;
    }
    if (heading === "WORKAROUND") {
      section = "workaround";
      continue;
    }
    if (heading === "CONSEQUENCE") {
      section = "consequence";
      continue;
    }
    if (/^[A-Z0-9 _./-]{2,12}$/.test(text)) {
      content.tags.push(text);
      continue;
    }
    content[section].push(text);
  }

  return content;
}

function makeActivityEvent(group) {
  const content = parseGroupText(group, "activity");
  const titleIndex = content.activity.findIndex((text) => text.length > 12);
  const title = titleIndex < 0 ? content.activity[0] : content.activity[titleIndex];
  return {
    kind: "Activity",
    title: title || "Activity details",
    details: content.activity.filter((_, index) => index !== titleIndex),
    tags: content.tags
  };
}

function makeFrictionEvent(group, workaroundGroup) {
  const content = parseGroupText(group, "friction");
  const workaround = workaroundGroup ? parseGroupText(workaroundGroup, "workaround") : null;
  return {
    kind: "Friction point",
    title: content.friction.join(" ") || "Friction point details",
    sections: [
      { label: "Workaround", tone: "workaround", lines: workaround?.workaround || [] },
      { label: "Consequence", tone: "consequence", lines: content.consequence }
    ].filter((section) => section.lines.length),
    tags: [...content.tags, ...(workaround?.tags || [])]
  };
}

function makeWorkaroundEvent(group) {
  const content = parseGroupText(group, "workaround");
  const titleIndex = content.workaround.findIndex((text) => text.length > 12);
  const title = titleIndex < 0 ? content.workaround[0] : content.workaround[titleIndex];
  return {
    kind: "Workaround",
    title: title || "Workaround details",
    details: content.workaround.filter((_, index) => index !== titleIndex),
    tags: content.tags
  };
}

// Extract responsibility and analysis rows into stage-indexed records.
function buildResponsibilityData(svgDocument) {
  const row = [...svgDocument.querySelectorAll("g[id^='Row']")]
    .find((group) => group.id.includes("Responsibility overview"));
  if (!row) return;

  for (const group of row.children) {
    const match = group.id.match(/^Responsibility\s+(\d+)$/);
    if (!match) continue;
    const stage = Number(match[1]);
    if (stage < 1 || stage > stageTotal) continue;

    const labels = [...group.querySelectorAll("path[id]")]
      .map((path) => normalizeSvgLabel(path.id))
      .filter((text) => text && !/^(?:Vector|XMLID|clipPath|mask|pattern)/i.test(text));
    const header = labels.find((text) => /^(?:CLEAR|GAP|SHARED \/ ASSUMED)$/i.test(text));
    if (!header) continue;

    responsibilityByStage[stage] = {
      header,
      body: labels.filter((text) => text !== header).join(" "),
      tone: header === "CLEAR" ? "clear" : header === "GAP" ? "gap" : "shared"
    };
  }
}

function buildAnalysisLayerData(svgDocument) {
  const rows = [...svgDocument.querySelectorAll("g[id^='Row']")];

  for (const layer of analysisLayerDefinitions) {
    const row = rows.find((group) => group.id.includes(layer.rowName));
    if (!row) continue;

    for (const group of row.children) {
      const match = group.id.match(/^(.*)\s+(\d+)$/);
      if (!match || match[1] !== layer.itemName) continue;
      const stage = Number(match[2]);
      if (stage < 1 || stage > stageTotal) continue;

      const labels = [...group.querySelectorAll("path[id]")]
        .map((path) => normalizeSvgLabel(path.id))
        .filter((text) => text && !/^(?:Vector|XMLID|clipPath|mask|pattern)/i.test(text));
      let item;

      if (layer.key === "handoffs") {
        item = { heading: labels[0], body: labels.slice(1).join(" ") };
      } else if (layer.key === "visibility") {
        const auditTrail = labels.find((text) => /^Audit trail:/i.test(text));
        item = {
          visibility: labels.filter((text) => text !== auditTrail).join(" "),
          auditTrail: auditTrail?.replace(/^Audit trail:\s*/i, "") || ""
        };
      } else if (layer.key === "policy") {
        item = { body: labels.slice(1).join(" ") };
      } else {
        const opportunity = labels.filter((text) => text !== "TO-BE");
        item = { heading: opportunity[0] || "Opportunity", details: opportunity.slice(1) };
      }

      analysisLayerData[layer.key][stage] = item;
    }
  }
}

// Convert SVG lanes and rows into the model used by the interactive board.
function buildSourceData(svgDocument) {
  const lanes = [...svgDocument.querySelectorAll("g[id^='Lane']")];
  lanes.forEach((lane, laneIndex) => {
    const stageGroups = [...lane.children].filter((group) => /stage\s+\d+/i.test(group.id));
    for (const group of stageGroups) {
      const match = group.id.match(/stage\s+(\d+)/i);
      if (!match) continue;
      const stage = Number(match[1]);
      if (stage < 1 || stage > stageTotal) continue;

      const touchpoints = [...group.children].filter((item) => item.id.startsWith("Touchpoint"));
      const workarounds = [...group.children].filter((item) => item.id.startsWith("Workaround"));
      const failures = [...group.children].filter((item) => item.id.startsWith("Failure point"));

      touchpoints.forEach((item) => roleEvents[laneIndex][stage].push(makeActivityEvent(item)));
      failures.forEach((item, index) => roleEvents[laneIndex][stage].push(makeFrictionEvent(item, workarounds[index])));
      workarounds.slice(failures.length).forEach((item) => roleEvents[laneIndex][stage].push(makeWorkaroundEvent(item)));
    }
  });
  buildResponsibilityData(svgDocument);
  buildAnalysisLayerData(svgDocument);
}

function renderStageNav() {
  stageNav.replaceChildren();
  for (let stage = 0; stage <= stageTotal; stage += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stage-button";
    button.textContent = stage === 0 ? "Start" : String(stage).padStart(2, "0");
    button.setAttribute("aria-label", stage === 0 ? "Journey start" : `Go to stage ${stage}: ${stageTitles[stage] || "Referral stage"}`);
    button.setAttribute("aria-current", stage === currentStage ? "step" : "false");
    button.disabled = !ready;
    button.addEventListener("click", () => setStage(stage));
    stageNav.append(button);
  }
}

// Add source-system labels to cards when they are present in the SVG.
function appendSourceTags(container, labels) {
  if (!labels?.length) return;
  const tags = document.createElement("div");
  tags.className = "source-tags";
  for (const text of labels) {
    const tag = document.createElement("span");
    tag.className = `source-tag--${sourceTagColors[text] || "neutral"}`;
    tag.textContent = text;
    tags.append(tag);
  }
  container.append(tags);
}

// Build an event card, including expandable friction details.
function appendEventCard(event, stage) {
  const isFriction = event.kind === "Friction point";
  const card = document.createElement(isFriction ? "details" : "article");
  card.className = `event-card${isFriction ? " failure" : ` static ${event.kind === "Workaround" ? "workaround-card" : ""}`}`;
  card.dataset.stage = String(stage);

  if (isFriction) {
    const summary = document.createElement("summary");
    const kind = document.createElement("span");
    kind.className = "event-kind";
    kind.textContent = event.kind;
    const title = document.createElement("span");
    title.className = "event-title";
    title.textContent = event.title;
    summary.append(kind, title);
    card.append(summary);

    const content = document.createElement("div");
    content.className = "event-content";
    for (const section of event.sections) {
      const bubble = document.createElement("section");
      bubble.className = `related-bubble ${section.tone}`;
      const heading = document.createElement("h4");
      heading.textContent = section.label;
      const copy = document.createElement("p");
      copy.textContent = section.lines.join(" ");
      bubble.append(heading, copy);
      content.append(bubble);
    }
    card.append(content);
    appendSourceTags(card, event.tags);
    card.addEventListener("toggle", scheduleLinks);
    return card;
  }

  if (event.kind === "Workaround") {
    const kind = document.createElement("span");
    kind.className = "event-kind";
    kind.textContent = event.kind;
    card.append(kind);
  }
  appendSourceTags(card, event.tags);

  const copy = document.createElement("p");
  copy.className = "event-full-copy";
  copy.textContent = [event.title, ...event.details].filter(Boolean).join(" ");
  card.append(copy);
  return card;
}

function appendResponsibilityCard(responsibility, stage) {
  const card = document.createElement("details");
  card.className = `responsibility-card ${responsibility.tone}`;
  card.dataset.stage = String(stage);

  const summary = document.createElement("summary");
  summary.textContent = responsibility.header;
  card.append(summary);

  const body = document.createElement("p");
  body.textContent = responsibility.body;
  card.append(body);
  card.addEventListener("toggle", scheduleLinks);
  return card;
}

// Format the selected stage's content for one analysis layer.
function appendAnalysisItem(layer, item) {
  const card = document.createElement("article");
  card.className = `analysis-stage-card ${layer.key}`;

  if (layer.key === "handoffs") {
    const heading = document.createElement("strong");
    heading.textContent = item.heading;
    const body = document.createElement("p");
    body.textContent = item.body;
    card.append(heading, body);
  } else if (layer.key === "visibility") {
    const visibility = document.createElement("p");
    visibility.className = "visibility-status";
    visibility.textContent = item.visibility;
    const audit = document.createElement("p");
    audit.className = "audit-status";
    const label = document.createElement("strong");
    label.textContent = "Audit trail";
    const status = document.createElement("span");
    status.textContent = item.auditTrail;
    audit.append(label, status);
    card.append(visibility, audit);
  } else if (layer.key === "policy") {
    const heading = document.createElement("strong");
    heading.textContent = "POLICY / CLINICAL SAFETY";
    const body = document.createElement("p");
    body.textContent = item.body;
    card.append(heading, body);
  } else {
    const kicker = document.createElement("span");
    kicker.className = "analysis-kicker";
    kicker.textContent = "TO-BE";
    const heading = document.createElement("strong");
    heading.textContent = item.heading;
    card.append(kicker, heading);
    for (const detail of item.details) {
      const line = document.createElement("p");
      line.textContent = detail;
      card.append(line);
    }
  }
  return card;
}

// Attach a stage-specific analysis overlay to the swimlane.
function appendAnalysisLane() {
  const lane = document.createElement("div");
  lane.className = "analysis-lane";

  const summary = document.createElement("div");
  summary.className = "analysis-lane-summary";
  const label = document.createElement("span");
  label.className = "analysis-lane-label";
  label.textContent = "Analysis layers";
  summary.append(label);
  for (let stage = 1; stage <= currentStage; stage += 1) {
    const trigger = document.createElement("button");
    trigger.className = "analysis-lane-trigger";
    trigger.type = "button";
    trigger.dataset.stage = String(stage);
    trigger.setAttribute("aria-expanded", String(openAnalysisStage === stage));
    trigger.textContent = "Analysis +";
    trigger.setAttribute("aria-label", `Show analysis for stage ${stage}`);
    summary.append(trigger);
  }
  lane.append(summary);

  const overlay = document.createElement("div");
  overlay.className = "analysis-overlay";
  overlay.setAttribute("aria-label", "Analysis layers for selected stage");
  overlay.hidden = true;
  lane.append(overlay);
  lane.addEventListener("click", (event) => {
    const trigger = event.target.closest(".analysis-lane-trigger");
    if (!trigger) return;

    const stage = Number(trigger.dataset.stage);
    openAnalysisStage = openAnalysisStage === stage ? 0 : stage;
    overlay.replaceChildren();
    overlay.hidden = openAnalysisStage === 0;

    for (const button of lane.querySelectorAll(".analysis-lane-trigger")) {
      const selected = Number(button.dataset.stage) === openAnalysisStage;
      button.setAttribute("aria-expanded", String(selected));
      button.textContent = selected ? "Analysis −" : "Analysis +";
    }

    if (openAnalysisStage !== 0) {
      const grid = document.createElement("div");
      grid.className = "analysis-overlay-grid";
      overlay.style.setProperty("--analysis-left", `${190 + (openAnalysisStage - 1) * 470}px`);

      for (const layer of analysisLayerDefinitions) {
        const rowLabel = document.createElement("h3");
        rowLabel.className = `analysis-layer-label ${layer.key}`;
        rowLabel.textContent = layer.title;
        const cell = document.createElement("div");
        cell.className = "analysis-layer-cell";
        const item = analysisLayerData[layer.key][openAnalysisStage];
        if (item) cell.append(appendAnalysisItem(layer, item));
        grid.append(rowLabel, cell);
      }

      overlay.append(grid);
    }
  });
  return lane;
}

// Rebuild the visible swimlane through the selected stage.
function renderMatrix() {
  openAnalysisStage = 0;
  if (currentStage === 0) {
    matrix.hidden = true;
    matrixGrid.replaceChildren();
    linksSvg.replaceChildren();
    emptyBoard.hidden = false;
    return;
  }

  emptyBoard.hidden = true;
  matrix.hidden = false;
  matrixGrid.replaceChildren();
  matrixGrid.style.setProperty("--column-count", String(currentStage));

  const corner = document.createElement("div");
  corner.className = "matrix-corner";
  corner.textContent = "People and teams";
  matrixGrid.append(corner);

  for (let stage = 1; stage <= currentStage; stage += 1) {
    const heading = document.createElement("div");
    heading.className = "stage-heading";
    const number = document.createElement("span");
    number.textContent = `Stage ${String(stage).padStart(2, "0")}`;
    const title = document.createElement("h3");
    title.textContent = stageTitles[stage] || `Referral stage ${stage}`;
    heading.append(number, title);
    matrixGrid.append(heading);
  }

  const responsibilityLabel = document.createElement("div");
  responsibilityLabel.className = "lane-heading responsibility-lane-heading";
  const responsibilityName = document.createElement("span");
  responsibilityName.className = "lane-name";
  responsibilityName.textContent = "Responsibility overview";
  responsibilityLabel.append(responsibilityName);
  matrixGrid.append(responsibilityLabel);

  for (let stage = 1; stage <= currentStage; stage += 1) {
    const cell = document.createElement("div");
    cell.className = "responsibility-cell";
    cell.dataset.stage = String(stage);
    if (responsibilityByStage[stage]) {
      cell.append(appendResponsibilityCard(responsibilityByStage[stage], stage));
    }
    matrixGrid.append(cell);
  }

  matrixGrid.append(appendAnalysisLane());

  roleNames.forEach((role, roleIndex) => {
    const label = document.createElement("div");
    label.className = "lane-heading";
    const mark = document.createElement("span");
    mark.className = "lane-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = role.slice(0, 1);
    const name = document.createElement("span");
    name.className = "lane-name";
    name.textContent = role;
    label.append(mark, name);
    matrixGrid.append(label);

    for (let stage = 1; stage <= currentStage; stage += 1) {
      const cell = document.createElement("div");
      cell.className = "matrix-cell";
      cell.dataset.stage = String(stage);
      cell.dataset.role = String(roleIndex);
      const events = roleEvents[roleIndex][stage];
      if (events.length) {
        cell.classList.add("has-events");
        const stack = document.createElement("div");
        stack.className = "event-stack";
        events.forEach((event) => stack.append(appendEventCard(event, stage)));
        cell.append(stack);
      }
      matrixGrid.append(cell);
    }
  });

  drawLinks();
}

// Connect each stage's events to the nearest event in the next populated stage.
function drawLinks() {
  if (matrix.hidden) return;
  const matrixRect = matrix.getBoundingClientRect();
  const scaleX = matrixRect.width / matrix.offsetWidth || 1;
  const scaleY = matrixRect.height / matrix.offsetHeight || 1;
  linksSvg.setAttribute("width", String(matrix.offsetWidth));
  linksSvg.setAttribute("height", String(matrix.offsetHeight));
  linksSvg.setAttribute("viewBox", `0 0 ${matrix.offsetWidth} ${matrix.offsetHeight}`);
  linksSvg.replaceChildren();

  const allEvents = [...matrixGrid.querySelectorAll(".event-card")];
  for (let stage = 1; stage < currentStage; stage += 1) {
    const from = allEvents.filter((event) => Number(event.dataset.stage) === stage);
    const to = allEvents.filter((event) => Number(event.dataset.stage) > stage);
    if (!from.length || !to.length) continue;
    const nextStage = Math.min(...to.map((event) => Number(event.dataset.stage)));
    const nextEvents = to.filter((event) => Number(event.dataset.stage) === nextStage);

    for (const source of from) {
      const sourceRect = source.getBoundingClientRect();
      const sourceY = (sourceRect.top + sourceRect.height / 2 - matrixRect.top) / scaleY;
      const sourceX = (sourceRect.right - matrixRect.left) / scaleX;
      const target = nextEvents.reduce((nearest, candidate) => {
        const rect = candidate.getBoundingClientRect();
        const y = (rect.top + rect.height / 2 - matrixRect.top) / scaleY;
        return Math.abs(y - sourceY) < nearest.distance ? { element: candidate, distance: Math.abs(y - sourceY) } : nearest;
      }, { element: nextEvents[0], distance: Infinity }).element;
      const targetRect = target.getBoundingClientRect();
      const targetY = (targetRect.top + targetRect.height / 2 - matrixRect.top) / scaleY;
      const targetX = (targetRect.left - matrixRect.left) / scaleX;
      const curve = Math.max(18, (targetX - sourceX) * .45);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${sourceX} ${sourceY} C ${sourceX + curve} ${sourceY}, ${targetX - curve} ${targetY}, ${targetX} ${targetY}`);
      linksSvg.append(path);
    }
  }
}

let linkFrame = 0;
function scheduleLinks() {
  cancelAnimationFrame(linkFrame);
  linkFrame = requestAnimationFrame(drawLinks);
}

// Keep progress, navigation, and board status synchronized with journey state.
function updateControls() {
  document.getElementById("progress-label").textContent = currentStage === 0
    ? "Ready to begin"
    : currentStage === stageTotal ? "Journey complete" : `Stage ${currentStage} in progress`;
  progressNumber.innerHTML = `${String(currentStage).padStart(2, "0")} <small>/ ${stageTotal}</small>`;
  progressBar.style.width = `${currentStage / stageTotal * 100}%`;
  progressTrack.setAttribute("aria-valuenow", String(currentStage));
  previousButton.disabled = !ready || currentStage === 0;
  nextButton.disabled = !ready || currentStage === stageTotal;
  nextButton.innerHTML = currentStage === 0
    ? 'Begin journey <span aria-hidden="true">→</span>'
    : currentStage === stageTotal ? "Journey complete" : 'Next stage <span aria-hidden="true">→</span>';
  boardStatus.textContent = currentStage === 0
    ? "Select Begin journey to add the first stage."
    : `${currentStage} of ${stageTotal} stages rendered · ${matrixGrid.querySelectorAll(".event-card").length} journey items`;

  for (const button of stageNav.children) {
    const stage = button.textContent === "Start" ? 0 : Number(button.textContent);
    button.classList.toggle("done", stage > 0 && stage <= currentStage);
    button.setAttribute("aria-current", stage === currentStage ? "step" : "false");
  }
}

function setStage(stage) {
  currentStage = Math.max(0, Math.min(stageTotal, stage));
  renderMatrix();
  updateControls();
  scrollStageIntoView();
}

// Keep the selected stage visible beside the sticky lane labels.
function scrollStageIntoView() {
  if (currentStage === 0 || matrix.hidden) return;
  const heading = matrixGrid.querySelectorAll(".stage-heading")[currentStage - 1];
  const stickyColumn = matrixGrid.querySelector(".matrix-corner");
  if (!heading || !stickyColumn) return;

  const boardRect = board.getBoundingClientRect();
  const headingRect = heading.getBoundingClientRect();
  const visibleLeft = boardRect.left + stickyColumn.getBoundingClientRect().width;
  const visibleRight = boardRect.right;
  const usableWidth = visibleRight - visibleLeft;
  let nextScrollLeft = board.scrollLeft;

  if (headingRect.width > usableWidth) {
    if (headingRect.left < visibleLeft || headingRect.left > visibleRight) {
      nextScrollLeft += headingRect.left - visibleLeft;
    }
  } else if (headingRect.left < visibleLeft) {
    nextScrollLeft += headingRect.left - visibleLeft;
  } else if (headingRect.right > visibleRight) {
    nextScrollLeft += headingRect.right - visibleRight;
  }

  nextScrollLeft = Math.max(0, Math.min(board.scrollWidth - board.clientWidth, nextScrollLeft));
  if (Math.abs(nextScrollLeft - board.scrollLeft) > 1) {
    const shouldScrollImmediately = document.visibilityState === "hidden"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    board.scrollTo({
      left: nextScrollLeft,
      behavior: shouldScrollImmediately ? "auto" : "smooth"
    });
  }
}

nextButton.addEventListener("click", () => setStage(currentStage + 1));
previousButton.addEventListener("click", () => setStage(currentStage - 1));
document.getElementById("reset-button").addEventListener("click", () => {
  setStage(0);
  board.scrollTo({ left: 0, top: 0, behavior: "smooth" });
});

document.getElementById("zoom-in").addEventListener("click", () => {
  zoom = Math.min(1.2, Math.round((zoom + .1) * 100) / 100);
  matrix.style.zoom = String(zoom);
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  scheduleLinks();
});
document.getElementById("zoom-out").addEventListener("click", () => {
  zoom = Math.max(.8, Math.round((zoom - .1) * 100) / 100);
  matrix.style.zoom = String(zoom);
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  scheduleLinks();
});
window.addEventListener("resize", scheduleLinks);

// Fetch and parse the SVG before enabling the journey controls.
async function loadJourney() {
  try {
    const sourcePath = encodeURIComponent("northumbria-regional-map (1) 1 (1).svg");
    const response = await fetch(sourcePath);
    if (!response.ok) throw new Error(`SVG request failed with ${response.status}`);
    const source = await response.text();
    const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error("SVG could not be parsed");
    buildSourceData(parsed);
    ready = true;
    renderStageNav();
    updateControls();
    boardStatus.textContent = "Select Begin journey to add the first stage.";
  } catch (error) {
    boardStatus.textContent = "The pathway content could not be loaded.";
    console.error("Unable to load referral journey", error);
  }
}

renderStageNav();
updateControls();
loadJourney();