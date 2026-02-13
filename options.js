(() => {
  const STORAGE_KEY = "todoistApiToken";

  const form = document.getElementById("settings-form");
  const tokenInput = document.getElementById("todoist-token");
  const statusEl = document.getElementById("status");
  const testButton = document.getElementById("test-connection");

  function getStorage() {
    return chrome.storage.sync || chrome.storage.local;
  }

  function storageGet(keys) {
    const storage = getStorage();
    return new Promise((resolve) => {
      storage.get(keys, (items) => resolve(items || {}));
    });
  }

  function storageSet(values) {
    const storage = getStorage();
    return new Promise((resolve) => {
      storage.set(values, () => resolve());
    });
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response || {});
      });
    });
  }

  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.classList.remove("success", "error");
    if (type) {
      statusEl.classList.add(type);
    }
  }

  async function loadSettings() {
    const values = await storageGet([STORAGE_KEY]);
    tokenInput.value = values[STORAGE_KEY] || "";
  }

  async function saveSettings() {
    const token = tokenInput.value.trim();
    await storageSet({
      [STORAGE_KEY]: token
    });

    if (!token) {
      showStatus("Token removed. Duplicate detection is disabled.", "success");
      return;
    }

    showStatus("Token saved.", "success");
  }

  async function testConnection() {
    showStatus("Testing Todoist connection...", "");
    try {
      const response = await sendMessage({
        type: "testTodoistToken"
      });

      if (!response || !response.ok) {
        const message =
          (response && response.error) || "Could not validate the Todoist token.";
        showStatus(message, "error");
        return;
      }

      showStatus("Connection OK. Duplicate detection is enabled.", "success");
    } catch (error) {
      showStatus(
        error instanceof Error ? error.message : "Failed to contact extension background.",
        "error"
      );
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveSettings();
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Failed to save token.", "error");
    }
  });

  testButton.addEventListener("click", () => {
    void testConnection();
  });

  void loadSettings();
})();
