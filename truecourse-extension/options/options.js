// options.js
// Loads/saves the user's Claude API key to chrome.storage.local.

document.addEventListener("DOMContentLoaded", async () => {
  const { anthropicApiKey } = await chrome.storage.local.get("anthropicApiKey");
  if (anthropicApiKey) {
    document.getElementById("api-key").value = anthropicApiKey;
  }

  document.getElementById("save").addEventListener("click", async () => {
    const key = document.getElementById("api-key").value.trim();
    await chrome.storage.local.set({ anthropicApiKey: key });
    const status = document.getElementById("status");
    status.textContent = key ? "Saved." : "Cleared.";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
});
