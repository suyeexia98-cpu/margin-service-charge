const CONFIG_KEY = "pricing-config";

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

export async function onRequestGet({ env }) {
  const store = getStore(env);
  if (!store) {
    return json({
      ok: false,
      error: "Cloudflare KV binding PRICING_CONFIG is not configured"
    }, { status: 503 });
  }

  const saved = await store.get(CONFIG_KEY, "json");
  return json({
    ok: true,
    config: saved && saved.config ? saved.config : null,
    updatedAt: saved && saved.updatedAt ? saved.updatedAt : null
  });
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
    return json({ ok: false, error: "配置格式不完整，未保存" }, { status: 400 });
  }

  const payload = {
    config: body.config,
    updatedAt: new Date().toISOString()
  };

  await store.put(CONFIG_KEY, JSON.stringify(payload));
  return json({ ok: true, ...payload });
}
