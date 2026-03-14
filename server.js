const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const SAVED_MAP_FILE = path.join(DATA_DIR, "saved-map.json");
const REQUEST_LIMIT_BYTES = 50 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "synchronized",
  "native",
  "strictfp",
  "default",
  "sealed",
  "non-sealed",
  "transient",
  "volatile"
]);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > REQUEST_LIMIT_BYTES) {
        reject(new Error("请求体过大，请改用路径读取或减少上传文件数量"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

function normalizeFolderPath(input) {
  return String(input || "")
    .trim()
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .trim();
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function stripAnnotations(text) {
  return text
    .replace(/@\w+(?:\.\w+)*(?:\([^()]*\))?\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeTypeReference(name) {
  return String(name || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\[\]/g, "")
    .trim();
}

function splitTopLevelList(text) {
  const parts = [];
  let current = "";
  let angleDepth = 0;
  let parenDepth = 0;
  for (const char of text) {
    if (char === "<") angleDepth += 1;
    if (char === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (char === "," && angleDepth === 0 && parenDepth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function extractBlock(text, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openBraceIndex, index + 1);
      }
    }
  }
  return text.slice(openBraceIndex);
}

function splitTopLevelMembers(typeBody) {
  const inner = typeBody.slice(1, -1);
  const segments = [];
  let depth = 0;
  let current = "";

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    current += char;

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && current.trim()) {
        segments.push(current.trim());
        current = "";
      }
      continue;
    }

    if (char === ";" && depth === 0) {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
    }
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function readLeadingModifiers(parts) {
  const modifiers = [];
  while (parts.length && MODIFIERS.has(parts[0])) {
    modifiers.push(parts.shift());
  }
  return modifiers;
}

function parseFieldMembers(headerText) {
  const declaration = collapseWhitespace(stripAnnotations(headerText).replace(/;$/, ""));
  if (!declaration || declaration.includes("(")) {
    return [];
  }

  const withoutAssignment = declaration.replace(/\s*=\s*.+$/, "").trim();
  let parts = withoutAssignment.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return [];
  }

  const modifiers = readLeadingModifiers(parts);
  if (parts.length < 2) {
    return [];
  }

  const namesText = parts.pop();
  const type = parts.join(" ").trim();
  if (!type) {
    return [];
  }

  return namesText
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      type,
      modifiers
    }));
}

function parseExecutableMember(headerText, className) {
  const declaration = collapseWhitespace(stripAnnotations(headerText).replace(/[;{]\s*$/, ""));
  if (!declaration.includes("(") || !declaration.includes(")")) {
    return null;
  }

  const openParenIndex = declaration.indexOf("(");
  const closeParenIndex = declaration.lastIndexOf(")");
  if (openParenIndex < 0 || closeParenIndex < openParenIndex) {
    return null;
  }

  const beforeParams = declaration.slice(0, openParenIndex).trim();
  const parameterText = collapseWhitespace(declaration.slice(openParenIndex + 1, closeParenIndex));
  let parts = beforeParams.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return null;
  }

  const name = parts.pop();
  if (!name || ["if", "for", "while", "switch", "catch"].includes(name)) {
    return null;
  }

  const modifiers = readLeadingModifiers(parts);
  const beforeName = parts.join(" ").replace(/^<[^>]+>\s*/, "").trim();
  const constructor = name === className;
  const returnType = constructor ? "" : beforeName;

  return {
    kind: constructor ? "constructor" : "method",
    name,
    modifiers,
    returnType,
    parameters: parameterText,
    signature: constructor
      ? `${name}(${parameterText})`
      : `${name}(${parameterText})${returnType ? ` : ${returnType}` : ""}`
  };
}

function parseRelationships(restText) {
  let rest = collapseWhitespace(restText || "");
  rest = rest.replace(/^<[^>]+>\s*/, "").trim();
  const extendsMatch = rest.match(/\bextends\s+(.+?)(?=\s+implements\b|$)/);
  const implementsMatch = rest.match(/\bimplements\s+(.+)$/);
  const extendsName = extendsMatch ? collapseWhitespace(extendsMatch[1]) : "";
  const implementsNames = implementsMatch
    ? splitTopLevelList(implementsMatch[1]).map((item) => collapseWhitespace(item))
    : [];
  return {
    extendsName,
    implementsNames
  };
}

function parseJavaSource(sourceInfo) {
  const clean = stripComments(sourceInfo.content);
  const packageMatch = clean.match(/\bpackage\s+([\w.]+)\s*;/);
  const packageName = packageMatch ? packageMatch[1] : "(default)";
  const imports = Array.from(clean.matchAll(/\bimport\s+([\w.*]+)\s*;/g)).map((match) => match[1]);

  const typeRegex =
    /((?:(?:public|protected|private|abstract|final|static|sealed|non-sealed)\s+)*)((?:class|interface|enum|record))\s+([A-Z][\w]*)\s*([^{};]*)\{/g;

  const classes = [];
  let match;
  while ((match = typeRegex.exec(clean)) !== null) {
    const modifiers = collapseWhitespace(match[1] || "")
      .split(/\s+/)
      .filter(Boolean);
    const kind = match[2];
    const name = match[3];
    const relationshipText = match[4] || "";
    const braceIndex = clean.indexOf("{", match.index);
    const typeBody = extractBlock(clean, braceIndex);
    const members = splitTopLevelMembers(typeBody);
    const parsedMethods = [];
    const parsedConstructors = [];
    const parsedFields = [];

    for (const segment of members) {
      const header = segment.includes("{") ? segment.slice(0, segment.indexOf("{")) : segment;
      const executable = parseExecutableMember(header, name);
      if (executable) {
        if (executable.kind === "constructor") {
          parsedConstructors.push(executable);
        } else {
          parsedMethods.push(executable);
        }
        continue;
      }

      const fields = parseFieldMembers(header);
      parsedFields.push(...fields);
    }

    const { extendsName, implementsNames } = parseRelationships(relationshipText);
    classes.push({
      id: `class:${packageName}.${name}:${classes.length + 1}`,
      filePath: sourceInfo.filePath,
      relativePath: sourceInfo.relativePath,
      packageName,
      name,
      fullName: packageName === "(default)" ? name : `${packageName}.${name}`,
      kind,
      modifiers,
      extendsName,
      implementsNames,
      imports,
      fields: parsedFields,
      constructors: parsedConstructors,
      methods: parsedMethods
    });
  }

  return {
    packageName,
    classes
  };
}

async function listJavaFiles(dirPath) {
  const results = [];

  async function walk(currentPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".java")) {
        results.push(fullPath);
      }
    }
  }

  await walk(dirPath);
  return results;
}

function summarizeProject(packages, classList, relations) {
  const packageEntries = Array.from(packages.entries())
    .map(([packageName, items]) => ({
      packageName,
      count: items.length
    }))
    .sort((left, right) => right.count - left.count);

  const largestPackage = packageEntries[0];
  return [
    `共识别 ${classList.length} 个类型，分布在 ${packages.size} 个 package 中。`,
    largestPackage
      ? `最大 package 为 ${largestPackage.packageName}，包含 ${largestPackage.count} 个类型。`
      : "当前没有识别到 package。",
    `内部结构关系 ${relations.length} 条。`,
    `可通过右侧结构开关决定是否在画布中显示字段、构造器、方法、继承、实现和依赖。`
  ];
}

function createMindMap(sourceLabel, packages, classList, relations) {
  const nodes = [];
  let counter = 0;

  function pushNode({ parentId = null, type, title, note = "", meta = {} }) {
    const id = `node_${++counter}`;
    nodes.push({
      id,
      parentId,
      type,
      title,
      note,
      meta,
      x: 0,
      y: 0
    });
    return id;
  }

  const rootId = pushNode({
    type: "root",
    title: sourceLabel || "Java Project",
    note: "自动归纳自 Java 源目录，可继续拖动、重命名、补充和保存。"
  });

  const summaryLines = summarizeProject(packages, classList, relations);
  pushNode({
    parentId: rootId,
    type: "summary",
    title: "架构概览",
    note: summaryLines.join("\n"),
    meta: {
      summaryLines
    }
  });

  const packageEntries = Array.from(packages.entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  );

  for (const [packageName, items] of packageEntries) {
    const packageId = pushNode({
      parentId: rootId,
      type: "package",
      title: packageName,
      note: `${items.length} 个类型`,
      meta: {
        packageName,
        classCount: items.length
      }
    });

    for (const classInfo of items.sort((left, right) => left.name.localeCompare(right.name))) {
      pushNode({
        parentId: packageId,
        type: "class",
        title: classInfo.name,
        note: `${classInfo.kind} · ${classInfo.relativePath}`,
        meta: {
          ...classInfo
        }
      });
    }
  }

  return {
    rootId,
    nodes,
    relations,
    generatedAt: new Date().toISOString(),
    sourceLabel
  };
}

function buildAnalysis(sourceLabel, sources) {
  const parsedFiles = sources.map(parseJavaSource);
  const packages = new Map();
  const classes = [];

  for (const parsed of parsedFiles) {
    for (const classInfo of parsed.classes) {
      classes.push(classInfo);
      if (!packages.has(classInfo.packageName)) {
        packages.set(classInfo.packageName, []);
      }
      packages.get(classInfo.packageName).push(classInfo);
    }
  }

  if (!classes.length) {
    throw new Error("已读取 Java 文件，但没有识别到 class / interface / enum / record");
  }

  const classByFullName = new Map();
  const classBySimpleName = new Map();
  for (const classInfo of classes) {
    classByFullName.set(classInfo.fullName, classInfo);
    if (!classBySimpleName.has(classInfo.name)) {
      classBySimpleName.set(classInfo.name, classInfo);
    }
  }

  const relations = [];
  for (const classInfo of classes) {
    const normalizedImports = classInfo.imports
      .map((item) => ({
        full: item,
        simple: item.split(".").pop()
      }))
      .filter((item) => classByFullName.has(item.full) || classBySimpleName.has(item.simple));

    classInfo.internalDeps = normalizedImports.map((item) => item.full);

    const relationCandidates = [
      classInfo.extendsName
        ? { type: "extends", name: sanitizeTypeReference(classInfo.extendsName) }
        : null,
      ...classInfo.implementsNames.map((item) => ({
        type: "implements",
        name: sanitizeTypeReference(item)
      })),
      ...normalizedImports.map((item) => ({
        type: "depends",
        name: sanitizeTypeReference(item.full)
      }))
    ].filter(Boolean);

    for (const relation of relationCandidates) {
      const simpleName = relation.name.split(".").pop();
      const target = classByFullName.get(relation.name) || classBySimpleName.get(simpleName);
      relations.push({
        sourceId: classInfo.id,
        sourceName: classInfo.name,
        targetId: target ? target.id : null,
        targetName: target ? target.name : relation.name,
        type: relation.type
      });
    }
  }

  return {
    stats: {
      fileCount: sources.length,
      classCount: classes.length,
      packageCount: packages.size,
      relationCount: relations.length
    },
    map: createMindMap(sourceLabel, packages, classes, relations)
  };
}

async function analyzeJavaFolder(folderPath) {
  const normalizedPath = normalizeFolderPath(folderPath);
  const stat = await fsp.stat(normalizedPath);
  if (!stat.isDirectory()) {
    throw new Error("指定路径不是文件夹");
  }

  const javaFiles = await listJavaFiles(normalizedPath);
  if (!javaFiles.length) {
    throw new Error("指定文件夹下没有找到 .java 文件");
  }

  const sources = [];
  for (const filePath of javaFiles) {
    sources.push({
      filePath,
      relativePath: path.relative(normalizedPath, filePath) || path.basename(filePath),
      content: await fsp.readFile(filePath, "utf8")
    });
  }

  return buildAnalysis(path.basename(normalizedPath), sources);
}

function analyzeUploadedFiles(files, folderLabel) {
  if (!Array.isArray(files) || !files.length) {
    throw new Error("没有可分析的 Java 文件");
  }

  const sources = files
    .filter((item) => item && item.relativePath && item.content && item.relativePath.endsWith(".java"))
    .map((item) => ({
      filePath: item.relativePath,
      relativePath: item.relativePath,
      content: item.content
    }));

  if (!sources.length) {
    throw new Error("上传内容中没有可识别的 .java 文件");
  }

  return buildAnalysis(folderLabel || "Selected Folder", sources);
}

async function serveStaticFile(reqPath, res) {
  const normalized = reqPath === "/" ? "/index.html" : reqPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalized));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": data.length
    });
    res.end(data);
  } catch (error) {
    sendText(res, 404, "Not Found");
  }
}

async function handleApi(req, res, urlObj) {
  if (req.method === "GET" && urlObj.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (req.method === "GET" && urlObj.pathname === "/api/maps/latest") {
    try {
      const content = await fsp.readFile(SAVED_MAP_FILE, "utf8");
      sendJson(res, 200, JSON.parse(content));
    } catch (error) {
      sendJson(res, 404, { error: "暂无已保存的图谱" });
    }
    return;
  }

  if (req.method === "POST" && urlObj.pathname === "/api/analyze") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      if (!body.folderPath || typeof body.folderPath !== "string") {
        sendJson(res, 400, { error: "folderPath 是必填项" });
        return;
      }
      const result = await analyzeJavaFolder(body.folderPath);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "分析失败" });
    }
    return;
  }

  if (req.method === "POST" && urlObj.pathname === "/api/analyze-files") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const result = analyzeUploadedFiles(body.files, body.folderLabel);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "分析失败" });
    }
    return;
  }

  if (req.method === "POST" && urlObj.pathname === "/api/maps/save") {
    try {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      if (!body.map || !body.map.rootId || !Array.isArray(body.map.nodes)) {
        sendJson(res, 400, { error: "map 数据格式不正确" });
        return;
      }

      await ensureDataDir();
      const payload = {
        savedAt: new Date().toISOString(),
        ...body
      };
      await fsp.writeFile(SAVED_MAP_FILE, JSON.stringify(payload, null, 2), "utf8");
      sendJson(res, 200, { ok: true, savedAt: payload.savedAt });
    } catch (error) {
      sendJson(res, 500, { error: error.message || "保存失败" });
    }
    return;
  }

  sendJson(res, 404, { error: "API not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    if (urlObj.pathname.startsWith("/api/")) {
      await handleApi(req, res, urlObj);
      return;
    }
    await serveStaticFile(urlObj.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Java mind map workbench running at http://localhost:${PORT}`);
});
