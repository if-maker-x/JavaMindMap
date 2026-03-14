const DISPLAY_DEFAULTS = {
  summary: true,
  fields: true,
  constructors: true,
  methods: true,
  extends: true,
  implements: true,
  imports: false,
  dependencies: false,
  relations: true
};

const state = {
  map: null,
  stats: null,
  selectedNodeId: null,
  selectedFiles: [],
  selectedFolderLabel: "",
  display: { ...DISPLAY_DEFAULTS },
  viewport: {
    x: 120,
    y: 80,
    scale: 1
  },
  nodeMetrics: new Map(),
  drag: null,
  pan: null,
  fitAfterMeasure: false
};

const refs = {
  folderPath: document.getElementById("folderPath"),
  folderPicker: document.getElementById("folderPicker"),
  pickFolderBtn: document.getElementById("pickFolderBtn"),
  analyzePathBtn: document.getElementById("analyzePathBtn"),
  analyzePickedBtn: document.getElementById("analyzePickedBtn"),
  loadBtn: document.getElementById("loadBtn"),
  layoutBtn: document.getElementById("layoutBtn"),
  saveBtn: document.getElementById("saveBtn"),
  fitBtn: document.getElementById("fitBtn"),
  status: document.getElementById("status"),
  pickedFolderInfo: document.getElementById("pickedFolderInfo"),
  stats: document.getElementById("stats"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  zoomLabel: document.getElementById("zoomLabel"),
  canvasViewport: document.getElementById("canvasViewport"),
  world: document.getElementById("world"),
  edgesLayer: document.getElementById("edgesLayer"),
  nodesLayer: document.getElementById("nodesLayer"),
  nodeTemplate: document.getElementById("nodeTemplate"),
  nodeTitle: document.getElementById("nodeTitle"),
  nodeNote: document.getElementById("nodeNote"),
  addChildBtn: document.getElementById("addChildBtn"),
  addSiblingBtn: document.getElementById("addSiblingBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  detailsEmpty: document.getElementById("detailsEmpty"),
  detailsContent: document.getElementById("detailsContent"),
  displayInputs: Array.from(document.querySelectorAll("[data-display]"))
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(message, type = "") {
  refs.status.textContent = message;
  refs.status.className = `status ${type}`.trim();
}

function updateStats(stats) {
  state.stats = stats || null;
  const values = stats || {};
  refs.stats.innerHTML = `
    <div><strong>${values.fileCount ?? "-"}</strong><span>文件</span></div>
    <div><strong>${values.classCount ?? "-"}</strong><span>类型</span></div>
    <div><strong>${values.packageCount ?? "-"}</strong><span>包</span></div>
    <div><strong>${values.relationCount ?? "-"}</strong><span>关系</span></div>
  `;
}

function inferStatsFromMap(map) {
  if (!map) {
    return null;
  }
  return {
    fileCount: "-",
    classCount: map.nodes.filter((node) => node.type === "class").length,
    packageCount: map.nodes.filter((node) => node.type === "package").length,
    relationCount: Array.isArray(map.relations) ? map.relations.length : "-"
  };
}

function normalizeMap(rawMap) {
  const nodes = rawMap.nodes.map((node) => ({
    note: "",
    meta: {},
    x: typeof node.x === "number" ? node.x : 0,
    y: typeof node.y === "number" ? node.y : 0,
    ...node
  }));
  return {
    ...rawMap,
    nodes,
    relations: Array.isArray(rawMap.relations) ? rawMap.relations : []
  };
}

function getNode(nodeId) {
  return state.map?.nodes.find((node) => node.id === nodeId) || null;
}

function getChildren(parentId) {
  return state.map ? state.map.nodes.filter((node) => node.parentId === parentId) : [];
}

function sanitizeFolderPath(value) {
  return String(value || "")
    .trim()
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .trim();
}

function syncDisplayControls() {
  refs.displayInputs.forEach((input) => {
    input.checked = Boolean(state.display[input.dataset.display]);
  });
}

function collectDisplayFromControls() {
  const next = { ...DISPLAY_DEFAULTS };
  refs.displayInputs.forEach((input) => {
    next[input.dataset.display] = input.checked;
  });
  state.display = next;
}

function isNodeVisible(node) {
  if (node.type === "summary") {
    return Boolean(state.display.summary);
  }
  return true;
}

function getVisibleNodes() {
  return state.map ? state.map.nodes.filter(isNodeVisible) : [];
}

function getNodeMetric(node) {
  return state.nodeMetrics.get(node.id) || {
    width: node.type === "summary" ? 330 : node.type === "root" ? 320 : 310,
    height: estimateNodeHeight(node)
  };
}

function estimateNodeHeight(node) {
  if (!node) {
    return 120;
  }

  if (node.type === "root") {
    return 150;
  }

  if (node.type === "summary") {
    const lineCount = (node.meta?.summaryLines || []).length || 4;
    return 130 + lineCount * 24;
  }

  if (node.type === "package") {
    return 120;
  }

  if (node.type !== "class") {
    return 140;
  }

  const meta = node.meta || {};
  let height = 150;
  if (state.display.extends && meta.extendsName) {
    height += 40;
  }
  if (state.display.implements && meta.implementsNames?.length) {
    height += 40;
  }
  if (state.display.fields && meta.fields?.length) {
    height += 34 + meta.fields.length * 20;
  }
  if (state.display.constructors && meta.constructors?.length) {
    height += 34 + meta.constructors.length * 20;
  }
  if (state.display.methods && meta.methods?.length) {
    height += 34 + meta.methods.length * 20;
  }
  if (state.display.imports && meta.imports?.length) {
    height += 34 + Math.min(meta.imports.length, 10) * 18;
  }
  if (state.display.dependencies && meta.internalDeps?.length) {
    height += 34 + Math.min(meta.internalDeps.length, 10) * 18;
  }
  return height;
}

function layoutMap() {
  if (!state.map) {
    return;
  }

  const root = getNode(state.map.rootId);
  if (!root) {
    return;
  }

  const summaryNode = getChildren(root.id).find((node) => node.type === "summary");
  const packageNodes = getChildren(root.id).filter((node) => node.type === "package");
  const packageColumns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(packageNodes.length || 1))));
  const columnWidth = 380;
  const columnGap = 42;
  const packageStartY = 250;
  const totalWidth = packageColumns * columnWidth + (packageColumns - 1) * columnGap;

  root.x = Math.max(0, totalWidth / 2 - 160);
  root.y = 0;

  if (summaryNode) {
    summaryNode.x = root.x + 360;
    summaryNode.y = 10;
  }

  const columnHeights = Array.from({ length: packageColumns }, () => 0);
  const orderedPackages = [...packageNodes].sort((left, right) =>
    left.title.localeCompare(right.title)
  );

  for (const packageNode of orderedPackages) {
    const classNodes = getChildren(packageNode.id).filter((node) => node.type === "class");
    const customChildren = getChildren(packageNode.id).filter((node) => node.type !== "class");
    const estimatedPackageHeight =
      92 +
      classNodes.reduce((sum, classNode) => sum + estimateNodeHeight(classNode) + 18, 0) +
      customChildren.reduce((sum, customNode) => sum + estimateNodeHeight(customNode) + 18, 0) +
      18;

    let targetColumn = 0;
    for (let index = 1; index < columnHeights.length; index += 1) {
      if (columnHeights[index] < columnHeights[targetColumn]) {
        targetColumn = index;
      }
    }

    const columnX = targetColumn * (columnWidth + columnGap);
    packageNode.x = columnX;
    packageNode.y = packageStartY + columnHeights[targetColumn];

    let cursorY = packageNode.y + estimateNodeHeight(packageNode) + 18;
    classNodes.forEach((classNode) => {
      classNode.x = columnX + 22;
      classNode.y = cursorY;
      cursorY += estimateNodeHeight(classNode) + 18;
    });

    customChildren.forEach((customNode) => {
      customNode.x = columnX + 22;
      customNode.y = cursorY;
      cursorY += estimateNodeHeight(customNode) + 18;
    });

    columnHeights[targetColumn] += estimatedPackageHeight + 34;
  }

  getChildren(root.id)
    .filter((node) => node.type === "custom")
    .forEach((customNode, index) => {
      customNode.x = totalWidth + 120;
      customNode.y = packageStartY + index * 180;
    });

  state.map.nodes
    .filter((node) => node.type === "class" || node.type === "custom")
    .forEach((node) => {
      const customChildren = getChildren(node.id).filter((child) => child.type === "custom");
      let cursorY = node.y;
      customChildren.forEach((child) => {
        child.x = node.x + 360;
        child.y = cursorY;
        cursorY += estimateNodeHeight(child) + 18;
      });
    });
}

function applyWorldTransform() {
  refs.world.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.scale})`;
  refs.zoomLabel.textContent = `${Math.round(state.viewport.scale * 100)}%`;
}

function getViewportPoint(clientX, clientY) {
  const rect = refs.canvasViewport.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

function screenToWorld(clientX, clientY) {
  const point = getViewportPoint(clientX, clientY);
  return {
    x: (point.x - state.viewport.x) / state.viewport.scale,
    y: (point.y - state.viewport.y) / state.viewport.scale
  };
}

function fitView() {
  if (!state.map) {
    return;
  }

  const visibleNodes = getVisibleNodes();
  if (!visibleNodes.length) {
    return;
  }

  const bounds = visibleNodes.reduce(
    (acc, node) => {
      const metric = getNodeMetric(node);
      acc.minX = Math.min(acc.minX, node.x);
      acc.minY = Math.min(acc.minY, node.y);
      acc.maxX = Math.max(acc.maxX, node.x + metric.width);
      acc.maxY = Math.max(acc.maxY, node.y + metric.height);
      return acc;
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const viewportWidth = refs.canvasViewport.clientWidth;
  const viewportHeight = refs.canvasViewport.clientHeight;
  const padding = 90;
  const scale = Math.min(
    1.2,
    Math.max(0.28, Math.min((viewportWidth - padding) / width, (viewportHeight - padding) / height))
  );

  state.viewport.scale = scale;
  state.viewport.x = (viewportWidth - width * scale) / 2 - bounds.minX * scale;
  state.viewport.y = (viewportHeight - height * scale) / 2 - bounds.minY * scale;
  applyWorldTransform();
}

function renderBadges(items) {
  if (!items.length) {
    return "";
  }
  return items.map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join("");
}

function renderSection(title, rows) {
  if (!rows.length) {
    return "";
  }
  return `
    <section class="node-section">
      <h4>${escapeHtml(title)}</h4>
      <div class="node-list">
        ${rows.map((row) => `<div>${escapeHtml(row)}</div>`).join("")}
      </div>
    </section>
  `;
}

function buildNodeContent(node) {
  if (node.type === "root") {
    return {
      subtitle: node.note || "",
      badges: [],
      body: renderSection("用途", ["架构总览", "实时修改", "保存迭代思路"])
    };
  }

  if (node.type === "summary") {
    return {
      subtitle: "项目全局摘要",
      badges: [],
      body: renderSection("摘要", node.meta?.summaryLines || node.note.split("\n").filter(Boolean))
    };
  }

  if (node.type === "package") {
    return {
      subtitle: node.note || "",
      badges: [`${node.meta?.classCount ?? 0} 个类型`],
      body: renderSection(
        "说明",
        [`该 package 下的类会集中放在这一列，适合做模块级规划与分工。`]
      )
    };
  }

  if (node.type === "class") {
    const meta = node.meta || {};
    const sections = [];

    if (state.display.extends && meta.extendsName) {
      sections.push(renderSection("继承", [meta.extendsName]));
    }

    if (state.display.implements && meta.implementsNames?.length) {
      sections.push(renderSection("实现", meta.implementsNames));
    }

    if (state.display.fields && meta.fields?.length) {
      sections.push(
        renderSection(
          "字段",
          meta.fields.map((field) => `${field.type} ${field.name}`)
        )
      );
    }

    if (state.display.constructors && meta.constructors?.length) {
      sections.push(
        renderSection(
          "构造器",
          meta.constructors.map((item) => item.signature)
        )
      );
    }

    if (state.display.methods && meta.methods?.length) {
      sections.push(renderSection("方法", meta.methods.map((item) => item.signature)));
    }

    if (state.display.imports && meta.imports?.length) {
      sections.push(renderSection("Imports", meta.imports));
    }

    if (state.display.dependencies && meta.internalDeps?.length) {
      sections.push(renderSection("项目依赖", meta.internalDeps));
    }

    const badges = [meta.kind || "class"];
    if (meta.modifiers?.length) {
      badges.push(...meta.modifiers.slice(0, 2));
    }
    badges.push(`${meta.fields?.length || 0} 字段`);
    badges.push(`${meta.methods?.length || 0} 方法`);

    return {
      subtitle: `${meta.relativePath || ""}`,
      badges,
      body:
        sections.join("") ||
        renderSection("说明", ["当前类没有抽取到可展示成员，但仍可在右侧查看和补充备注。"])
    };
  }

  return {
    subtitle: node.note || "",
    badges: ["自定义"],
    body: ""
  };
}

function measureNodesAndRenderEdges() {
  const metrics = new Map();
  refs.nodesLayer.querySelectorAll(".map-node").forEach((element) => {
    metrics.set(element.dataset.id, {
      width: element.offsetWidth,
      height: element.offsetHeight
    });
  });
  state.nodeMetrics = metrics;
  renderEdges();
  if (state.fitAfterMeasure) {
    state.fitAfterMeasure = false;
    fitView();
  }
}

function renderNodes() {
  refs.nodesLayer.innerHTML = "";
  if (!state.map) {
    return;
  }

  getVisibleNodes().forEach((node) => {
    const content = buildNodeContent(node);
    const fragment = refs.nodeTemplate.content.cloneNode(true);
    const nodeEl = fragment.querySelector(".map-node");
    nodeEl.dataset.id = node.id;
    nodeEl.dataset.type = node.type;
    nodeEl.style.left = `${node.x}px`;
    nodeEl.style.top = `${node.y}px`;
    nodeEl.classList.toggle("selected", node.id === state.selectedNodeId);
    nodeEl.querySelector(".node-type").textContent = node.type;
    nodeEl.querySelector(".node-title").textContent = node.title;
    nodeEl.querySelector(".node-subtitle").textContent = content.subtitle || "";
    nodeEl.querySelector(".node-badges").innerHTML = renderBadges(content.badges || []);
    nodeEl.querySelector(".node-body").innerHTML = content.body || "";

    nodeEl.addEventListener("click", (event) => {
      event.stopPropagation();
      selectNode(node.id);
    });

    nodeEl.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      const nextTitle = window.prompt("修改节点标题", node.title);
      if (nextTitle !== null && nextTitle.trim()) {
        node.title = nextTitle.trim();
        renderMap();
        syncEditor();
      }
    });

    nodeEl.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.stopPropagation();
      const worldPoint = screenToWorld(event.clientX, event.clientY);
      state.drag = {
        nodeId: node.id,
        offsetX: worldPoint.x - node.x,
        offsetY: worldPoint.y - node.y
      };
    });

    refs.nodesLayer.appendChild(fragment);
  });

  requestAnimationFrame(measureNodesAndRenderEdges);
}

function getNodeCenter(node) {
  const metric = getNodeMetric(node);
  return {
    x: node.x + metric.width / 2,
    y: node.y + metric.height / 2,
    width: metric.width,
    height: metric.height
  };
}

function renderTreeEdge(parent, child, color = "rgba(31, 41, 55, 0.22)", dashArray = "") {
  const parentBox = getNodeCenter(parent);
  const childBox = getNodeCenter(child);
  const startX = parentBox.x;
  const startY = parent.y + parentBox.height;
  const endX = childBox.x;
  const endY = child.y;
  const controlY = startY + (endY - startY) * 0.45;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    `M ${startX} ${startY} C ${startX} ${controlY}, ${endX} ${controlY}, ${endX} ${endY}`
  );
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", dashArray ? "1.8" : "2.4");
  path.setAttribute("stroke-linecap", "round");
  if (dashArray) {
    path.setAttribute("stroke-dasharray", dashArray);
  }
  refs.edgesLayer.appendChild(path);
}

function renderEdges() {
  refs.edgesLayer.innerHTML = "";
  if (!state.map) {
    return;
  }

  const visibleIds = new Set(getVisibleNodes().map((node) => node.id));
  getVisibleNodes().forEach((node) => {
    if (!node.parentId || !visibleIds.has(node.parentId)) {
      return;
    }
    const parent = getNode(node.parentId);
    if (!parent) {
      return;
    }
    renderTreeEdge(parent, node);
  });

  if (!state.display.relations) {
    return;
  }

  const relationColors = {
    extends: "rgba(191, 91, 53, 0.46)",
    implements: "rgba(45, 111, 105, 0.42)",
    depends: "rgba(141, 106, 37, 0.38)"
  };

  state.map.relations.forEach((relation) => {
    if (!relation.targetId || !visibleIds.has(relation.sourceId) || !visibleIds.has(relation.targetId)) {
      return;
    }

    const source = getNode(relation.sourceId);
    const target = getNode(relation.targetId);
    if (!source || !target) {
      return;
    }
    renderTreeEdge(source, target, relationColors[relation.type] || "rgba(31, 41, 55, 0.2)", "6 6");
  });
}

function renderDetails() {
  const node = getNode(state.selectedNodeId);
  if (!node) {
    refs.detailsEmpty.style.display = "block";
    refs.detailsContent.classList.remove("active");
    refs.detailsContent.innerHTML = "";
    return;
  }

  refs.detailsEmpty.style.display = "none";
  refs.detailsContent.classList.add("active");

  if (node.type !== "class") {
    refs.detailsContent.innerHTML = `
      <section class="detail-header">
        <h3>${escapeHtml(node.title)}</h3>
        <p>${escapeHtml(node.note || "当前节点暂无详细说明。")}</p>
      </section>
      <section class="detail-group">
        <h4>节点类型</h4>
        <div class="detail-badges">${renderBadges([node.type])}</div>
      </section>
    `;
    return;
  }

  const meta = node.meta || {};
  const relationText = [];
  if (meta.extendsName) {
    relationText.push(`继承 ${meta.extendsName}`);
  }
  if (meta.implementsNames?.length) {
    relationText.push(`实现 ${meta.implementsNames.join("、")}`);
  }

  refs.detailsContent.innerHTML = `
    <section class="detail-header">
      <h3>${escapeHtml(node.title)}</h3>
      <p>${escapeHtml(meta.kind || "class")} · ${escapeHtml(meta.relativePath || "")}</p>
    </section>
    <section class="detail-group">
      <h4>基本信息</h4>
      <div class="detail-badges">
        ${renderBadges([
          meta.kind || "class",
          ...(meta.modifiers || []),
          `${meta.fields?.length || 0} 字段`,
          `${meta.constructors?.length || 0} 构造器`,
          `${meta.methods?.length || 0} 方法`
        ])}
      </div>
      <div class="detail-list">
        <div>Package：${escapeHtml(meta.packageName || "")}</div>
        <div>文件：${escapeHtml(meta.relativePath || "")}</div>
        ${
          relationText.length
            ? relationText.map((line) => `<div>${escapeHtml(line)}</div>`).join("")
            : "<div>未识别到显式继承或实现关系</div>"
        }
      </div>
    </section>
    ${renderDetailGroup("字段", meta.fields?.map((field) => `${field.type} ${field.name}`) || [])}
    ${renderDetailGroup(
      "构造器",
      meta.constructors?.map((item) => item.signature) || []
    )}
    ${renderDetailGroup("方法", meta.methods?.map((item) => item.signature) || [])}
    ${renderDetailGroup("Imports", meta.imports || [])}
    ${renderDetailGroup("项目依赖", meta.internalDeps || [])}
  `;
}

function renderDetailGroup(title, rows) {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!safeRows.length) {
    return `
      <section class="detail-group">
        <h4>${escapeHtml(title)}</h4>
        <div class="detail-list"><div>无</div></div>
      </section>
    `;
  }
  return `
    <section class="detail-group">
      <h4>${escapeHtml(title)}</h4>
      <div class="detail-list">
        ${safeRows.map((row) => `<div>${escapeHtml(row)}</div>`).join("")}
      </div>
    </section>
  `;
}

function renderMap() {
  applyWorldTransform();
  renderNodes();
  renderDetails();
}

function syncEditor() {
  const node = getNode(state.selectedNodeId);
  refs.nodeTitle.disabled = !node;
  refs.nodeNote.disabled = !node;
  refs.addChildBtn.disabled = !node;
  refs.addSiblingBtn.disabled = !node || !node.parentId;
  refs.deleteBtn.disabled = !node || node.id === state.map?.rootId;
  refs.nodeTitle.value = node ? node.title : "";
  refs.nodeNote.value = node ? node.note || "" : "";
}

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  syncEditor();
  renderMap();
}

function createNodeId() {
  return `custom_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function addNode(parentId) {
  const parent = getNode(parentId);
  if (!parent || !state.map) {
    return;
  }
  const newNode = {
    id: createNodeId(),
    parentId,
    type: "custom",
    title: "新模块",
    note: "在这里记录你要补充的设计思路、重构计划或架构拆分任务。",
    meta: {},
    x: parent.x + 360,
    y: parent.y + 60
  };
  state.map.nodes.push(newNode);
  selectNode(newNode.id);
}

function deleteNode(nodeId) {
  if (!state.map) {
    return;
  }
  const idsToDelete = new Set();
  function collect(currentId) {
    idsToDelete.add(currentId);
    getChildren(currentId).forEach((child) => collect(child.id));
  }
  collect(nodeId);
  state.map.nodes = state.map.nodes.filter((node) => !idsToDelete.has(node.id));
  state.map.relations = state.map.relations.filter(
    (relation) => !idsToDelete.has(relation.sourceId) && !idsToDelete.has(relation.targetId)
  );
  state.selectedNodeId = state.map.rootId;
  syncEditor();
  renderMap();
}

async function analyzeByPath() {
  const folderPath = sanitizeFolderPath(refs.folderPath.value);
  if (!folderPath) {
    setStatus("请先输入一个有效的 Java 文件夹路径", "error");
    return;
  }

  setStatus("正在从路径读取 Java 目录...", "");
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ folderPath })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "分析失败");
    }
    applyAnalysisResult(result, `${folderPath}`);
    setStatus(`分析完成：识别 ${result.stats.classCount} 个类型`, "success");
  } catch (error) {
    setStatus(error.message || "分析失败", "error");
  }
}

async function analyzePickedFolder() {
  if (!state.selectedFiles.length) {
    setStatus("请先手动选择一个文件夹", "error");
    return;
  }

  setStatus(`正在读取已选文件夹中的 ${state.selectedFiles.length} 个 Java 文件...`, "");

  try {
    const files = await Promise.all(
      state.selectedFiles.map(async (file) => ({
        relativePath: file.webkitRelativePath || file.name,
        content: await file.text()
      }))
    );
    const response = await fetch("/api/analyze-files", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        folderLabel: state.selectedFolderLabel || "Selected Folder",
        files
      })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "分析失败");
    }
    applyAnalysisResult(result, state.selectedFolderLabel || "Selected Folder");
    setStatus(`分析完成：识别 ${result.stats.classCount} 个类型`, "success");
  } catch (error) {
    setStatus(error.message || "分析失败", "error");
  }
}

function applyAnalysisResult(result, sourceLabel) {
  state.map = normalizeMap(result.map);
  updateStats(result.stats);
  layoutMap();
  state.fitAfterMeasure = true;
  renderMap();
  selectNode(state.map.rootId);
  if (sourceLabel) {
    refs.folderPath.value = sourceLabel;
  }
}

async function saveMap() {
  if (!state.map) {
    setStatus("当前还没有可保存的图谱", "error");
    return;
  }

  setStatus("正在保存图谱...", "");
  try {
    const response = await fetch("/api/maps/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        map: state.map,
        stats: state.stats,
        display: state.display,
        viewport: state.viewport
      })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "保存失败");
    }
    setStatus(`保存成功：${new Date(result.savedAt).toLocaleString()}`, "success");
  } catch (error) {
    setStatus(error.message || "保存失败", "error");
  }
}

async function loadLatestMap() {
  setStatus("正在加载上次保存的图谱...", "");
  try {
    const response = await fetch("/api/maps/latest");
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "加载失败");
    }
    state.map = normalizeMap(result.map);
    state.display = { ...DISPLAY_DEFAULTS, ...(result.display || {}) };
    syncDisplayControls();
    updateStats(result.stats || inferStatsFromMap(state.map));
    state.viewport = result.viewport || { x: 120, y: 80, scale: 1 };
    renderMap();
    selectNode(state.map.rootId);
    if (!result.viewport) {
      state.fitAfterMeasure = true;
      renderMap();
    }
    setStatus(`已加载保存图谱（${new Date(result.savedAt).toLocaleString()}）`, "success");
  } catch (error) {
    setStatus(error.message || "加载失败", "error");
  }
}

function setPickedFolder(files) {
  state.selectedFiles = files.filter((file) => file.name.endsWith(".java"));
  const firstPath = state.selectedFiles[0]?.webkitRelativePath || "";
  state.selectedFolderLabel = firstPath ? firstPath.split("/")[0] : "";
  refs.pickedFolderInfo.textContent = state.selectedFiles.length
    ? `已选择 ${state.selectedFolderLabel || "文件夹"}，其中 ${state.selectedFiles.length} 个 Java 文件会被分析`
    : "当前未选择可分析的 Java 文件";
}

function updateZoom(delta, anchorClientPoint = null) {
  const nextScale = Math.min(1.8, Math.max(0.25, state.viewport.scale + delta));
  const anchor =
    anchorClientPoint ||
    (() => {
      const rect = refs.canvasViewport.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })();
  const before = screenToWorld(anchor.x, anchor.y);
  state.viewport.scale = nextScale;
  const viewportPoint = getViewportPoint(anchor.x, anchor.y);
  state.viewport.x = viewportPoint.x - before.x * state.viewport.scale;
  state.viewport.y = viewportPoint.y - before.y * state.viewport.scale;
  applyWorldTransform();
}

refs.analyzePathBtn.addEventListener("click", analyzeByPath);
refs.analyzePickedBtn.addEventListener("click", analyzePickedFolder);
refs.loadBtn.addEventListener("click", loadLatestMap);
refs.saveBtn.addEventListener("click", saveMap);
refs.fitBtn.addEventListener("click", () => fitView());
refs.layoutBtn.addEventListener("click", () => {
  if (!state.map) {
    setStatus("还没有可排版的图谱", "error");
    return;
  }
  layoutMap();
  state.fitAfterMeasure = true;
  renderMap();
  setStatus("已重新排版并适应视图", "success");
});
refs.zoomInBtn.addEventListener("click", () => updateZoom(0.1));
refs.zoomOutBtn.addEventListener("click", () => updateZoom(-0.1));

refs.pickFolderBtn.addEventListener("click", () => refs.folderPicker.click());
refs.folderPicker.addEventListener("change", (event) => {
  setPickedFolder(Array.from(event.target.files || []));
});

refs.displayInputs.forEach((input) => {
  input.addEventListener("change", () => {
    collectDisplayFromControls();
    if (state.map) {
      layoutMap();
      state.fitAfterMeasure = true;
      renderMap();
    }
  });
});

refs.nodeTitle.addEventListener("input", (event) => {
  const node = getNode(state.selectedNodeId);
  if (!node) {
    return;
  }
  node.title = event.target.value;
  renderMap();
});

refs.nodeNote.addEventListener("input", (event) => {
  const node = getNode(state.selectedNodeId);
  if (!node) {
    return;
  }
  node.note = event.target.value;
  renderDetails();
});

refs.addChildBtn.addEventListener("click", () => {
  if (state.selectedNodeId) {
    addNode(state.selectedNodeId);
  }
});

refs.addSiblingBtn.addEventListener("click", () => {
  const node = getNode(state.selectedNodeId);
  if (node?.parentId) {
    addNode(node.parentId);
  }
});

refs.deleteBtn.addEventListener("click", () => {
  if (state.map && state.selectedNodeId && state.selectedNodeId !== state.map.rootId) {
    deleteNode(state.selectedNodeId);
  }
});

refs.canvasViewport.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest(".map-node")) {
    return;
  }
  state.pan = {
    startX: event.clientX,
    startY: event.clientY,
    originX: state.viewport.x,
    originY: state.viewport.y
  };
  refs.canvasViewport.classList.add("panning");
});

window.addEventListener("mousemove", (event) => {
  if (state.drag && state.map) {
    const node = getNode(state.drag.nodeId);
    if (node) {
      const worldPoint = screenToWorld(event.clientX, event.clientY);
      node.x = worldPoint.x - state.drag.offsetX;
      node.y = worldPoint.y - state.drag.offsetY;
      renderMap();
    }
    return;
  }

  if (state.pan) {
    state.viewport.x = state.pan.originX + (event.clientX - state.pan.startX);
    state.viewport.y = state.pan.originY + (event.clientY - state.pan.startY);
    applyWorldTransform();
  }
});

window.addEventListener("mouseup", () => {
  state.drag = null;
  state.pan = null;
  refs.canvasViewport.classList.remove("panning");
});

refs.canvasViewport.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    updateZoom(event.deltaY < 0 ? 0.08 : -0.08, {
      x: event.clientX,
      y: event.clientY
    });
  },
  { passive: false }
);

window.addEventListener("resize", () => {
  if (state.map) {
    fitView();
  }
});

syncDisplayControls();
syncEditor();
updateStats(null);
applyWorldTransform();
