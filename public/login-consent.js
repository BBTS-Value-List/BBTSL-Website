const LOGIN_BUTTON_IDS = ["shortcutLoginBtn", "favoriteLoginBtn", "teamShortcutLoginBtn"];
const LOCK_ICON_SVG = `
  <svg class="login-consent-lock-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path d="M7.25 10.5V8.25C7.25 5.626 9.376 3.5 12 3.5s4.75 2.126 4.75 4.75v2.25" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
    <path d="M6.75 10h10.5A1.75 1.75 0 0 1 19 11.75v6A1.75 1.75 0 0 1 17.25 19.5H6.75A1.75 1.75 0 0 1 5 17.75v-6A1.75 1.75 0 0 1 6.75 10Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>
    <path d="M12 14v2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
  </svg>
`;

function initLoginConsentGate() {
  for (const id of LOGIN_BUTTON_IDS) {
    const button = document.getElementById(id);
    if (!button || button.dataset.loginConsentGate === "bound") continue;
    const modal = button.closest(".modal");
    if (!modal) continue;
    const copy = modal.querySelector(".auth-copy");
    if (!copy) continue;

    button.dataset.loginConsentGate = "bound";

    const gate = document.createElement("label");
    gate.className = "login-consent-gate";
    gate.innerHTML = `
      <input class="login-consent-checkbox" type="checkbox" aria-label="Agree to the Terms and Privacy Policy" autocomplete="off">
      <span class="login-consent-box" aria-hidden="true"></span>
      <span class="login-consent-text">I agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms</a> and <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</span>
    `;
    copy.insertAdjacentElement("afterend", gate);

    const wrap = document.createElement("span");
    wrap.className = "login-consent-button-wrap";
    button.parentNode.insertBefore(wrap, button);
    wrap.appendChild(button);

    const overlay = document.createElement("span");
    overlay.className = "login-consent-lock-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = LOCK_ICON_SVG;
    wrap.appendChild(overlay);

    const checkbox = gate.querySelector("input");
    const sync = () => {
      const allowed = Boolean(checkbox.checked);
      button.disabled = !allowed;
      button.setAttribute("aria-disabled", String(!allowed));
      button.classList.toggle("login-consent-locked", !allowed);
      wrap.classList.toggle("is-unlocked", allowed);
    };
    const reset = () => {
      checkbox.checked = false;
      sync();
    };
    const modalIsOpen = () => !modal.closest("[hidden]") && !modal.hidden && !modal.parentElement?.hidden;

    checkbox.addEventListener("change", sync);
    button.addEventListener("click", (event) => {
      if (!checkbox.checked) {
        event.preventDefault();
        event.stopImmediatePropagation();
        checkbox.focus();
      }
    }, true);

    const observer = new MutationObserver(() => {
      if (modalIsOpen()) reset();
    });
    observer.observe(modal, { attributes: true, attributeFilter: ["hidden", "class"] });
    if (modal.parentElement) {
      observer.observe(modal.parentElement, { attributes: true, attributeFilter: ["hidden", "class"] });
    }

    reset();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLoginConsentGate, { once: true });
} else {
  initLoginConsentGate();
}
