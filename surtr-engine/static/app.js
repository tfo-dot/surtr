let activeVault = "";
let activeNodeId = "";
let activeNodeNamespace = "";
let activeNodeMetadataExtra = {};
let nodesList = [];
let graphData = { nodes: [], edges: [] };
let d3Simulation = null;
let d3Zoom = null;
let activeTagFilter = "";
let easyMDE = null;
let linkModeActive = false;
let linkModeSourceNodeId = null;

let autocompleteActive = false;
let autocompleteTriggerIndex = -1;
let autocompleteSelectedIndex = 0;
let autocompleteMatches = [];
let readOnlyActive = false;

const vaultSelect = document.getElementById("vault-select");
const explorerTree = document.getElementById("explorer-tree");
const nodeSearch = document.getElementById("node-search");

const tabPreview = document.getElementById("tab-preview");
const tabEditor = document.getElementById("tab-editor");
const panelPreview = document.getElementById("panel-preview");
const panelEditor = document.getElementById("panel-editor");

const viewNamespace = document.getElementById("view-namespace");
const viewTagsContainer = document.getElementById("view-tags-container");
const viewTags = document.getElementById("view-tags");
const viewContent = document.getElementById("view-content");
const nodeViewer = document.querySelector(".node-viewer");
const emptyDetailState = document.querySelector(".empty-detail-state");

const editId = document.getElementById("edit-id");
const editNamespace = document.getElementById("edit-namespace");
const editTitle = document.getElementById("edit-title");
const editTags = document.getElementById("edit-tags");
const editContent = document.getElementById("edit-content");
const editContinuationGroup = document.getElementById(
  "editor-continuation-group",
);
const editContinuation = document.getElementById("edit-continuation");
const btnDelete = document.getElementById("btn-delete");

const inboxModal = document.getElementById("inbox-modal");
const inboxContent = document.getElementById("inbox-content");

addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  setupD3Graph();
  loadVaults();
  setupMarkedImageRenderer();

  easyMDE = new EasyMDE({
    element: document.getElementById("edit-content"),
    spellChecker: false,
    autoDownloadFontAwesome: true,
    status: false,
    autosave: { enabled: false },
    renderingConfig: { singleLineBreaks: false },
    toolbar: [
      "bold",
      "italic",
      "heading",
      "|",
      "quote",
      "unordered-list",
      "ordered-list",
      "|",
      "link",
      "image",
      "|",
      "preview",
      "side-by-side",
      "fullscreen",
      "|",
      {
        name: "insert-audio",
        action: (editor) => {
          editor.codemirror.replaceSelection(
            '<audio controls src="assets/filename.mp3"></audio>',
          );
        },
        className: "fa fa-volume-up",
        title: "Insert Audio Player",
      },
    ],
  });

  easyMDE.codemirror.on("change", (cm) => {
    const val = cm.getValue();
    editContent.value = val;

    const caret = cm.getCursor();
    const lineText = cm.getLine(caret.line);
    const textBefore = lineText.substring(0, caret.ch);
    const lastOpen = textBefore.lastIndexOf("[[");
    const lastClose = textBefore.lastIndexOf("]]");

    if (lastOpen !== -1 && lastOpen > lastClose) {
      const query = textBefore.substring(lastOpen + 2);
      if (!query.includes("\n")) {
        showAutocompleteSuggestionsCM(query, lastOpen + 2, caret.line, cm);
        return;
      }
    }
    hideAutocompleteSuggestions();
  });

  easyMDE.codemirror.on(
    "keydown",
    (cm, e) => {
      autocompleteActive && handleAutocompleteKeydownCM(cm, e);
    },
  );
});

function setupMarkedImageRenderer() {
  const renderer = {
    image({ href, title, text = "" }) {
      if (
        href && !href.startsWith("http://") && !href.startsWith("https://") &&
        !href.startsWith("/")
      ) {
        href = `/vaults/${activeVault}/${
          getNamespaceString(activeNodeNamespace)
        }/${href}`;
      } else if (href && href.startsWith("/")) {
        if (!href.startsWith("/vaults/")) {
          href = `/vaults/${activeVault}${href}`;
        }
      }

      return `<img src="${href}" alt="${text}" ${
        title ? ` title="${title}"` : ""
      } style="max-width: 100%; border-radius: 8px; border: 1px solid var(--border-color); margin: 12px 0; display: block;"  />`;
    },
  };

  marked.use({ renderer });
}

function setupEventListeners() {
  vaultSelect.addEventListener("change", (e) => {
    activeVault = e.target.value;
    activeNodeId = "";
    reloadVault();
  });

  let searchTimeout = null;
  nodeSearch.addEventListener("input", (e) => {
    const q = e.target.value.trim();

    if (!q) {
      renderExplorerTree();
      updateGraphOpacityForSearch("");
      return;
    }

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      performFullTextSearch(q);
      updateGraphOpacityForSearch(q);
    }, 250);
  });

  document.getElementById("btn-new-node")?.addEventListener("click", () => {
    createNewNodeForm();
  });

  document.getElementById("btn-reload")?.addEventListener("click", () => {
    activeVault && reloadVault();
  });

  document.getElementById("btn-reset-zoom")?.addEventListener("click", () => {
    resetGraphZoom();
  });

  // Quick Inbox Modal
  document.getElementById("btn-add-inbox")?.addEventListener("click", () => {
    if (!activeVault) {
      alert("Please select a vault first.");
      return;
    }
    openInboxModal();
  });

  document.getElementById("modal-close").addEventListener(
    "click",
    closeInboxModal,
  );
  document.getElementById("btn-modal-cancel").addEventListener(
    "click",
    closeInboxModal,
  );
  document.getElementById("btn-modal-submit").addEventListener(
    "click",
    submitInboxEntry,
  );

  // Workspace, Timeline vs Diagnostics View Toggle
  const btnToggleWorkspace = document.getElementById("btn-toggle-workspace");
  const btnToggleTimeline = document.getElementById("btn-toggle-timeline");
  const btnToggleDiagnostics = document.getElementById(
    "btn-toggle-diagnostics",
  );

  const viewWorkspace = document.getElementById("workspace-view");
  const viewTimeline = document.getElementById("timeline-view");
  const viewDiagnostics = document.getElementById("diagnostics-view");

  const deactivateAllViews = () => {
    btnToggleWorkspace.classList.remove("active");
    btnToggleTimeline.classList.remove("active");
    btnToggleDiagnostics.classList.remove("active");
    viewWorkspace.classList.remove("active");
    viewTimeline.classList.remove("active");
    viewDiagnostics.classList.remove("active");
  };

  btnToggleWorkspace.addEventListener("click", () => {
    deactivateAllViews();
    btnToggleWorkspace.classList.add("active");
    viewWorkspace.classList.add("active");
  });

  btnToggleTimeline.addEventListener("click", () => {
    if (!activeVault) {
      alert("Please select an active vault first.");
      return;
    }

    deactivateAllViews();
    btnToggleTimeline.classList.add("active");
    viewTimeline.classList.add("active");
    renderTimelineView();
  });

  btnToggleDiagnostics.addEventListener("click", () => {
    if (!activeVault) {
      alert("Please select an active vault first.");
      return;
    }
    deactivateAllViews();
    btnToggleDiagnostics.classList.add("active");
    viewDiagnostics.classList.add("active");
    runDiagnostics();
  });

  // Vault creation modal triggers
  const btnNewVault = document.getElementById("btn-new-vault");
  const vaultModal = document.getElementById("vault-modal");
  const vaultModalClose = document.getElementById("vault-modal-close");
  const btnVaultModalCancel = document.getElementById("btn-vault-modal-cancel");
  const btnVaultModalSubmit = document.getElementById("btn-vault-modal-submit");
  const newVaultNameInput = document.getElementById("new-vault-name");

  btnNewVault?.addEventListener("click", () => {
    newVaultNameInput.value = "";
    vaultModal.classList.add("active");
    newVaultNameInput.focus();
  });

  document.getElementById("btn-find-path")?.addEventListener(
    "click",
    findPathfinderConnection,
  );

  document.getElementById("tab-split")?.addEventListener(
    "click",
    () => switchTab("split"),
  );

  editNamespace.addEventListener("change", (e) => {
    if (e.target.value !== "story") {
      editContinuationGroup.style.display = "none";
      return;
    }

    editContinuationGroup.style.display = "block";
    editContinuation.innerHTML =
      '<option value="">None / End of Story</option>';
    nodesList.forEach((other) => {
      if (other.id !== editId.value) {
        const opt = document.createElement("option");
        opt.value = other.id;
        opt.textContent = other.title
          ? `${other.id} (${other.title})`
          : other.id;
        editContinuation.appendChild(opt);
      }
    });
  });

  const closeVaultModal = () => {
    vaultModal.classList.remove("active");
  };

  vaultModalClose?.addEventListener("click", closeVaultModal);
  btnVaultModalCancel?.addEventListener("click", closeVaultModal);
  btnVaultModalSubmit?.addEventListener("click", submitCreateVault);
  tabPreview.addEventListener("click", () => switchTab("preview"));
  tabEditor.addEventListener("click", () => switchTab("editor"));
  document.getElementById("btn-save").addEventListener("click", saveNode);
  btnDelete.addEventListener("click", deleteNode);
  editContent.addEventListener("input", handleEditorInput);
  editContent.addEventListener("keydown", handleEditorKeydown);
  editContent.addEventListener("scroll", syncEditorScroll);

  document.addEventListener("click", (e) => {
    const valid = !document.getElementById("autocomplete-suggestions").contains(
      e.target,
    );

    if (e.target !== editContent && valid) {
      hideAutocompleteSuggestions();
    }
  });

  setupAssetManagerDragDrop();

  const tabExplorer = document.getElementById("tab-explorer");
  const tabTags = document.getElementById("tab-tags");
  const explorerTreeContainer = document.getElementById("explorer-tree");
  const explorerTagsContainer = document.getElementById("explorer-tags");

  tabExplorer?.addEventListener("click", () => {
    tabExplorer.classList.add("active");
    tabTags.classList.remove("active");
    explorerTreeContainer.style.display = "block";
    explorerTagsContainer.style.display = "none";
  });

  tabTags?.addEventListener("click", () => {
    tabTags.classList.add("active");
    tabExplorer.classList.remove("active");
    explorerTreeContainer.style.display = "none";
    explorerTagsContainer.style.display = "block";
    renderTagExplorer();
  });

  document.getElementById("btn-close-audio")?.addEventListener("click", () => {
    const audioDock = document.getElementById("audio-dock");
    if (audioDock) audioDock.style.display = "none";

    document.getElementById("global-audio-player")?.pause();
  });

  const btnLinkMode = document.getElementById("btn-link-mode");
  btnLinkMode.addEventListener("click", () => {
    linkModeActive = !linkModeActive;
    linkModeSourceNodeId = null;

    btnLinkMode.classList.toggle("active");

    if (linkModeActive) {
      btnLinkMode.style.borderColor = "var(--color-primary)";
      btnLinkMode.style.color = "var(--color-primary)";
      btnLinkMode.textContent = "Link Mode: Select Source...";
    } else {
      btnLinkMode.style.borderColor = "rgba(255,255,255,0.15)";
      btnLinkMode.style.color = "";
      btnLinkMode.textContent = "Link Mode: Off";
      d3.selectAll(".graph-node").style("opacity", 1.0);
    }
  });

  document.getElementById("btn-rename-node")?.addEventListener("click", () => {
    if (!activeNodeId && !activeVault) return;

    const newId = prompt(
      `Enter new Node ID for '${activeNodeId}':`,
      activeNodeId,
    );

    if (newId) {
      (async () => {
        await fetch(`/api/vaults/${activeVault}/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ old_id: activeNodeId, new_id: newId }),
        })
          .catch(() => alert("Failed to rename node"))
          .then(async () => {
            await Promise.all(reloadVault(), selectNode(newId));

            alert(`Successfully renamed note and updated references!`);
          });
      })();
    }
  });

  document.getElementById("btn-clean-assets")?.addEventListener(
    "click",
    async () => {
      if (!activeVault && !confirm(DELETE_ORPHAN_ASSETS_MSG)) return;

      await fetch(`/api/vaults/${activeVault}/assets/clean`, {
        method: "POST",
      })
        .then((resp) => resp.json())
        .catch((err) => alert(err.message));

      await Promise.all(scanOrphanAssets(), loadVaultAssets());
    },
  );

  document.getElementById("btn-export-vault")?.addEventListener("click", () => {
    if (!activeVault) {
      alert("Please select a vault first.");
      return;
    }

    window.location.href = `/api/vaults/${activeVault}/export`;
  });

  document.getElementById("btn-diagnose-assets")?.addEventListener(
    "click",
    scanOrphanAssets,
  );
  document.getElementById("btn-clear-tag-filter")?.addEventListener(
    "click",
    clearTagFilter,
  );
  document.getElementById("reader-modal-close")?.addEventListener(
    "click",
    closeStoryArcReader,
  );
  document.getElementById("tab-outline")?.addEventListener(
    "click",
    () => switchTab("outline"),
  );
}

function switchTab(tabName) {
  const detailPane = document.querySelector(".detail-pane");
  detailPane?.classList.remove("split-active");

  const tabSplit = document.getElementById("tab-split");
  tabSplit?.classList.remove("active");

  const tabOutline = document.getElementById("tab-outline");
  tabOutline?.classList.remove("active");

  const panelOutline = document.getElementById("panel-outline");
  panelOutline?.classList.remove("active");

  tabPreview.classList.remove("active");
  tabEditor.classList.remove("active");
  panelPreview.classList.remove("active");
  panelEditor.classList.remove("active");

  switch (tabName) {
    case "preview":
      tabPreview.classList.add("active");
      panelPreview.classList.add("active");
      break;
    case "editor":
      tabEditor.classList.add("active");
      panelEditor.classList.add("active");
      break;
    case "split":
      tabSplit?.classList.add("active");
      panelPreview.classList.add("active");
      panelEditor.classList.add("active");
      detailPane?.classList.add("split-active");
      syncEditorScroll();
      break;
    case "outline":
      tabOutline?.classList.add("active");
      panelOutline?.classList.add("active");
      break;
  }
}

async function loadVaults() {
  try {
    const resp = await fetch("/api/vaults");
    if (!resp.ok) throw new Error("Failed to load vaults");
    const vaults = await resp.json();

    vaultSelect.innerHTML =
      '<option value="" disabled selected>Select Vault...</option>';

    if (!vaults.length) {
      return;
    }

    vaults.forEach((vault) => {
      const opt = document.createElement("option");
      opt.value = vault;
      opt.textContent = vault;
      vaultSelect.appendChild(opt);
    });

    vaultSelect.value = vaults[0];
    activeVault = vaults[0];
    reloadVault();
  } catch (err) {
    console.error(err);
    explorerTree.innerHTML =
      '<div class="empty-state">Error loading vaults. Is backend running?</div>';
  }
}

// Switch Active Vault
async function reloadVault() {
  explorerTree.innerHTML =
    '<div class="empty-state">Loading vault contents...</div>';

  activeTagFilter = "";
  document.getElementById("tag-filter-indicator").style.display = "none";

  await Promise.all([
    (async () => {
      graphData = await fetch(`/api/vaults/${activeVault}/graph`)
        .then((resp) => resp.json())
        .catch((err) => {
          console.error(err);
          return [];
        });

      drawGraph();
    })(),
    (async () => {
      nodesList = await fetch(`/api/vaults/${activeVault}/nodes`)
        .then((resp) => resp.json())
        .catch((err) => {
          explorerTree.innerHTML =
            '<div class="empty-state">Error loading vault nodes.</div>';
          console.error(err);
          return [];
        });

      nodesList.length && renderExplorerTree();
    })(),
  ]);
}

// Group nodes by namespace and render tree
function renderExplorerTree() {
  explorerTree.innerHTML = "";
  const filterText = nodeSearch.value.trim().toLowerCase();

  let filteredNodes = nodesList;

  if (filterText) {
    filteredNodes = nodesList.filter((node) => {
      if (activeTagFilter) {
        const hasTag = node.tags &&
          node.tags.some((tag) =>
            tag.toLowerCase() === activeTagFilter.toLowerCase()
          );
        if (!hasTag) return false;
      }

      const idMatch = node.id.toLowerCase().includes(filterText);
      const titleMatch = node.title &&
        node.title.toLowerCase().includes(filterText);
      const tagsMatch = node.tags &&
        node.tags.some((tag) => tag.toLowerCase().includes(filterText));
      return idMatch || titleMatch || tagsMatch;
    });
  }

  if (filteredNodes.length === 0) {
    explorerTree.innerHTML =
      '<div class="empty-state">No nodes match the search.</div>';
    return;
  }

  const groups = {};

  filteredNodes.forEach((node) => {
    const ns = node.namespace.toLowerCase();
    if (!groups[ns]) groups[ns] = [];
    groups[ns].push(node);
  });

  const styledNs = [
    "global",
    "inbox",
    "story",
    "character",
    "location",
    "definition",
    "topic",
  ];

  Object
    .keys(groups)
    .sort((a, b) => a.localeCompare(b))
    .forEach((ns) => {
      const list = groups[ns];
      if (list.length === 0) return;

      const section = document.createElement("div");
      section.className = "tree-section";

      const header = document.createElement("div");
      header.className = "tree-section-header";

      const dot = document.createElement("span");
      dot.className = `tree-section-dot dot-${
        styledNs.includes(ns) ? ns : "other"
      }`;

      header.appendChild(dot);
      header.appendChild(document.createTextNode(ns));
      section.appendChild(header);

      list.forEach((node) => {
        const item = document.createElement("div");
        item.className = `tree-node-item ${
          node.id === activeNodeId ? "active" : ""
        }`;
        item.dataset.id = node.id;

        const label = document.createElement("span");
        label.textContent = node.id;
        item.appendChild(label);

        if (node.title) {
          const sub = document.createElement("span");
          sub.className = "tree-node-title";
          sub.textContent = node.title;
          item.appendChild(sub);
        }

        item.addEventListener("click", () => selectNode(node.id));
        section.appendChild(item);
      });

      explorerTree.appendChild(section);
    });
}

// D3 Force Directed Graph setup
function setupD3Graph() {
  const svg = d3.select("#graph-canvas");

  // Zoom/Pan setup
  d3Zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on("zoom", (event) => {
      svg.select("g.main-container").attr("transform", event.transform);
    });

  svg.call(d3Zoom);

  // Clear and build inner structure
  svg.html("");
  const mainContainer = svg.append("g").attr("class", "main-container");

  // Markers for directed links
  svg.append("defs").append("marker")
    .attr("id", "arrowhead")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 18)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-4L8,0L0,4")
    .attr("fill", "rgba(255, 255, 255, 0.25)");

  mainContainer.append("g").attr("class", "edges-group");
  mainContainer.append("g").attr("class", "nodes-group");
  mainContainer.append("g").attr("class", "labels-group");
}

// Draw D3 Graph
function drawGraph() {
  const svg = d3.select("#graph-canvas");
  const container = svg.node();
  if (!container) return;
  const width = container.clientWidth || 600;
  const height = container.clientHeight || 500;

  const mainContainer = svg.select("g.main-container");
  const edgesGroup = mainContainer.select("g.edges-group");
  const nodesGroup = mainContainer.select("g.nodes-group");
  const labelsGroup = mainContainer.select("g.labels-group");

  // Cancel old simulation
  if (d3Simulation) d3Simulation.stop();

  // Compute connection counts for centrality-based sizing
  const degreeMap = {};
  graphData.nodes.forEach((n) => degreeMap[n.id] = 0);
  graphData.edges.forEach((e) => {
    const sourceId = e.source.id || e.source;
    const targetId = e.target.id || e.target;
    if (degreeMap[sourceId] !== undefined) degreeMap[sourceId]++;
    if (degreeMap[targetId] !== undefined) degreeMap[targetId]++;
  });

  // Map namespaces to colors
  const nsColors = {
    global: "var(--ns-global)",
    inbox: "var(--ns-inbox)",
    stories: "var(--ns-story)",
    story: "var(--ns-story)",
    characters: "var(--ns-characters)",
    character: "var(--ns-characters)",
    locations: "var(--ns-locations)",
    location: "var(--ns-locations)",
    definitions: "var(--ns-definitions)",
    definition: "var(--ns-definitions)",
    topics: "var(--ns-topics)",
    topic: "var(--ns-topics)",
    other: "var(--ns-other)",
  };

  const getNsColor = (ns) => nsColors[ns.toLowerCase()] || "var(--ns-other)";

  // Target coordinate centers for namespaces to group them spatially
  const nsCenters = {
    global: { x: width * 0.2, y: height * 0.25 },
    inbox: { x: width * 0.5, y: height * 0.2 },
    stories: { x: width * 0.8, y: height * 0.25 },
    story: { x: width * 0.8, y: height * 0.25 },
    characters: { x: width * 0.2, y: height * 0.6 },
    character: { x: width * 0.2, y: height * 0.6 },
    locations: { x: width * 0.5, y: height * 0.65 },
    location: { x: width * 0.5, y: height * 0.65 },
    definitions: { x: width * 0.8, y: height * 0.6 },
    definition: { x: width * 0.8, y: height * 0.6 },
    topics: { x: width * 0.35, y: height * 0.85 },
    other: { x: width * 0.65, y: height * 0.85 },
  };

  // Run Force Simulation
  d3Simulation = d3.forceSimulation(graphData.nodes)
    .force("link", d3.forceLink(graphData.edges).id((d) => d.id).distance(100))
    .force("charge", d3.forceManyBody().strength(-120).distanceMax(300))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force(
      "x",
      d3.forceX((d) => {
        const ns = getNamespaceString(d.namespace);
        return nsCenters[ns] ? nsCenters[ns].x : width / 2;
      }).strength(0.08),
    )
    .force(
      "y",
      d3.forceY((d) => {
        const ns = getNamespaceString(d.namespace);
        return nsCenters[ns] ? nsCenters[ns].y : height / 2;
      }).strength(0.08),
    )
    .force(
      "collision",
      d3.forceCollide().radius((d) =>
        12 + Math.min((degreeMap[d.id] || 0) * 1.5, 16)
      ),
    );

  // Render Edges (Links)
  const links = edgesGroup.selectAll(".graph-edge")
    .data(
      graphData.edges,
      (d) => `${d.source.id || d.source}-${d.target.id || d.target}`,
    );

  links.exit().remove();

  const linksEnter = links.enter().append("path")
    .attr("marker-end", "url(#arrowhead)");

  const allLinks = linksEnter.merge(links)
    .attr("class", (d) => {
      const sourceId = d.source.id || d.source;
      const targetId = d.target.id || d.target;
      const sourceNode = graphData.nodes.find((n) => n.id === sourceId);
      const targetNode = graphData.nodes.find((n) => n.id === targetId);
      if (
        sourceNode && targetNode &&
        getNamespaceString(sourceNode.namespace) === "stories" &&
        getNamespaceString(targetNode.namespace) === "stories"
      ) {
        return "graph-edge story-flow";
      }
      return "graph-edge";
    })
    .attr("stroke", (d) => {
      const sourceId = d.source.id || d.source;
      const targetId = d.target.id || d.target;
      const sourceNode = graphData.nodes.find((n) => n.id === sourceId);
      const targetNode = graphData.nodes.find((n) => n.id === targetId);
      if (
        sourceNode && targetNode &&
        getNamespaceString(sourceNode.namespace) === "stories" &&
        getNamespaceString(targetNode.namespace) === "stories"
      ) {
        return "var(--ns-story)";
      }
      return "rgba(255, 255, 255, 0.15)";
    });

  // Render Nodes
  const nodes = nodesGroup.selectAll(".graph-node")
    .data(graphData.nodes, (d) => d.id);

  nodes.exit().remove();

  const nodesEnter = nodes.enter().append("circle")
    .attr("class", "graph-node")
    .attr("r", (d) => 8 + Math.min((degreeMap[d.id] || 0) * 1.5, 16))
    .call(drag(d3Simulation));

  const allNodes = nodesEnter.merge(nodes)
    .attr("fill", (d) => getNsColor(d.namespace))
    .attr("r", (d) => 8 + Math.min((degreeMap[d.id] || 0) * 1.5, 16))
    .attr(
      "stroke",
      (d) => d.id === activeNodeId ? "var(--color-text)" : "var(--bg-base)",
    )
    .attr("stroke-width", (d) => d.id === activeNodeId ? 2.5 : 1.5)
    .style(
      "filter",
      (d) =>
        d.id === activeNodeId
          ? `drop-shadow(0 0 8px ${getNsColor(d.namespace)})`
          : "none",
    );

  // Render Labels
  const labels = labelsGroup.selectAll(".graph-node-text")
    .data(graphData.nodes, (d) => d.id);

  labels.exit().remove();

  const labelsEnter = labels.enter().append("text")
    .attr("class", "graph-node-text")
    .attr("dy", (d) => -12 - Math.min((degreeMap[d.id] || 0) * 1.5, 16));

  const allLabels = labelsEnter.merge(labels)
    .text((d) => d.title || d.id)
    .attr("dy", (d) => -12 - Math.min((degreeMap[d.id] || 0) * 1.5, 16))
    .attr(
      "class",
      (d) => `graph-node-text ${d.id === activeNodeId ? "highlighted" : ""}`,
    );

  // Click/Hover Handlers
  allNodes.on("click", (event, d) => {
    if (linkModeActive) {
      event.stopPropagation();
      if (!linkModeSourceNodeId) {
        linkModeSourceNodeId = d.id;
        document.getElementById("btn-link-mode").textContent =
          `Link: Click Target for ${d.id}...`;
        d3.selectAll(".graph-node").style(
          "opacity",
          (n) => n.id === d.id ? 1.0 : 0.3,
        );
      } else {
        const targetId = d.id;
        const sourceId = linkModeSourceNodeId;

        if (sourceId === targetId) {
          alert("Cannot link a node to itself!");
          return;
        }

        linkModeActive = false;
        linkModeSourceNodeId = null;
        const btnLinkMode = document.getElementById("btn-link-mode");
        btnLinkMode.classList.remove("active");
        btnLinkMode.style.borderColor = "rgba(255,255,255,0.15)";
        btnLinkMode.style.color = "";
        btnLinkMode.textContent = "Link Mode: Off";
        d3.selectAll(".graph-node").style("opacity", 1.0);

        insertWikiLinkToEditor(sourceId, targetId);
      }
    } else {
      selectNode(d.id);
    }
  });

  // Hover Highlight System
  allNodes.on("mouseover", (_, d) => {
    // Highlight active connections
    const connectedNodes = new Set();
    connectedNodes.add(d.id);

    allLinks.each((l) => {
      const sourceId = l.source.id || l.source;
      const targetId = l.target.id || l.target;
      if (sourceId === d.id) connectedNodes.add(targetId);
      if (targetId === d.id) connectedNodes.add(sourceId);
    });

    allNodes.style("opacity", (n) => connectedNodes.has(n.id) ? 1.0 : 0.25);
    allLabels.style("opacity", (n) => connectedNodes.has(n.id) ? 1.0 : 0.25);
    allLinks.style("stroke-opacity", (l) => {
      const sourceId = l.source.id || l.source;
      const targetId = l.target.id || l.target;
      return (sourceId === d.id || targetId === d.id) ? 0.9 : 0.05;
    }).style("stroke", (l) => {
      const sourceId = l.source.id || l.source;
      const targetId = l.target.id || l.target;
      return (sourceId === d.id || targetId === d.id)
        ? getNsColor(d.namespace)
        : "rgba(255, 255, 255, 0.15)";
    });
  });

  allNodes.on("mouseout", () => {
    updateGraphOpacityForSearch(nodeSearch.value);
  });

  // Ticks logic
  d3Simulation.on("tick", () => {
    allLinks.attr("d", (d) => {
      return `M${d.source.x},${d.source.y} L${d.target.x},${d.target.y}`;
    });

    allNodes
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y);

    allLabels
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y);
  });

  // Zoom to fit initially if simulation contains nodes
  if (graphData.nodes.length > 0) {
    setTimeout(resetGraphZoom, 150);
  }

  updateGraphOpacityForSearch(nodeSearch.value);
}

// Drag behaviors
function drag(simulation) {
  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  return d3.drag()
    .on("start", dragstarted)
    .on("drag", dragged)
    .on("end", dragended);
}

// Zoom fitting
function resetGraphZoom() {
  const svg = d3.select("#graph-canvas");
  const container = svg.node();
  if (!container || graphData.nodes.length === 0) return;

  const width = container.clientWidth;
  const height = container.clientHeight;

  // Calculate bounds of nodes
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  graphData.nodes.forEach((d) => {
    if (d.x < minX) minX = d.x;
    if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y;
    if (d.y > maxY) maxY = d.y;
  });

  const graphWidth = maxX - minX;
  const graphHeight = maxY - minY;
  const centerX = minX + graphWidth / 2;
  const centerY = minY + graphHeight / 2;

  if (graphWidth === 0 || graphHeight === 0) return;

  // Determine scale with padding
  const padding = 60;
  const scale = Math.min(
    (width - padding * 2) / graphWidth,
    (height - padding * 2) / graphHeight,
    1.5, // Max zoom level on fit
  );

  const transform = d3.zoomIdentity
    .translate(width / 2 - centerX * scale, height / 2 - centerY * scale)
    .scale(scale);

  svg.transition().duration(500).call(d3Zoom.transform, transform);
}

async function selectNode(nodeId) {
  activeNodeId = nodeId;

  document.querySelectorAll(".tree-node-item").forEach((item) => {
    if (item.dataset.id === nodeId) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });

  const getNsColor = (ns) => {
    const colors = {
      global: "var(--ns-global)",
      inbox: "var(--ns-inbox)",
      story: "var(--ns-story)",
      character: "var(--ns-characters)",
      location: "var(--ns-locations)",
      definition: "var(--ns-definitions)",
      topic: "var(--ns-topics)",
    };

    return colors[ns.toLowerCase()] || "var(--ns-other)";
  };

  d3.selectAll(".graph-node")
    .attr(
      "stroke",
      (d) => d.id === nodeId ? "var(--color-text)" : "var(--bg-base)",
    )
    .attr("stroke-width", (d) => d.id === nodeId ? 2.5 : 1.5)
    .style(
      "filter",
      (d) =>
        d.id === nodeId
          ? `drop-shadow(0 0 8px ${getNsColor(d.namespace)})`
          : "none",
    );

  d3.selectAll(".graph-node-text")
    .attr(
      "class",
      (d) => `graph-node-text ${d.id === nodeId ? "highlighted" : ""}`,
    );

  try {
    const resp = await fetch(`/api/vaults/${activeVault}/nodes/${nodeId}`);
    if (!resp.ok) throw new Error("Failed to load node content");
    const node = await resp.json();

    activeNodeNamespace = node.namespace;
    activeNodeMetadataExtra = {};
    if (node.metadata) {
      for (const key in node.metadata) {
        if (key !== "title" && key !== "tags" && key !== "extra") {
          activeNodeMetadataExtra[key] = node.metadata[key];
        }
      }
    }
    displayNode(node);
    editNodeForm(node);
    switchTab("preview");
  } catch (err) {
    console.error(err);
    emptyDetailState.textContent = `Error loading node details: ${err.message}`;
    emptyDetailState.style.display = "flex";
    nodeViewer.style.display = "none";
  }
}

function resolveWikiLinkTarget(target, availableNodes) {
  const targetLower = target.toLowerCase();

  // 1. Direct match
  let match = availableNodes.find((n) => n.id.toLowerCase() === targetLower);
  if (match) return match.id;

  // 2. Alias match
  match = availableNodes.find((n) => {
    if (n.aliases && Array.isArray(n.aliases)) {
      return n.aliases.some((alias) => alias.toLowerCase() === targetLower);
    }
    return false;
  });
  if (match) return match.id;

  return null;
}

// Pre-process wiki links inside markdown content
function replaceWikiLinks(markdownText, availableNodes) {
  const isSourceStory = getNamespaceString(activeNodeNamespace) === "stories";

  // 1. First, replace the custom ((label))[[target]] syntax
  let processed = markdownText.replace(
    /\(\((.*?)\)\)\[\[([^\]]+)\]\]/g,
    (_, label, rawTarget) => {
      const target = rawTarget.trim();
      const resolvedId = resolveWikiLinkTarget(target, availableNodes);
      if (resolvedId) {
        const targetNode = availableNodes.find((n) => n.id === resolvedId);
        const isTargetStory = targetNode &&
          getNamespaceString(targetNode.namespace) === "stories";
        const className = (isSourceStory && isTargetStory)
          ? "wiki-link story-next-link"
          : "wiki-link";
        return `<a class="${className}" onclick="handleWikiLinkClick('${resolvedId}')">${label}</a>`;
      } else {
        return `<a class="wiki-link broken-link" onclick="handleWikiLinkClick('${target}')">${label}</a>`;
      }
    },
  );

  // 2. Then, replace the standard [[target]] or [[target|label]] syntax
  processed = processed.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
    const parts = inner.split("|");
    const rawTarget = parts[0].trim();
    const label = parts.length > 1 ? parts[1].trim() : rawTarget;

    const resolvedId = resolveWikiLinkTarget(rawTarget, availableNodes);
    if (resolvedId) {
      const targetNode = availableNodes.find((n) => n.id === resolvedId);
      const isTargetStory = targetNode &&
        getNamespaceString(targetNode.namespace) === "stories";
      const className = (isSourceStory && isTargetStory)
        ? "wiki-link story-next-link"
        : "wiki-link";
      return `<a class="${className}" onclick="handleWikiLinkClick('${resolvedId}')">${label}</a>`;
    } else {
      return `<a class="wiki-link broken-link" onclick="handleWikiLinkClick('${rawTarget}')">${label}</a>`;
    }
  });

  return processed;
}

// Global hook for wiki link click inside preview iframe/markdown
function handleWikiLinkClick(targetId) {
  const exists = nodesList.some((n) => n.id === targetId);
  if (exists) {
    selectNode(targetId);
  } else {
    // Offer to create it!
    if (
      confirm(`Node '${targetId}' does not exist. Do you want to create it?`)
    ) {
      createNewNodeForm(targetId);
    }
  }
}

function getNamespaceString(ns) {
  if (typeof ns === "string") {
    return ns.toLowerCase();
  }
  if (ns && typeof ns === "object") {
    if (ns.Other) {
      return ns.Other.toLowerCase();
    }
    const keys = Object.keys(ns);
    if (keys.length > 0) {
      const val = keys[0].toLowerCase();
      if (val === "other" && ns.other) return ns.other.toLowerCase();
      return val;
    }
  }
  return "other";
}

// Render node data to details pane
function displayNode(node) {
  emptyDetailState.style.display = "none";
  nodeViewer.style.display = "block";

  const nsStr = getNamespaceString(node.namespace);

  document.getElementById("view-id").textContent = node.id;
  document.getElementById("view-title").textContent = node.metadata.title ||
    "Untitled";

  viewNamespace.textContent = nsStr;
  viewNamespace.className = `meta-value ns-badge ns-${nsStr}`;

  if (node.metadata.tags && node.metadata.tags.length > 0) {
    viewTagsContainer.style.display = "flex";
    viewTags.innerHTML = "";
    node.metadata.tags.forEach((tag) => {
      const span = document.createElement("span");
      span.className = "tag-badge";
      span.textContent = tag;
      span.style.cursor = "pointer";
      span.addEventListener("click", () => filterByTag(tag));
      viewTags.appendChild(span);
    });
  } else {
    viewTagsContainer.style.display = "none";
  }

  // Story arc read row toggle
  const storyArcRow = document.getElementById("view-story-arc-row");
  if (storyArcRow && nsStr === "story") {
    storyArcRow.style.display = "flex";
    const btnReadArc = document.getElementById("btn-read-story-arc");
    if (btnReadArc) {
      const newBtn = btnReadArc.cloneNode(true);
      btnReadArc.parentNode.replaceChild(newBtn, btnReadArc);
      newBtn.addEventListener("click", () => openStoryArcReader(node.id));
    }
  } else {
    storyArcRow.style.display = "none";
  }

  // Process wiki links first, then markdown
  const processedMarkdown = replaceWikiLinks(node.content, nodesList);
  viewContent.innerHTML = marked.parse(processedMarkdown);

  // Render Map Overlay if present
  const hasMap = node.metadata &&
    (node.metadata.map || (node.metadata.extra && node.metadata.extra.map));
  if (hasMap) {
    const mapFilename = node.metadata.map || node.metadata.extra.map;
    const mapUrl = `/vaults/${activeVault}/assets/${mapFilename}`;

    const mapOuter = document.createElement("div");
    mapOuter.className = "map-outer-container";

    const mapImg = document.createElement("img");
    mapImg.className = "map-image";
    mapImg.src = mapUrl;
    mapImg.alt = "Location Map";
    mapOuter.appendChild(mapImg);

    const pinsContainer = document.createElement("div");
    pinsContainer.className = "map-pins-container";

    const pins = node.metadata.pins || [];

    pins.forEach((pin) => {
      const pinEl = document.createElement("div");
      pinEl.className = "map-pin";
      pinEl.style.left = `${pin.x}%`;
      pinEl.style.top = `${pin.y}%`;

      const targetNode = nodesList.find((n) => n.id === pin.node);
      const nsStr = targetNode
        ? getNamespaceString(targetNode.namespace)
        : "global";

      pinEl.style.background = `var(--ns-${nsStr})`;
      pinEl.style.boxShadow = `0 0 8px var(--ns-${nsStr})`;

      const pulse = document.createElement("div");
      pulse.className = "map-pin-pulse";
      pulse.style.background = `var(--ns-${nsStr})`;
      pinEl.appendChild(pulse);

      const tooltip = document.createElement("div");
      tooltip.className = "map-pin-tooltip";
      tooltip.textContent = pin.label || pin.node;
      pinEl.appendChild(tooltip);

      pinEl.addEventListener("click", (e) => {
        e.stopPropagation();
        selectNode(pin.node);
      });

      pinsContainer.appendChild(pinEl);
    });

    pinsContainer.addEventListener("click", (e) => {
      if (e.target !== pinsContainer) return;
      const rect = pinsContainer.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width * 100).toFixed(1);
      const y = ((e.clientY - rect.top) / rect.height * 100).toFixed(1);
      promptAndAddMapPin(node, x, y);
    });

    mapOuter.appendChild(pinsContainer);
    viewContent.insertBefore(mapOuter, viewContent.firstChild);
  }

  if (node.metadata && node.metadata.continuation) {
    const continuationId = node.metadata.continuation;
    const contNode = nodesList.find((n) => n.id === continuationId);
    const contTitle = (contNode && contNode.title)
      ? contNode.title
      : continuationId;

    const banner = document.createElement("div");
    banner.className = "continuation-banner";
    banner.style.marginTop = "32px";
    banner.style.paddingTop = "20px";
    banner.style.borderTop = "1px dashed var(--border-color)";
    banner.style.display = "flex";
    banner.style.alignItems = "center";
    banner.style.justifyContent = "space-between";
    banner.style.gap = "12px";

    const labelSpan = document.createElement("span");
    labelSpan.style.color = "var(--color-text-muted)";
    labelSpan.style.fontSize = "0.85rem";
    labelSpan.style.fontWeight = "500";
    labelSpan.textContent = "Next Story Progression:";
    banner.appendChild(labelSpan);

    const linkAnchor = document.createElement("a");
    linkAnchor.className = "wiki-link story-next-link";
    linkAnchor.style.margin = "0";
    linkAnchor.textContent = contTitle;
    linkAnchor.addEventListener("click", () => {
      handleWikiLinkClick(continuationId);
    });
    banner.appendChild(linkAnchor);

    viewContent.appendChild(banner);
  }
}

function editNodeForm(node) {
  editId.value = node.id;
  editId.disabled = true;

  const nsStr = getNamespaceString(node.namespace);

  const optionExists = [...editNamespace.options].some((opt) =>
    opt.value === nsStr
  );

  if (!optionExists) {
    const opt = document.createElement("option");
    opt.value = nsStr;
    opt.textContent = nsStr.charAt(0).toUpperCase() + nsStr.slice(1);
    editNamespace.appendChild(opt);
  }

  editNamespace.value = nsStr;
  editTitle.value = node.metadata.title || "";
  editTags.value = node.metadata.tags ? node.metadata.tags.join(", ") : "";
  editContent.value = node.content;

  editContinuation.innerHTML = '<option value="">None / End of Story</option>';

  const otherNodes = nodesList.filter((n) =>
    n.id !== node.id && getNamespaceString(n.namespace) === "stories"
  );

  otherNodes.forEach((other) => {
    const opt = document.createElement("option");
    opt.value = other.id;
    opt.textContent = other.title ? `${other.id} (${other.title})` : other.id;
    editContinuation.appendChild(opt);
  });

  btnDelete.style.display = "block";
  loadVaultAssets();

  if (nsStr !== "story") {
    editContinuationGroup.style.display = "none";
    return;
  }

  editContinuationGroup.style.display = "block";
  editContinuation.value = node?.metadata?.continuation ?? "";
}

// Prepare Editor for creating a new node
function createNewNodeForm(suggestedId = "") {
  activeNodeId = "";
  document.querySelectorAll(".tree-node-item").forEach((item) =>
    item.classList.remove("active")
  );

  editId.value = suggestedId;
  editId.disabled = false;
  editNamespace.value = "global";
  editTitle.value = "";
  editTags.value = "";

  btnDelete.style.display = "none";
  editContinuationGroup.style.display = "none";
  editContinuation.value = "";
  activeNodeMetadataExtra = {};

  switchTab("editor");
  editId.focus();
  loadVaultAssets();
}

// Save/Update Node Handler
async function saveNode() {
  const id = editId.value.trim();
  const namespace = editNamespace.value;
  const title = editTitle.value.trim();
  const tagsStr = editTags.value.trim();
  const content = editContent.value;

  if (!activeVault) {
    alert("Please select an active vault first.");
    return;
  }

  if (!id) {
    alert("Node ID is required.");
    editId.focus();
    return;
  }

  // Convert comma tags
  const tags = tagsStr
    ? tagsStr.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
    : [];

  const payload = {
    namespace: namespace,
    metadata: {
      title: title || null,
      tags: tags.length > 0 ? tags : null,
      ...activeNodeMetadataExtra,
    },
    content: content,
  };

  // Toggle continuation in metadata directly (which maps to flattened extra HashMap in Rust)
  if (namespace === "stories" || namespace === "story") {
    const contVal = editContinuation.value;
    if (contVal) {
      payload.metadata.continuation = contVal;
    } else {
      delete payload.metadata.continuation;
    }
  } else {
    delete payload.metadata.continuation;
  }

  try {
    const resp = await fetch(`/api/vaults/${activeVault}/nodes/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText);
    }

    alert("Node saved successfully.");

    // Refresh vault
    await reloadVault();

    // Select newly saved node
    await selectNode(id);
  } catch (err) {
    alert(`Failed to save node: ${err.message}`);
  }
}

// Delete Node Handler
async function deleteNode() {
  const id = editId.value.trim();
  if (!id || !activeVault) return;

  if (
    !confirm(
      `Are you sure you want to delete node '${id}'? This removes the source file from disk.`,
    )
  ) {
    return;
  }

  try {
    const resp = await fetch(`/api/vaults/${activeVault}/nodes/${id}`, {
      method: "DELETE",
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText);
    }

    alert("Node deleted successfully.");
    activeNodeId = "";

    // Reset previews
    emptyDetailState.textContent =
      "Select a node from the explorer or graph to preview.";
    emptyDetailState.style.display = "flex";
    nodeViewer.style.display = "none";

    // Refresh vault
    reloadVault();
  } catch (err) {
    alert(`Failed to delete node: ${err.message}`);
  }
}

// Inbox Entry Modal Controllers
function openInboxModal() {
  inboxContent.value = "";
  inboxModal.classList.add("active");
  inboxContent.focus();
}

function closeInboxModal() {
  inboxModal.classList.remove("active");
}

async function submitInboxEntry() {
  const content = inboxContent.value.trim();
  if (!content) {
    alert("Content cannot be empty.");
    inboxContent.focus();
    return;
  }

  try {
    const resp = await fetch(`/api/vaults/${activeVault}/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText);
    }

    alert("Quick Inbox entry added!");
    closeInboxModal();

    // Refresh nodes to pick up new inbox file
    reloadVault();
  } catch (err) {
    alert(`Failed to add inbox entry: ${err.message}`);
  }
}

// Autocomplete Input Handler
function handleEditorInput() {
  const textBefore = editContent.value.substring(0, editContent.selectionStart);
  const lastOpen = textBefore.lastIndexOf("[[");
  const lastClose = textBefore.lastIndexOf("]]");

  if (lastOpen !== -1 && lastOpen > lastClose) {
    const query = textBefore.substring(lastOpen + 2);
    if (!query.includes("\n") && !query.includes("|")) {
      showAutocompleteSuggestions(query, lastOpen + 2);
      return;
    }
  }
  hideAutocompleteSuggestions();
}

// Show suggestions popup
function showAutocompleteSuggestions(query, triggerIndex) {
  autocompleteActive = true;
  autocompleteTriggerIndex = triggerIndex;

  const q = query.toLowerCase();
  autocompleteMatches = nodesList.filter((node) =>
    node.id.toLowerCase().includes(q)
  );

  const popup = document.getElementById("autocomplete-suggestions");
  if (!popup) return;

  if (autocompleteMatches.length === 0) {
    hideAutocompleteSuggestions();
    return;
  }

  popup.innerHTML = "";
  autocompleteSelectedIndex = Math.min(
    autocompleteSelectedIndex,
    autocompleteMatches.length - 1,
  );
  if (autocompleteSelectedIndex < 0) autocompleteSelectedIndex = 0;

  autocompleteMatches.forEach((match, idx) => {
    const div = document.createElement("div");
    div.className = `autocomplete-item ${
      idx === autocompleteSelectedIndex ? "selected" : ""
    }`;

    const idSpan = document.createElement("span");
    idSpan.textContent = match.id;
    div.appendChild(idSpan);

    const nsSpan = document.createElement("span");
    nsSpan.className = "autocomplete-item-ns";
    nsSpan.textContent = match.namespace;
    div.appendChild(nsSpan);

    div.addEventListener("click", (e) => {
      e.stopPropagation();
      selectAutocompleteSuggestion(match.id);
    });

    popup.appendChild(div);
  });

  popup.style.display = "block";
}

// Select autocomplete suggestion
function selectAutocompleteSuggestion(nodeId) {
  const val = editContent.value;
  const caret = editContent.selectionStart;
  const before = val.substring(0, autocompleteTriggerIndex);
  const after = val.substring(caret);

  editContent.value = before + nodeId + "]]" + after;

  // Set caret position right after target + "]]"
  const newCaret = autocompleteTriggerIndex + nodeId.length + 2;
  editContent.selectionStart = newCaret;
  editContent.selectionEnd = newCaret;

  hideAutocompleteSuggestions();
  editContent.focus();
}

// Autocomplete Keyboard Navigation Handler
function handleEditorKeydown(e) {
  if (!autocompleteActive) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    autocompleteSelectedIndex = (autocompleteSelectedIndex + 1) %
      autocompleteMatches.length;
    showAutocompleteSuggestions(autocompleteTriggerIndex);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    autocompleteSelectedIndex =
      (autocompleteSelectedIndex - 1 + autocompleteMatches.length) %
      autocompleteMatches.length;
    showAutocompleteSuggestions(autocompleteTriggerIndex);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (autocompleteMatches.length > 0) {
      selectAutocompleteSuggestion(
        autocompleteMatches[autocompleteSelectedIndex].id,
      );
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    hideAutocompleteSuggestions();
  }
}

// Hide suggestions popup
function hideAutocompleteSuggestions() {
  autocompleteActive = false;
  const popup = document.getElementById("autocomplete-suggestions");
  if (popup) {
    popup.style.display = "none";
  }
}

function syncEditorScroll() {
  const editor = editContent;
  const preview = panelPreview;
  const editorScrollMax = editor.scrollHeight - editor.clientHeight;
  const previewScrollMax = preview.scrollHeight - preview.clientHeight;
  if (editorScrollMax > 0) {
    const ratio = editor.scrollTop / editorScrollMax;
    preview.scrollTop = ratio * previewScrollMax;
  }
}

function updateGraphOpacityForSearch(query) {
  const q = query.trim().toLowerCase();

  const matches = new Set();
  graphData.nodes.forEach((n) => {
    if (activeTagFilter) {
      const hasTag = n.tags &&
        n.tags.some((tag) =>
          tag.toLowerCase() === activeTagFilter.toLowerCase()
        );
      if (!hasTag) return;
    }

    if (q) {
      const idMatch = n.id.toLowerCase().includes(q);
      const titleMatch = n.title && n.title.toLowerCase().includes(q);
      const tagsMatch = n.tags &&
        n.tags.some((tag) => tag.toLowerCase().includes(q));
      if (!idMatch && !titleMatch && !tagsMatch) return;
    }

    matches.add(n.id);
  });

  if (!q && !activeTagFilter) {
    d3.selectAll(".graph-node").style("opacity", 1.0);
    d3.selectAll(".graph-node-text").style("opacity", 1.0);
    d3.selectAll(".graph-edge").style("stroke-opacity", 0.25);
    return;
  }

  d3.selectAll(".graph-node").style(
    "opacity",
    (d) => matches.has(d.id) ? 1.0 : 0.15,
  );
  d3.selectAll(".graph-node-text").style(
    "opacity",
    (d) => matches.has(d.id) ? 1.0 : 0.15,
  );
  d3.selectAll(".graph-edge").style("stroke-opacity", (e) => {
    const sourceId = e.source.id || e.source;
    const targetId = e.target.id || e.target;
    return (matches.has(sourceId) && matches.has(targetId)) ? 0.8 : 0.05;
  });
}

// Diagnostics Dash Logic
function runDiagnostics() {
  fetchAndRenderAnalytics();
  const realNodes = nodesList.filter((n) => n.has_file);
  const placeholders = nodesList.filter((n) => !n.has_file);

  // Grouping by namespace
  const namespaceCounts = {};
  realNodes.forEach((node) => {
    const ns = getNamespaceString(node.namespace);
    namespaceCounts[ns] = (namespaceCounts[ns] || 0) + 1;
  });

  // Populate Stats card
  const statsContainer = document.getElementById("diag-stats-content");
  if (statsContainer) {
    statsContainer.innerHTML = `
            <div class="stat-pill">
                <span class="stat-label">Total Notes:</span>
                <span class="stat-val">${realNodes.length}</span>
            </div>
            <div class="stat-pill">
                <span class="stat-label">Broken Links:</span>
                <span class="stat-val">${placeholders.length}</span>
            </div>
        `;
    // Add namespace details
    for (const ns in namespaceCounts) {
      const pill = document.createElement("div");
      pill.className = "stat-pill";
      pill.innerHTML = `
                <span class="stat-label">${ns.toUpperCase()}:</span>
                <span class="stat-val">${namespaceCounts[ns]}</span>
            `;
      statsContainer.appendChild(pill);
    }
  }

  // Identify Orphans, Dead Ends, and Broken Links
  const incomingRefMap = {};
  const outgoingRefMap = {};

  nodesList.forEach((n) => {
    incomingRefMap[n.id] = [];
    outgoingRefMap[n.id] = [];
  });

  graphData.edges.forEach((e) => {
    const sourceId = e.source.id || e.source;
    const targetId = e.target.id || e.target;

    if (!incomingRefMap[targetId]) incomingRefMap[targetId] = [];
    if (!outgoingRefMap[sourceId]) outgoingRefMap[sourceId] = [];

    incomingRefMap[targetId].push(sourceId);
    outgoingRefMap[sourceId].push(targetId);
  });

  // Orphans: real nodes with no incoming links
  const orphans = realNodes.filter((n) =>
    !incomingRefMap[n.id] || incomingRefMap[n.id].length === 0
  );

  // Dead Ends: real nodes with no outgoing links
  const deadEnds = realNodes.filter((n) =>
    !outgoingRefMap[n.id] || outgoingRefMap[n.id].length === 0
  );

  // Broken links: placeholders
  const brokenLinks = placeholders;

  // Render lists
  renderDiagList(
    "diag-broken-links",
    brokenLinks,
    "No broken wiki links detected!",
  );
  renderDiagList("diag-orphans", orphans, "No orphan nodes detected!");
  renderDiagList("diag-dead-ends", deadEnds, "No dead ends detected!");

  // Populate Pathfinder select inputs
  populatePathfinderSelects();
}

function renderDiagList(containerId, list, emptyMsg) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = "";
  if (list.length === 0) {
    el.innerHTML =
      `<div style="color: var(--color-text-muted); font-size: 0.8rem; padding: 12px; font-style: italic;">${emptyMsg}</div>`;
    return;
  }

  list.forEach((node) => {
    const item = document.createElement("div");
    item.className = "diag-list-item";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = node.id;
    item.appendChild(nameSpan);

    const nsSpan = document.createElement("span");
    const nsStr = getNamespaceString(node.namespace);
    nsSpan.className = `badge ns-${nsStr}`;
    nsSpan.textContent = nsStr;
    item.appendChild(nsSpan);

    // Click to view/edit in workspace
    item.addEventListener("click", () => {
      const btnWorkspace = document.getElementById("btn-toggle-workspace");
      if (btnWorkspace) btnWorkspace.click();
      selectNode(node.id);
    });

    el.appendChild(item);
  });
}

function populatePathfinderSelects() {
  const sourceSelect = document.getElementById("path-source");
  const targetSelect = document.getElementById("path-target");
  if (!sourceSelect || !targetSelect) return;

  sourceSelect.innerHTML =
    '<option value="" disabled selected>Select Source...</option>';
  targetSelect.innerHTML =
    '<option value="" disabled selected>Select Target...</option>';

  // Sort existing files alphabetically
  const sorted = [...nodesList].filter((n) => n.has_file).sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  sorted.forEach((node) => {
    const opt1 = document.createElement("option");
    opt1.value = node.id;
    opt1.textContent = node.title ? `${node.id} (${node.title})` : node.id;
    sourceSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = node.id;
    opt2.textContent = node.title ? `${node.id} (${node.title})` : node.id;
    targetSelect.appendChild(opt2);
  });
}

// BFS shortest path implementation
function findPathfinderConnection() {
  const sourceId = document.getElementById("path-source").value;
  const targetId = document.getElementById("path-target").value;
  const resultsContainer = document.getElementById("pathfinder-results");

  if (!sourceId || !targetId) {
    alert("Please select both a source and a target node.");
    return;
  }
  if (sourceId === targetId) {
    resultsContainer.innerHTML =
      '<div style="color: var(--color-primary); padding: 12px; font-weight: 500;">Source and target are the same node!</div>';
    return;
  }

  const adj = {};
  graphData.nodes.forEach((n) => adj[n.id] = []);
  graphData.edges.forEach((e) => {
    const source = e.source.id || e.source;
    const target = e.target.id || e.target;
    if (!adj[source]) adj[source] = [];
    adj[source].push(target);
  });

  const queue = [[sourceId, [sourceId]]];
  const visited = new Set();
  visited.add(sourceId);

  let foundPath = null;

  while (queue.length > 0) {
    const [curr, path] = queue.shift();

    if (curr === targetId) {
      foundPath = path;
      break;
    }

    const neighbors = adj[curr] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }

  resultsContainer.innerHTML = "";

  if (!foundPath) {
    resultsContainer.innerHTML =
      '<div style="color: var(--color-text-muted); font-size: 0.85rem; font-style: italic; text-align: center; margin-top: 40px;">No directed reference connections found between these nodes.</div>';
    return;
  }

  const trace = document.createElement("div");
  trace.className = "path-trace";

  foundPath.forEach((nodeId, idx) => {
    const node = nodesList.find((n) => n.id === nodeId);
    const title = (node && node.title) ? node.title : nodeId;
    const nsStr = node ? getNamespaceString(node.namespace) : "global";

    const step = document.createElement("div");
    step.className = "path-step";
    step.innerHTML = `
            <span class="path-step-num">#${idx + 1}</span>
            <span class="path-step-name">${title}</span>
            <span class="badge ns-${nsStr}" style="margin-left: auto;">${nsStr}</span>
        `;

    step.addEventListener("click", () => {
      const btnWorkspace = document.getElementById("btn-toggle-workspace");
      if (btnWorkspace) btnWorkspace.click();
      selectNode(nodeId);
    });

    trace.appendChild(step);

    if (idx < foundPath.length - 1) {
      const arrow = document.createElement("div");
      arrow.className = "path-arrow";
      arrow.textContent = "↓ References";
      trace.appendChild(arrow);
    }
  });

  resultsContainer.appendChild(trace);
}

// Media Assets management
async function loadVaultAssets() {
  const gallery = document.getElementById("asset-gallery");
  if (!gallery) return;
  gallery.innerHTML =
    '<div style="color: var(--color-text-muted); font-size: 0.75rem; font-style: italic;">Loading gallery...</div>';

  if (!activeVault) return;

  try {
    const resp = await fetch(`/api/vaults/${activeVault}/assets`);
    if (!resp.ok) throw new Error("Failed to load assets");
    const assets = await resp.json();

    gallery.innerHTML = "";
    if (assets.length === 0) {
      gallery.innerHTML =
        '<div style="color: var(--color-text-muted); font-size: 0.75rem; font-style: italic;">No media assets uploaded yet.</div>';
      return;
    }

    assets.forEach((asset) => {
      const wrapper = document.createElement("div");
      wrapper.className = "asset-thumb-wrapper";

      const assetUrl = `/vaults/${activeVault}/assets/${asset}`;
      const ext = asset.split(".").pop().toLowerCase();
      const isImage = ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(
        ext,
      );
      const isAudio = ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext);

      if (isImage) {
        const img = document.createElement("img");
        img.className = "asset-thumb-img";
        img.src = assetUrl;
        img.alt = asset;
        wrapper.appendChild(img);
      } else if (isAudio) {
        const audioFallback = document.createElement("div");
        audioFallback.className = "asset-thumb-audio-fallback";

        const icon = document.createElement("span");
        icon.style.fontSize = "1.5rem";
        icon.textContent = "🎵";
        audioFallback.appendChild(icon);

        const name = document.createElement("div");
        name.className = "asset-thumb-audio-name";
        name.textContent = asset;
        audioFallback.appendChild(name);

        wrapper.appendChild(audioFallback);
      } else {
        const fallback = document.createElement("div");
        fallback.className = "asset-thumb-name-fallback";
        fallback.textContent = asset;
        wrapper.appendChild(fallback);
      }

      const overlay = document.createElement("div");
      overlay.className = "asset-thumb-overlay";

      if (isAudio) {
        const playBtn = document.createElement("button");
        playBtn.className = "asset-btn-play";
        playBtn.textContent = "PLAY";
        playBtn.type = "button";
        playBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          playAmbientAudio(assetUrl, asset);
        });
        overlay.appendChild(playBtn);

        const insertBtn = document.createElement("button");
        insertBtn.className = "asset-btn-insert";
        insertBtn.textContent = "INSERT";
        insertBtn.type = "button";
        insertBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          insertAudioHtml(asset);
        });
        overlay.appendChild(insertBtn);
      } else {
        const btn = document.createElement("button");
        btn.className = "asset-btn-insert";
        btn.textContent = "INSERT";
        btn.type = "button";

        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          insertImageMarkdown(asset);
        });
        overlay.appendChild(btn);
      }

      wrapper.appendChild(overlay);

      wrapper.addEventListener("click", () => {
        if (isAudio) {
          playAmbientAudio(assetUrl, asset);
        } else {
          insertImageMarkdown(asset);
        }
      });

      gallery.appendChild(wrapper);
    });
  } catch (err) {
    console.error(err);
    gallery.innerHTML =
      '<div style="color: var(--color-text-muted); font-size: 0.75rem; font-style: italic;">Error loading gallery.</div>';
  }
}

function insertImageMarkdown(filename) {
  const md = `![${filename}](assets/${filename})`;
  const text = editContent.value;
  const start = editContent.selectionStart;
  const end = editContent.selectionEnd;

  editContent.value = text.substring(0, start) + md + text.substring(end);
  editContent.selectionStart = editContent.selectionEnd = start + md.length;
  editContent.focus();

  const event = new Event("input", { bubbles: true });
  editContent.dispatchEvent(event);
  syncEditorScroll();
}

async function uploadAssetFile(file) {
  if (!activeVault) {
    alert("Please select a vault first.");
    return;
  }

  const gallery = document.getElementById("asset-gallery");
  if (gallery) {
    const loader = document.createElement("div");
    loader.className = "asset-thumb-wrapper";
    loader.innerHTML =
      '<div style="font-size: 0.65rem; color: var(--color-primary); display: flex; align-items: center; justify-content: center; height: 100%;">Uploading...</div>';
    gallery.insertBefore(loader, gallery.firstChild);
  }

  const cleanName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");

  try {
    const resp = await fetch(`/api/vaults/${activeVault}/assets/${cleanName}`, {
      method: "POST",
      body: file,
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(txt);
    }

    const ext = cleanName.split(".").pop().toLowerCase();
    const isAudio = ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext);
    if (isAudio) {
      insertAudioHtml(cleanName);
    } else {
      insertImageMarkdown(cleanName);
    }
    await loadVaultAssets();
  } catch (err) {
    alert(`Failed to upload asset: ${err.message}`);
    loadVaultAssets();
  }
}

function setupAssetManagerDragDrop() {
  const dragZone = document.getElementById("asset-drag-zone");
  const fileInput = document.getElementById("input-upload-file");
  const uploadBtn = document.getElementById("btn-upload-file");

  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) {
        uploadAssetFile(e.target.files[0]);
      }
    });
  }

  if (!dragZone) return;

  const dropTargets = [dragZone, editContent];

  dropTargets.forEach((target) => {
    target.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target === dragZone) dragZone.classList.add("drag-over");
    });

    target.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target === dragZone) dragZone.classList.add("drag-over");
    });

    target.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target === dragZone) dragZone.classList.remove("drag-over");
    });

    target.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target === dragZone) dragZone.classList.remove("drag-over");

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        if (file.type.startsWith("image/") || file.type.startsWith("audio/")) {
          uploadAssetFile(file);
        } else {
          alert("Only image and audio uploads are supported currently.");
        }
      }
    });
  });
}

// === LEFT PANE TAG EXPLORER LOGIC ===
function filterByTag(tag) {
  activeTagFilter = tag;

  document.querySelectorAll(".tag-explorer-item").forEach((item) => {
    if (item.dataset.tag.toLowerCase() === tag.toLowerCase()) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });

  const banner = document.getElementById("tag-filter-indicator");
  const label = document.getElementById("active-tag-filter");

  label.textContent = `#${tag}`;
  banner.style.display = "flex";

  renderExplorerTree();
  updateGraphOpacityForSearch(nodeSearch.value);
}

function clearTagFilter() {
  activeTagFilter = "";

  document.getElementById("tag-filter-indicator").style.display = "none";
  document.querySelectorAll(".tag-explorer-item").forEach((item) => {
    item.classList.remove("active");
  });

  renderExplorerTree();
  updateGraphOpacityForSearch(nodeSearch.value);
}

function renderTagExplorer() {
  const el = document.getElementById("explorer-tags");
  if (!el) return;
  el.innerHTML = "";

  const counts = {};

  nodesList
    .flatMap((node) => node.tags.map((tag) => tag.trim()).filter((tag) => tag))
    .forEach((tag) => {
      counts[tag] = (counts[tag] || 0) + 1;
    });

  const sortedTags = Object.keys(counts).sort((a, b) => a.localeCompare(b));

  if (sortedTags.length === 0) {
    el.innerHTML =
      '<div class="empty-state">No tags found in vault nodes.</div>';
    return;
  }

  sortedTags.forEach((tag) => {
    const item = document.createElement("div");
    item.className = `tag-explorer-item ${
      activeTagFilter.toLowerCase() === tag.toLowerCase() ? "active" : ""
    }`;
    item.dataset.tag = tag;

    const label = document.createElement("span");
    label.textContent = `#${tag}`;
    item.appendChild(label);

    const badge = document.createElement("span");
    badge.className = "tag-explorer-item-count";
    badge.textContent = counts[tag];
    item.appendChild(badge);

    item.addEventListener("click", () => {
      if (activeTagFilter.toLowerCase() === tag.toLowerCase()) {
        clearTagFilter();
      } else {
        filterByTag(tag);
      }
    });

    el.appendChild(item);
  });
}

async function openStoryArcReader(nodeId) {
  const readerModal = document.getElementById("reader-modal");
  const readerContent = document.getElementById("reader-story-arc-content");
  const readerTitle = document.getElementById("reader-story-title");

  if (!readerModal || !readerContent) return;

  readerTitle.textContent = "STORY_ARC_READER // LOADING...";
  readerContent.innerHTML =
    '<div style="color: var(--color-primary); font-family: var(--font-mono); font-size: 0.9rem; text-align: center; padding: 40px;">COMPILING ARC CHRONOLOGY...</div>';
  readerModal.classList.add("active");

  try {
    const storyMetaList = nodesList.filter((n) =>
      getNamespaceString(n.namespace) === "story" && n.has_file
    );

    const storyNodes = await Promise.all(storyMetaList.map(async (m) => {
      const resp = await fetch(`/api/vaults/${activeVault}/nodes/${m.id}`);
      if (!resp.ok) throw new Error(`Failed to load ${m.id}`);
      return await resp.json();
    }));

    const forward = {};
    const backward = {};
    storyNodes.forEach((sn) => {
      if (sn.metadata && sn.metadata.continuation) {
        forward[sn.id] = sn.metadata.continuation;
        backward[sn.metadata.continuation] = sn.id;
      }
    });

    let rootId = nodeId;
    const visitedBackward = new Set();
    while (backward[rootId] && !visitedBackward.has(rootId)) {
      visitedBackward.add(rootId);
      rootId = backward[rootId];
    }

    const chain = [];
    let curr = rootId;
    const visitedForward = new Set();
    while (curr && !visitedForward.has(curr)) {
      visitedForward.add(curr);
      const fullNode = storyNodes.find((sn) => sn.id === curr);
      if (fullNode) {
        chain.push(fullNode);
      }
      curr = forward[curr];
    }

    if (chain.length === 0) {
      readerContent.innerHTML =
        '<div style="color: var(--color-text-muted); text-align: center; padding: 40px;">Story arc has no readable scenes.</div>';
      return;
    }

    readerTitle.textContent = "STORY_ARC";

    readerContent.innerHTML = "";

    chain.forEach((scene, index) => {
      const block = document.createElement("div");
      block.className = "reader-scene-block";

      const meta = document.createElement("div");
      meta.className = "reader-scene-meta";
      meta.innerHTML = `<span>Scene ${
        index + 1
      } of ${chain.length}</span> &bull; <span>ID: ${scene.id}</span>`;
      block.appendChild(meta);

      const title = document.createElement("h2");
      title.className = "reader-scene-title";
      title.textContent = scene.metadata.title || scene.id;
      block.appendChild(title);

      const body = document.createElement("div");
      body.className = "reader-scene-content markdown-body";
      body.innerHTML = marked.parse(replaceWikiLinks(scene.content, nodesList));

      block.appendChild(body);

      readerContent.appendChild(block);
    });
  } catch (err) {
    console.error(err);
    readerContent.innerHTML =
      `<div style="color: var(--color-danger); text-align: center; padding: 40px;">Failed to trace story arc: ${err.message}</div>`;
  }
}

function closeStoryArcReader() {
  const readerModal = document.getElementById("reader-modal");
  readerModal && readerModal.classList.remove("active");
}

async function submitCreateVault() {
  const name = document.getElementById("new-vault-name").value.trim();
  if (!name) {
    alert("Vault name is required.");
    document.getElementById("new-vault-name").focus();
    return;
  }

  if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
    alert(
      "Vault name must only contain letters, numbers, underscores, or dashes.",
    );
    document.getElementById("new-vault-name").focus();
    return;
  }

  try {
    const resp = await fetch("/api/vaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText);
    }

    alert(`Vault '${name}' created successfully!`);
    document.getElementById("vault-modal").classList.remove("active");

    await loadVaults();
    vaultSelect.value = name;
    activeVault = name;
    reloadVault(name);
  } catch (err) {
    alert(`Failed to create vault: ${err.message}`);
  }
}

async function performFullTextSearch(query) {
  try {
    const resp = await fetch(
      `/api/vaults/${activeVault}/search?q=${encodeURIComponent(query)}`,
    );
    if (!resp.ok) throw new Error("Search failed");
    const results = await resp.json();

    renderSearchResults(results);
  } catch (err) {
    console.error("Full text search error:", err);
  }
}

function renderSearchResults(results) {
  explorerTree.innerHTML = "";

  if (results.length === 0) {
    explorerTree.innerHTML =
      '<div class="empty-state">No matches found in content.</div>';
    return;
  }

  const section = document.createElement("div");
  section.className = "tree-section";

  const header = document.createElement("div");
  header.className = "tree-section-header";
  header.textContent = `SEARCH_RESULTS (${results.length})`;
  section.appendChild(header);

  results.forEach((res) => {
    const item = document.createElement("div");
    item.className = `tree-node-item ${
      res.id === activeNodeId ? "active" : ""
    }`;
    item.dataset.id = res.id;

    const label = document.createElement("span");
    label.textContent = res.id;
    item.appendChild(label);

    if (res.title) {
      const sub = document.createElement("span");
      sub.className = "tree-node-title";
      sub.textContent = res.title;
      item.appendChild(sub);
    }

    if (res.snippet) {
      const snip = document.createElement("div");
      snip.className = "search-result-snippet";
      snip.style.fontSize = "0.75rem";
      snip.style.color = "var(--color-text-muted)";
      snip.style.marginTop = "4px";
      snip.style.padding = "4px 8px";
      snip.style.background = "rgba(0, 0, 0, 0.2)";
      snip.style.borderRadius = "4px";
      snip.style.borderLeft = "2px solid var(--color-primary)";
      snip.style.fontFamily = "var(--font-mono)";

      const query = nodeSearch.value.trim();
      if (query) {
        const regex = new RegExp(
          `(${query.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")})`,
          "gi",
        );
        snip.innerHTML = res.snippet.replace(
          regex,
          '<mark style="background: rgba(56, 189, 248, 0.3); color: #fff; border-radius: 2px; padding: 0 2px;">$1</mark>',
        );
      } else {
        snip.textContent = res.snippet;
      }
      item.appendChild(snip);
    }

    item.addEventListener("click", () => selectNode(res.id));
    section.appendChild(item);
  });

  explorerTree.appendChild(section);
}

function renderTimelineView() {
  const container = document.getElementById("timeline-container");
  if (!container) return;

  container.innerHTML =
    '<div style="color: var(--color-primary); font-family: var(--font-mono); font-size: 0.9rem; text-align: center; padding: 40px;">ANALYZING NARRATIVE PROGRESSIONS...</div>';

  try {
    const storyMetaList = nodesList.filter((n) =>
      getNamespaceString(n.namespace) === "story" && n.has_file
    );

    if (storyMetaList.length === 0) {
      container.innerHTML =
        '<div class="timeline-empty" style="color: var(--color-text-muted); font-size: 0.85rem; font-style: italic; text-align: center; margin: auto;">No story nodes found in this vault. Mark nodes under "story" namespace to generate chronology tracks.</div>';
      return;
    }

    const storyNodes = storyMetaList;

    const forward = {};
    const backward = {};

    storyNodes.forEach((node) => {
      if (node.metadata && node.metadata.continuation) {
        const nextId = node.metadata.continuation;
        forward[node.id] = nextId;
        const nextExists = storyNodes.some((n) => n.id === nextId);
        if (nextExists) {
          backward[nextId] = node.id;
        }
      }
    });

    const roots = storyNodes.filter((node) => !backward[node.id]);

    container.innerHTML = "";

    if (roots.length === 0 && storyNodes.length > 0) {
      roots.push(storyNodes[0]);
    }

    roots.sort((a, b) => a.id.localeCompare(b.id));

    roots.forEach((root, trackIdx) => {
      const trackDiv = document.createElement("div");
      trackDiv.className = "timeline-track";
      trackDiv.style.display = "flex";
      trackDiv.style.alignItems = "center";
      trackDiv.style.gap = "24px";
      trackDiv.style.position = "relative";
      trackDiv.style.padding = "20px 0";

      const trackHeader = document.createElement("div");
      trackHeader.className = "timeline-track-header";
      trackHeader.style.minWidth = "120px";
      trackHeader.style.fontWeight = "bold";
      trackHeader.style.fontSize = "0.8rem";
      trackHeader.style.color = "var(--color-primary)";
      trackHeader.style.borderLeft = "3px solid var(--ns-story)";
      trackHeader.style.paddingLeft = "10px";
      trackHeader.textContent = `TRACK #${trackIdx + 1}`;
      trackDiv.appendChild(trackHeader);

      const chain = [];
      let curr = root.id;
      const visited = new Set();

      while (curr && !visited.has(curr)) {
        visited.add(curr);
        const node = storyNodes.find((n) => n.id === curr);
        if (node) {
          chain.push(node);
        }
        curr = forward[curr];
      }

      chain.forEach((scene, index) => {
        const card = document.createElement("div");
        card.className = "timeline-card";
        card.style.background = "rgba(30, 30, 40, 0.6)";
        card.style.border = "1px solid var(--border-color)";
        card.style.borderRadius = "8px";
        card.style.padding = "16px";
        card.style.width = "220px";
        card.style.minWidth = "220px";
        card.style.cursor = "pointer";
        card.style.transition = "all var(--transition-normal)";
        card.style.position = "relative";

        const dot = document.createElement("span");
        dot.className = "timeline-card-dot";
        dot.style.position = "absolute";
        dot.style.top = "12px";
        dot.style.right = "12px";
        dot.style.width = "8px";
        dot.style.height = "8px";
        dot.style.borderRadius = "50%";
        dot.style.background = "var(--ns-story)";
        dot.style.boxShadow = "0 0 6px var(--ns-story)";
        card.appendChild(dot);

        const num = document.createElement("div");
        num.style.fontSize = "0.7rem";
        num.style.color = "var(--color-primary)";
        num.style.fontFamily = "var(--font-mono)";
        num.style.marginBottom = "4px";
        num.textContent = `SCENE #${index + 1}`;
        card.appendChild(num);

        const title = document.createElement("h3");
        title.style.fontSize = "0.85rem";
        title.style.fontWeight = "600";
        title.style.color = "var(--color-text)";
        title.style.whiteSpace = "nowrap";
        title.style.overflow = "hidden";
        title.style.textOverflow = "ellipsis";
        title.textContent = scene.title || scene.id;
        card.appendChild(title);

        const idBadge = document.createElement("div");
        idBadge.style.fontSize = "0.7rem";
        idBadge.style.color = "var(--color-text-muted)";
        idBadge.style.fontFamily = "var(--font-mono)";
        idBadge.style.marginTop = "2px";
        idBadge.textContent = scene.id;
        card.appendChild(idBadge);

        if (scene.tags && scene.tags.length > 0) {
          const tagContainer = document.createElement("div");
          tagContainer.style.display = "flex";
          tagContainer.style.flexWrap = "wrap";
          tagContainer.style.gap = "4px";
          tagContainer.style.marginTop = "8px";

          scene.tags.slice(0, 3).forEach((t) => {
            const tag = document.createElement("span");
            tag.style.fontSize = "0.6rem";
            tag.style.padding = "2px 6px";
            tag.style.borderRadius = "4px";
            tag.style.background = "rgba(255,255,255,0.05)";
            tag.style.color = "var(--color-text-muted)";
            tag.textContent = t;
            tagContainer.appendChild(tag);
          });
          card.appendChild(tagContainer);
        }

        card.addEventListener("mouseenter", () => {
          card.style.borderColor = "var(--ns-story)";
          card.style.boxShadow = "0 0 12px rgba(208, 0, 255, 0.2)";
          card.style.background = "rgba(40, 40, 52, 0.8)";
        });
        card.addEventListener("mouseleave", () => {
          card.style.borderColor = "var(--border-color)";
          card.style.boxShadow = "none";
          card.style.background = "rgba(30, 30, 40, 0.6)";
        });

        card.addEventListener("click", () => {
          document.getElementById("btn-toggle-workspace").click();
          selectNode(scene.id);
        });

        trackDiv.appendChild(card);

        if (index < chain.length - 1) {
          const arrow = document.createElement("div");
          arrow.className = "timeline-connector";
          arrow.style.color = "var(--color-text-muted)";
          arrow.style.fontSize = "1.2rem";
          arrow.innerHTML = "&rarr;";
          trackDiv.appendChild(arrow);
        }
      });

      container.appendChild(trackDiv);
    });
  } catch (err) {
    console.error("Timeline render error:", err);
    container.innerHTML =
      `<div style="color: var(--color-danger); text-align: center; padding: 40px;">Timeline Compilation Failed: ${err.message}</div>`;
  }
}

let cmActiveInstance = null;
let cmTriggerLine = -1;

function showAutocompleteSuggestionsCM(triggerIndex, line, cm) {
  autocompleteActive = true;
  autocompleteTriggerIndex = triggerIndex;
  cmTriggerLine = line;
  cmActiveInstance = cm;

  const q = query.toLowerCase();
  autocompleteMatches = nodesList.filter((node) =>
    node.id.toLowerCase().includes(q)
  );

  const popup = document.getElementById("autocomplete-suggestions");
  if (!popup) return;

  if (autocompleteMatches.length === 0) {
    hideAutocompleteSuggestions();
    return;
  }

  popup.innerHTML = "";
  autocompleteSelectedIndex = Math.min(
    autocompleteSelectedIndex,
    autocompleteMatches.length - 1,
  );
  if (autocompleteSelectedIndex < 0) autocompleteSelectedIndex = 0;

  autocompleteMatches.forEach((match, idx) => {
    const div = document.createElement("div");
    div.className = `autocomplete-item ${
      idx === autocompleteSelectedIndex ? "selected" : ""
    }`;

    const idSpan = document.createElement("span");
    idSpan.textContent = match.id;
    div.appendChild(idSpan);

    const nsSpan = document.createElement("span");
    nsSpan.className = "autocomplete-item-ns";
    nsSpan.textContent = match.namespace;
    div.appendChild(nsSpan);

    div.addEventListener("click", (e) => {
      e.stopPropagation();
      selectAutocompleteSuggestionCM(match.id);
    });

    popup.appendChild(div);
  });

  const coords = cm.cursorCoords(true, "window");
  popup.style.position = "fixed";
  popup.style.top = `${coords.bottom + 5}px`;
  popup.style.left = `${coords.left}px`;
  popup.style.zIndex = "10000";
  popup.style.display = "block";
}

function selectAutocompleteSuggestionCM(nodeId) {
  if (!cmActiveInstance) return;

  const cm = cmActiveInstance;
  const cursor = cm.getCursor();

  const from = { line: cmTriggerLine, ch: autocompleteTriggerIndex };
  const to = { line: cmTriggerLine, ch: cursor.ch };

  cm.replaceRange(nodeId + "]]", from, to);
  hideAutocompleteSuggestions();
  cm.focus();
}

function handleAutocompleteKeydownCM(cm, e) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();

    const moveVal = e.key === "ArrowDown" ? 1 : -1;

    autocompleteSelectedIndex = (autocompleteSelectedIndex + moveVal) %
      autocompleteMatches.length;

    showAutocompleteSuggestionsCM(
      autocompleteTriggerIndex,
      cmTriggerLine,
      cm,
    );

    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    if (autocompleteMatches.length > 0) {
      selectAutocompleteSuggestionCM(
        autocompleteMatches[autocompleteSelectedIndex].id,
      );
    }

    return;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    hideAutocompleteSuggestions();
  }
}

async function insertWikiLinkToEditor(sourceId, targetId) {
  if (activeNodeId !== sourceId) {
    await selectNode(sourceId);
  }

  switchTab("editor");

  const label = prompt(
    `Enter visual text label for the link to '${targetId}' (leave empty for standard [[${targetId}]]):`,
  )?.trim() ?? "";

  const linkStr = label.length
    ? `((${label}))[[${targetId}]]`
    : `[[${targetId}]]`;

  replaceSelected(linkStr);
}

function insertAudioHtml(filename) {
  replaceSelected(`<audio controls src="assets/${filename}"></audio>`);
}

function replaceSelected(str) {
  if (easyMDE) {
    const cm = easyMDE.codemirror;
    cm.replaceSelection(linkStr);
    cm.focus();

    return;
  }

  const start = editContent.selectionStart;
  const end = editContent.selectionEnd;
  const val = editContent.value;
  editContent.value = val.substring(0, start) + str + val.substring(end);
  editContent.selectionStart = editContent.selectionEnd = start +
    str.length;
  editContent.focus();
}

function playAmbientAudio(url, filename) {
  const player = document.getElementById("global-audio-player");
  player.src = url;
  player.play();

  document.getElementById("audio-title").textContent = filename;
  document.getElementById("audio-dock").style.display = "flex";
}

async function promptAndAddMapPin(node, x, y) {
  const targetNodeId = prompt(ENTER_NODE_ID_MSG);

  if (!targetNodeId) return;

  const targetExists = nodesList.some((n) => n.id === targetNodeId);
  if (!targetExists) {
    if (
      !confirm(`Node '${targetNodeId}' does not exist yet. Link to it anyway?`)
    ) {
      return;
    }
  }

  const label = prompt(
    "Enter a label for this map pin (optional):",
    targetNodeId,
  );

  if (!node.metadata.pins) node.metadata.pins = [];

  node.metadata.pins.push({
    x: parseFloat(x),
    y: parseFloat(y),
    node: targetNodeId,
    label: label || targetNodeId,
  });

  await fetch(`/api/vaults/${activeVault}/nodes/${node.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      namespace: getNamespaceString(node.namespace),
      metadata: node.metadata,
      content: node.content,
    }),
  })
    .then(() => Promise.all([reloadVault(), selectNode(node.id)]))
    .catch(
      (err) => alert(`Failed to add pin: ${err.message}`),
    );
}

async function fetchAndRenderAnalytics() {
  if (!activeVault) return;

  try {
    const resp = await fetch(`/api/vaults/${activeVault}/analytics`);
    if (!resp.ok) return;
    const data = await resp.json();

    readOnlyActive = !!data.read_only;

    if (readOnlyActive) {
      document.getElementById("readonly-banner").style.display = "block";
      document.body.classList.add("readonly-active");
    }

    const modifierButtons = [
      "btn-save",
      "btn-delete",
      "btn-rename-node",
      "btn-new-node",
      "btn-add-inbox",
      "btn-upload-file",
      "btn-clean-assets",
    ];

    for (const id of modifierButtons) {
      const tempElt = document.getElementById(id);
      if (tempElt) tempElt.disabled = readOnlyActive;
    }

    document.getElementById("diag-narrative-status").innerHTML = "";

    const storyDiv = document.createElement("div");
    if (data.is_story_cyclic) {
      storyDiv.innerHTML =
        `<span style="color: var(--color-danger); font-weight: bold;">⚠️ Narrative Loop Detected!</span><div class="cyclic-warning">Continuations form a cyclic circle.</div>`;
    } else {
      storyDiv.innerHTML =
        `<span style="color: var(--ns-story); font-weight: bold;">Ref: Story Continuity Solid</span><div class="cyclic-warning">No narrative path cycles found.</div>`;
    }

    statusContainer.appendChild(storyDiv);

    if (data.unreachable_stories && data.unreachable_stories.length > 0) {
      const unreachableDiv = document.createElement("div");
      unreachableDiv.innerHTML =
        `<span style="color: #f59e0b; font-weight: 600; margin-top: 4px; display: block;">⚠️ Isolated Story Segments:</span>
          <div style="font-size: 0.75rem; color: var(--color-text-muted); margin-top: 2px; max-height: 60px; overflow-y: auto;">
            ${data.unreachable_stories.join(", ")}
          </div>`;
      statusContainer.appendChild(unreachableDiv);
    }

    if (data.top_hubs && data.top_hubs.length > 0) {
      const hubsDiv = document.createElement("div");
      hubsDiv.innerHTML =
        `<span style="color: var(--color-primary); font-weight: bold; margin-top: 4px; display: block;">Top Central Hubs:</span>`;

      const ul = document.createElement("ul");
      ul.style.margin = "4px 0 0 12px";
      ul.style.padding = "0";
      ul.style.fontSize = "0.75rem";

      data.top_hubs.forEach((h) => {
        const li = document.createElement("li");
        li.style.color = "var(--color-text-muted)";
        li.innerHTML =
          `<a onclick="selectNode('${h.id}')" style="cursor: pointer; color: var(--color-text); text-decoration: underline;">${h.id}</a> (${h.degree} links)`;
        ul.appendChild(li);
      });
      hubsDiv.appendChild(ul);
      statusContainer.appendChild(hubsDiv);
    }
  } catch (err) {
    console.error("Failed to load vault analytics:", err);
  }
}

async function scanOrphanAssets() {
  if (!activeVault) return;

  const resultsDiv = document.getElementById("assets-diagnostics-results");
  const summarySpan = document.getElementById("assets-diagnostics-summary");
  const cleanBtn = document.getElementById("btn-clean-assets");

  resultsDiv.style.display = "block";
  summarySpan.textContent = "Scanning assets...";
  cleanBtn.style.display = "none";

  await fetch(`/api/vaults/${activeVault}/assets/diagnostics`)
    .then((resp) => resp.json())
    .then((data) => {
      if (!data.orphans?.length) {
        summarySpan.textContent = NO_ORPAHN_ASSETS_MSG;

        return;
      }

      summarySpan.textContent = `Found ${data.orphans.length} unused assets: ${
        data.orphans.join(", ")
      }`;

      if (!readOnlyActive) cleanBtn.style.display = "block";
    });
}

const DELETE_ORPHAN_ASSETS_MSG =
  "Are you sure you want to delete all unused assets? This action is permanent!";
const NO_ORPAHN_ASSETS_MSG =
  "No orphan assets found. All files are referenced.";
const ENTER_NODE_ID_MSG = "Enter Node ID to link this to:";
