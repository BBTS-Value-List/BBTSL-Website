const apiStatusText = document.getElementById("apiStatusText");
const apiStatusResult = document.getElementById("apiStatusResult");
const copyReportTemplate = document.getElementById("copyReportTemplate");
const reportTemplate = document.getElementById("reportTemplate");

checkWebsiteApi();

copyReportTemplate?.addEventListener("click", async () => {
  const text = reportTemplate?.textContent || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyReportTemplate.textContent = "Copied";
  } catch {
    window.prompt("Copy this report template", text);
    copyReportTemplate.textContent = "Ready";
  }
  window.setTimeout(() => {
    copyReportTemplate.textContent = "Copy template";
  }, 1600);
});

async function checkWebsiteApi() {
  if (!apiStatusText || !apiStatusResult) return;
  try {
    const startedAt = performance.now();
    const response = await fetch("/api/swords?limit=1", {
      credentials: "same-origin",
      headers: { "x-bbts-request": "1" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const elapsedMs = Math.round(performance.now() - startedAt);
    apiStatusText.textContent = "Website item API answered.";
    apiStatusResult.textContent = `ok, ${elapsedMs} ms`;
  } catch {
    apiStatusText.textContent = "Website item API did not answer from this browser.";
    apiStatusResult.textContent = "failed";
  }
}
