const CONFIG_KEY = "pricing-config";
const MAX_VERSIONS = 30;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {})
    }
  });
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validTierGroup(tiers) {
  return Array.isArray(tiers)
    && tiers.length > 0
    && tiers.length <= 20
    && tiers.every(tier => (
      isObject(tier)
      && isFiniteNumber(tier.min)
      && isFiniteNumber(tier.max)
      && tier.max >= tier.min
      && isFiniteNumber(tier.value)
    ));
}

function validConfig(config) {
  return isObject(config)
    && isFiniteNumber(config.baseDeposit)
    && isObject(config.rounding)
    && ["floor", "ceil", "round"].includes(config.rounding.method)
    && isFiniteNumber(config.rounding.unit)
    && config.rounding.unit > 0
    && validTierGroup(config.pTiers)
    && validTierGroup(config.vTiers)
    && isObject(config.cValues)
    && isFiniteNumber(config.cValues.simple)
    && isFiniteNumber(config.cValues.complex)
    && isObject(config.fht)
    && isFiniteNumber(config.fht.setupFee)
    && isFiniteNumber(config.fht.agreementUnit)
    && isFiniteNumber(config.fht.simpleValuationUnit)
    && isFiniteNumber(config.fht.complexValuationUnit);
}

function getStore(env) {
  return env.PRICING_CONFIG;
}

function cleanText(value, fallback, maxLength) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return text || fallback;
}

function validVersion(version) {
  return isObject(version)
    && typeof version.id === "string"
    && version.id.length > 0
    && typeof version.name === "string"
    && validConfig(version.config);
}

function normalizeVersions(versions) {
  if (!Array.isArray(versions)) return [];
  return versions
    .filter(validVersion)
    .slice(0, MAX_VERSIONS)
    .map(version => ({
      id: version.id,
      name: cleanText(version.name, "未命名方案", 24),
      note: cleanText(version.note || "", "", 80),
      config: version.config,
      createdAt: version.createdAt || "",
      updatedAt: version.updatedAt || ""
    }));
}

function normalizePayload(saved) {
  const source = isObject(saved) ? saved : {};
  return {
    config: validConfig(source.config) ? source.config : null,
    updatedAt: source.updatedAt || null,
    activeVersionId: typeof source.activeVersionId === "string" ? source.activeVersionId : "",
    versions: normalizeVersions(source.versions)
  };
}

function responsePayload(payload, extra = {}) {
  return {
    ok: true,
    config: payload.config,
    updatedAt: payload.updatedAt,
    activeVersionId: payload.activeVersionId,
    versions: payload.versions,
    ...extra
  };
}

async function readPayload(store) {
  const saved = await store.get(CONFIG_KEY, "json");
  return normalizePayload(saved);
}

async function writePayload(store, payload) {
  await store.put(CONFIG_KEY, JSON.stringify(payload));
}

function newVersionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `version-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function onRequestGet({ env }) {
  const store = getStore(env);
  if (!store) {
    return json({
      ok: false,
      error: "Cloudflare KV binding PRICING_CONFIG is not configured"
    }, { status: 503 });
  }

  const payload = await readPayload(store);
  return json(responsePayload(payload));
}

export async function onRequestPost({ request, env }) {
  const store = getStore(env);
  if (!store) {
    return json({
      ok: false,
      error: "Cloudflare KV binding PRICING_CONFIG is not configured"
    }, { status: 503 });
  }

  const expectedToken = env.CONFIG_ADMIN_TOKEN;
  const token = request.headers.get("x-admin-token") || "";
  if (!expectedToken || token !== expectedToken) {
    return json({
      ok: false,
      error: "管理口令不正确或尚未配置"
    }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "请求格式不是有效 JSON" }, { status: 400 });
  }

  if (!validConfig(body.config)) {
    if (!["set-default", "delete-version"].includes(body.action)) {
      return json({ ok: false, error: "配置格式不完整，未保存" }, { status: 400 });
    }
  }

  const action = body.action || "save-default";
  const existing = await readPayload(store);
  const now = new Date().toISOString();

  if (action === "save-default") {
    const payload = {
      ...existing,
      config: body.config,
      updatedAt: now,
      activeVersionId: ""
    };
    await writePayload(store, payload);
    return json(responsePayload(payload));
  }

  if (action === "save-version") {
    if (!validConfig(body.config)) {
      return json({ ok: false, error: "配置格式不完整，未保存" }, { status: 400 });
    }
    const version = {
      id: newVersionId(),
      name: cleanText(body.name, `方案${existing.versions.length + 1}`, 24),
      note: cleanText(body.note || "", "", 80),
      config: body.config,
      createdAt: now,
      updatedAt: now
    };
    const payload = {
      ...existing,
      versions: [version, ...existing.versions].slice(0, MAX_VERSIONS)
    };
    await writePayload(store, payload);
    return json(responsePayload(payload, { version }));
  }

  if (action === "set-default") {
    const versionId = String(body.versionId || "");
    const version = existing.versions.find(item => item.id === versionId);
    if (!version) {
      return json({ ok: false, error: "未找到该方案版本" }, { status: 404 });
    }
    const payload = {
      ...existing,
      config: version.config,
      updatedAt: now,
      activeVersionId: version.id
    };
    await writePayload(store, payload);
    return json(responsePayload(payload, { version }));
  }

  if (action === "delete-version") {
    const versionId = String(body.versionId || "");
    if (existing.activeVersionId === versionId) {
      return json({ ok: false, error: "当前全局默认版本不能删除，请先切换默认版本" }, { status: 400 });
    }
    const before = existing.versions.length;
    const versions = existing.versions.filter(item => item.id !== versionId);
    if (versions.length === before) {
      return json({ ok: false, error: "未找到该方案版本" }, { status: 404 });
    }
    const payload = {
      ...existing,
      versions
    };
    await writePayload(store, payload);
    return json(responsePayload(payload));
  }

  return json({ ok: false, error: "不支持的操作" }, { status: 400 });
}
