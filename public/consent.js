const CONSENT_KEY = "bbtsl.analytics.consent";
const CONFIG_PATH = "/api/public-config";
const DIALOG_ID = "bbtslAnalyticsConsent";
const SETTINGS_ID = "bbtslAnalyticsSettings";
let measurementId = null;
let analyticsLoaded = false;

export function normalizeConsent(value) {
  return value === "granted" || value === "denied" ? value : "unknown";
}

export function normalizeMeasurementId(value) {
  const normalized = String(value || "").trim();
  return /^G-[A-Z0-9]{6,20}$/.test(normalized) && normalized !== "G-XXXXXXXXXX" ? normalized : null;
}

export function getStoredConsent(storage = globalThis.localStorage) {
  try {
    return normalizeConsent(storage?.getItem(CONSENT_KEY));
  } catch {
    return "unknown";
  }
}

export async function setConsent(value, options = {}) {
  const consent = normalizeConsent(value);
  if (consent === "unknown") return;
  const storage = options.storage || globalThis.localStorage;
  try {
    storage?.setItem(CONSENT_KEY, consent);
  } catch {
  }
  updateGoogleConsent(consent);
  closeConsentDialog();
  if (consent === "granted") {
    await loadGoogleAnalytics();
    ensureSettingsButton();
    return;
  }
  clearGoogleAnalyticsCookies();
  ensureSettingsButton();
  if (analyticsLoaded && options.reload !== false && globalThis.location?.reload) {
    globalThis.location.reload();
  }
}

async function boot() {
  const config = await loadPublicConfig();
  measurementId = normalizeMeasurementId(config?.analytics?.measurementId);
  if (!measurementId || config?.analytics?.enabled !== true) return;

  initializeConsentMode();
  const consent = getStoredConsent();
  if (consent !== "granted") {
    ensureSettingsButton();
    if (consent === "unknown") showConsentDialog(true);
    return;
  }
  updateGoogleConsent("granted");
  await loadGoogleAnalytics();
  ensureSettingsButton();
}

async function loadPublicConfig() {
  try {
    const response = await fetch(CONFIG_PATH, {
      method: "GET",
      credentials: "same-origin",
      cache: "default",
      headers: { accept: "application/json" }
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

function initializeConsentMode() {
  globalThis.dataLayer = globalThis.dataLayer || [];
  globalThis.gtag = globalThis.gtag || function gtag() {
    globalThis.dataLayer.push(arguments);
  };
  globalThis.gtag("consent", "default", {
    ad_storage: "denied",
    analytics_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    wait_for_update: 500
  });
}

function updateGoogleConsent(consent) {
  if (typeof globalThis.gtag !== "function") return;
  const granted = consent === "granted" ? "granted" : "denied";
  globalThis.gtag("consent", "update", {
    ad_storage: "denied",
    analytics_storage: granted,
    ad_user_data: "denied",
    ad_personalization: "denied"
  });
}

async function loadGoogleAnalytics() {
  if (analyticsLoaded || !measurementId || getStoredConsent() !== "granted") return;
  analyticsLoaded = true;
  await new Promise((resolve) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", resolve, { once: true });
    document.head.append(script);
  });
  if (typeof globalThis.gtag !== "function" || getStoredConsent() !== "granted") return;
  globalThis.gtag("js", new Date());
  globalThis.gtag("config", measurementId, {
    send_page_view: true,
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_flags: "SameSite=Lax;Secure"
  });
}

function ensureSettingsButton() {
  if (!document.body || document.getElementById(SETTINGS_ID)) return;
  const button = document.createElement("button");
  button.id = SETTINGS_ID;
  button.className = "analytics-settings-button";
  button.type = "button";
  button.textContent = "Cookie settings";
  button.addEventListener("click", () => showConsentDialog(false));
  document.body.append(button);
}

function showConsentDialog(firstVisit) {
  closeConsentDialog();
  const wrapper = document.createElement("div");
  wrapper.id = DIALOG_ID;
  wrapper.className = "analytics-consent-overlay";
  wrapper.setAttribute("role", "presentation");

  const dialog = document.createElement("section");
  dialog.className = "analytics-consent-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${DIALOG_ID}Title`);
  dialog.innerHTML = `
    <h2 id="${DIALOG_ID}Title">Analytics choice</h2>
    <p>BBTSL can use privacy-restricted Google Analytics to measure page performance and general usage. It stays completely off unless you accept.</p>
    <p><a href="/privacy">Read the privacy policy</a></p>
    <div class="analytics-consent-actions">
      <button type="button" data-consent="denied">Reject analytics</button>
      <button type="button" class="primary" data-consent="granted">Accept analytics</button>
    </div>
  `;
  wrapper.append(dialog);
  document.body.append(wrapper);
  dialog.querySelector('[data-consent="denied"]')?.addEventListener("click", () => setConsent("denied"));
  dialog.querySelector('[data-consent="granted"]')?.addEventListener("click", () => setConsent("granted"));
  if (!firstVisit) {
    wrapper.addEventListener("click", (event) => {
      if (event.target === wrapper) closeConsentDialog();
    });
  }
  dialog.querySelector("button")?.focus();
}

function closeConsentDialog() {
  document.getElementById(DIALOG_ID)?.remove();
}

function clearGoogleAnalyticsCookies() {
  if (typeof document === "undefined") return;
  const names = document.cookie.split(";").map((part) => part.trim().split("=")[0]).filter((name) => name === "_ga" || name.startsWith("_ga_"));
  for (const name of names) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
    document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.${location.hostname}; SameSite=Lax; Secure`;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  boot();
}
