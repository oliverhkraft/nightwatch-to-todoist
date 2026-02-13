const STORAGE_KEYS = {
  todoistApiToken: "todoistApiToken"
};

const TODOIST_API_BASE = "https://api.todoist.com/api/v1";
const TODOIST_PAGE_SIZE = 200;
const TODOIST_TASK_MAX_PAGES = 10;
const TASK_CACHE_TTL_MS = 90 * 1000;

let taskCache = {
  token: "",
  fetchedAt: 0,
  tasks: []
};

function getStorage() {
  return chrome.storage.sync || chrome.storage.local;
}

function storageGet(keys) {
  const storage = getStorage();
  return new Promise((resolve) => {
    storage.get(keys, (items) => resolve(items || {}));
  });
}

function clearTaskCache() {
  taskCache = {
    token: "",
    fetchedAt: 0,
    tasks: []
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTodoistApiUrl(path, query) {
  const url = new URL(`${TODOIST_API_BASE}${path}`);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function todoistFetch(path, token, query) {
  const response = await fetch(buildTodoistApiUrl(path, query), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch (error) {
      details = "";
    }

    if (response.status === 410) {
      throw new Error(
        "Todoist API request failed (410). The endpoint is deprecated. Reload the extension and verify it uses /api/v1."
      );
    }

    throw new Error(`Todoist API request failed (${response.status}). ${details.slice(0, 300)}`);
  }

  return response.json();
}

async function todoistCreate(path, token, payload) {
  const response = await fetch(buildTodoistApiUrl(path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch (error) {
      details = "";
    }

    throw new Error(`Todoist API create failed (${response.status}). ${details.slice(0, 300)}`);
  }

  return response.json();
}

function extractListResults(payload) {
  if (Array.isArray(payload)) {
    return {
      results: payload,
      nextCursor: ""
    };
  }

  if (payload && Array.isArray(payload.results)) {
    return {
      results: payload.results,
      nextCursor: typeof payload.next_cursor === "string" ? payload.next_cursor : ""
    };
  }

  return {
    results: [],
    nextCursor: ""
  };
}

async function todoistFetchPaginated(path, token, maxPages = TODOIST_TASK_MAX_PAGES) {
  const collected = [];
  let cursor = "";

  for (let page = 0; page < maxPages; page += 1) {
    const payload = await todoistFetch(path, token, {
      limit: TODOIST_PAGE_SIZE,
      cursor: cursor || undefined
    });

    const { results, nextCursor } = extractListResults(payload);
    collected.push(...results);

    if (!nextCursor) {
      break;
    }

    cursor = nextCursor;
  }

  return collected;
}

async function getActiveTasks(token) {
  const now = Date.now();
  if (
    taskCache.token === token &&
    now - taskCache.fetchedAt < TASK_CACHE_TTL_MS
  ) {
    return taskCache.tasks;
  }

  const tasks = await todoistFetchPaginated("/tasks", token);
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];

  taskCache = {
    token,
    fetchedAt: now,
    tasks: normalizedTasks
  };

  return normalizedTasks;
}

function summarizeTask(task) {
  const taskId = task && task.id ? String(task.id) : "";
  return {
    id: taskId,
    content: task.content || "",
    description: task.description || "",
    url: taskId ? `https://app.todoist.com/app/task/${encodeURIComponent(taskId)}` : ""
  };
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTitleProbe(title) {
  const normalized = normalizeForMatch(title);
  if (!normalized || normalized.length < 12) {
    return "";
  }

  const words = normalized.split(" ").filter((word) => word.length > 2);
  return words.slice(0, 8).join(" ");
}

function buildIssueRegex(issueId) {
  const escapedIssueId = escapeRegExp(issueId);
  return new RegExp(
    [
      `\\[nw:${escapedIssueId}\\]`,
      `nightwatch\\s+key\\s*:\\s*issue:${escapedIssueId}`,
      `issue\\s+id\\s*:\\s*${escapedIssueId}`,
      `#${escapedIssueId}(?:\\b|$)`,
      `\\/(?:exceptions?|issues?)\\/${escapedIssueId}(?:[/?#]|\\b)`
    ].join("|"),
    "i"
  );
}

function getIssueHintTitle(issueHints, issueId) {
  if (!issueHints || typeof issueHints !== "object") {
    return "";
  }

  const hint = issueHints[issueId];
  if (!hint || typeof hint !== "object") {
    return "";
  }

  return typeof hint.title === "string" ? hint.title : "";
}

function buildMatchMap(tasks, issueIds, issueHints) {
  const map = {};
  const ids = Array.from(new Set(issueIds.map((id) => String(id))));

  const searchable = tasks.map((task) => ({
    task,
    haystack: `${task.content || ""}\n${task.description || ""}`,
    normalizedHaystack: normalizeForMatch(`${task.content || ""}\n${task.description || ""}`)
  }));

  for (const issueId of ids) {
    const matcher = buildIssueRegex(issueId);
    const titleProbe = buildTitleProbe(getIssueHintTitle(issueHints, issueId));
    const hits = [];

    for (const entry of searchable) {
      if (matcher.test(entry.haystack)) {
        hits.push(summarizeTask(entry.task));
      } else if (titleProbe) {
        const hasNightwatchSignal = /nightwatch/i.test(entry.haystack);
        if (hasNightwatchSignal && entry.normalizedHaystack.includes(titleProbe)) {
          hits.push(summarizeTask(entry.task));
        }
      }

      if (hits.length >= 5) {
        break;
      }
    }

    map[issueId] = hits;
  }

  return map;
}

async function getSettings() {
  const result = await storageGet([STORAGE_KEYS.todoistApiToken]);
  const todoistApiToken = (result[STORAGE_KEYS.todoistApiToken] || "").trim();
  return {
    todoistApiToken,
    configured: Boolean(todoistApiToken)
  };
}

async function handleFindTodoistMatches(message) {
  const { todoistApiToken, configured } = await getSettings();

  if (!configured) {
    return {
      ok: true,
      configured: false,
      matches: {}
    };
  }

  const issueIds = Array.isArray(message.issueIds)
    ? message.issueIds.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];

  if (issueIds.length === 0) {
    return {
      ok: true,
      configured: true,
      matches: {}
    };
  }

  const tasks = await getActiveTasks(todoistApiToken);
  const matches = buildMatchMap(tasks, issueIds, message.issueHints);

  return {
    ok: true,
    configured: true,
    matches
  };
}

async function handleGetSettings() {
  const settings = await getSettings();
  return {
    ok: true,
    configured: settings.configured
  };
}

async function handleTestTodoistToken() {
  const { todoistApiToken, configured } = await getSettings();
  if (!configured) {
    return {
      ok: false,
      configured: false,
      error: "No Todoist token is saved."
    };
  }

  await todoistFetch("/projects", todoistApiToken, {
    limit: 1
  });
  return {
    ok: true,
    configured: true
  };
}

async function handleCreateTodoistTask(message) {
  const { todoistApiToken, configured } = await getSettings();
  if (!configured) {
    return {
      ok: false,
      configured: false,
      error: "No Todoist token is saved."
    };
  }

  const content = typeof message.content === "string" ? message.content.trim() : "";
  const description = typeof message.description === "string" ? message.description : "";

  if (!content) {
    return {
      ok: false,
      configured: true,
      error: "Task content is required."
    };
  }

  const task = await todoistCreate("/tasks", todoistApiToken, {
    content,
    description
  });

  clearTaskCache();

  return {
    ok: true,
    configured: true,
    task: summarizeTask(task)
  };
}

function respondWithPromise(promise, sendResponse) {
  Promise.resolve(promise)
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEYS.todoistApiToken]) {
    clearTaskCache();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "findTodoistMatches") {
    respondWithPromise(handleFindTodoistMatches(message), sendResponse);
    return true;
  }

  if (message.type === "getSettings") {
    respondWithPromise(handleGetSettings(), sendResponse);
    return true;
  }

  if (message.type === "testTodoistToken") {
    respondWithPromise(handleTestTodoistToken(), sendResponse);
    return true;
  }

  if (message.type === "createTodoistTask") {
    respondWithPromise(handleCreateTodoistTask(message), sendResponse);
    return true;
  }

  return false;
});
