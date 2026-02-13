(() => {
  const ROOT_ID = "nightwatch-todoist-root";
  const BUTTON_ID = "nightwatch-todoist-button";
  const STATUS_ID = "nightwatch-todoist-status";
  const OPEN_EXISTING_ID = "nightwatch-todoist-open-existing";
  const BADGE_CLASS = "nightwatch-todoist-badge";

  const DEFAULT_TODOIST_URL = "https://todoist.com/add";
  const TASK_PREFIX = "[Nightwatch]";
  const TASK_TITLE_MAX_LENGTH = 120;
  const MATCH_CACHE_TTL_MS = 20 * 1000;
  const SETTINGS_CACHE_TTL_MS = 30 * 1000;

  let lastHref = location.href;
  let renderScheduled = false;
  let renderNonce = 0;

  let matchCache = {
    signature: "",
    fetchedAt: 0,
    configured: false,
    matches: {}
  };

  let settingsCache = {
    fetchedAt: 0,
    configured: false
  };

  function invalidateCaches() {
    matchCache = {
      signature: "",
      fetchedAt: 0,
      configured: false,
      matches: {}
    };

    settingsCache = {
      fetchedAt: 0,
      configured: false
    };
  }

  function normalizeText(value) {
    if (!value) {
      return "";
    }

    return value.replace(/\s+/g, " ").trim();
  }

  function truncateText(value, maxLength) {
    const normalized = normalizeText(value);
    if (normalized.length <= maxLength) {
      return normalized;
    }

    if (maxLength <= 3) {
      return normalized.slice(0, maxLength);
    }

    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return element.offsetWidth > 0 || element.offsetHeight > 0;
  }

  function isNightwatchContext() {
    const signal = `${location.hostname} ${location.pathname} ${document.title}`.toLowerCase();
    if (signal.includes("nightwatch")) {
      return true;
    }

    const appMeta = document.querySelector("meta[name='application-name']");
    if (appMeta && /nightwatch/i.test(appMeta.getAttribute("content") || "")) {
      return true;
    }

    return false;
  }

  function parseIssueReference(value) {
    if (!value) {
      return null;
    }

    let url;
    try {
      url = new URL(value, location.origin);
    } catch (error) {
      return null;
    }

    const match = url.pathname.match(/\/(?:exceptions?|issues?)\/([^/?#]+)/i);
    if (!match) {
      return null;
    }

    const issueId = decodeURIComponent(match[1] || "").trim();
    if (!issueId) {
      return null;
    }

    const type = /\/exceptions?\//i.test(url.pathname) ? "exception" : "issue";

    return {
      issueId,
      type,
      url: url.toString(),
      pathname: url.pathname
    };
  }

  function getCurrentIssueFromLocation() {
    return parseIssueReference(location.href);
  }

  function isIssueListLikePath() {
    const path = location.pathname.toLowerCase();
    if (!/\/(?:exceptions?|issues?)(?:\/|$)/.test(path)) {
      return false;
    }

    return !/\/(?:exceptions?|issues?)\/[^/]+/.test(path);
  }

  function getBestHeading() {
    const headings = Array.from(document.querySelectorAll("h1, h2"))
      .filter(isVisible)
      .map((element) => ({
        element,
        text: normalizeText(element.textContent)
      }))
      .filter((item) => item.text.length > 3);

    if (headings.length === 0) {
      return null;
    }

    const preferred = headings.find((item) =>
      /(exception|issue|error|fatal|stack)/i.test(item.text)
    );

    return preferred || headings[0];
  }

  function getRouteOrUrlFromPage() {
    const candidateSelectors = [
      "a[href^='http://']",
      "a[href^='https://']",
      "code",
      "pre"
    ];

    for (const selector of candidateSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const text = normalizeText(element.textContent);
        if (/^https?:\/\/\S+/i.test(text)) {
          return text;
        }

        if (/^\/[^\s]+/.test(text) && text.length < 300) {
          return text;
        }
      }
    }

    return "";
  }

  function getLabeledValue(patterns) {
    const matchers = patterns.map((pattern) => new RegExp(pattern, "i"));
    const labelSelectors = "dt, th, strong, b, span, div, p, li";
    const labels = Array.from(document.querySelectorAll(labelSelectors)).filter(isVisible);

    for (const labelElement of labels) {
      const labelText = normalizeText(labelElement.textContent).replace(/:$/, "");
      if (!labelText) {
        continue;
      }

      if (!matchers.some((matcher) => matcher.test(labelText))) {
        continue;
      }

      const sibling = labelElement.nextElementSibling;
      if (sibling) {
        const value = normalizeText(sibling.textContent);
        if (value && value.toLowerCase() !== labelText.toLowerCase()) {
          return value;
        }
      }

      const parent = labelElement.parentElement;
      if (parent) {
        const allText = normalizeText(parent.textContent);
        if (allText && allText.toLowerCase() !== labelText.toLowerCase()) {
          const escapedLabel = escapeRegExp(labelText);
          const stripped = normalizeText(
            allText.replace(new RegExp(`^${escapedLabel}\\s*:?\\s*`, "i"), "")
          );
          if (stripped) {
            return stripped;
          }
        }
      }
    }

    return "";
  }

  function getStackSnippet() {
    const blocks = Array.from(document.querySelectorAll("pre, code")).filter(isVisible);

    for (const block of blocks) {
      const raw = (block.textContent || "").replace(/\r/g, "");
      if (!raw || raw.length < 50) {
        continue;
      }

      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length < 2) {
        continue;
      }

      const joined = lines.join("\n");
      if (!/(exception|stack|#\d+| at )/i.test(joined)) {
        continue;
      }

      return lines.slice(0, 8).join("\n").slice(0, 1200);
    }

    return "";
  }

  function getIssueData(issueRef) {
    const heading = getBestHeading();
    const titleFromHeading = heading ? heading.text : "";
    const titleFromDocument = normalizeText(document.title).split("|")[0].trim();

    const title = titleFromHeading || titleFromDocument || `Issue ${issueRef.issueId}`;
    const route = getLabeledValue(["route", "path"]) || getRouteOrUrlFromPage();
    const requestUrl = getLabeledValue(["request url", "url"]) || "";
    const environment = getLabeledValue(["environment", "env", "application"]);
    const firstSeen = getLabeledValue(["first seen", "occurred at", "timestamp", "created"]);
    const lastSeen = getLabeledValue(["last seen", "updated", "updated at"]);
    const severity = getLabeledValue(["severity", "level"]);
    const occurrences = getLabeledValue(["occurrences", "count", "events"]);
    const method = getLabeledValue(["method", "http method", "verb"]);
    const stackSnippet = getStackSnippet();

    return {
      ...issueRef,
      title,
      route,
      requestUrl,
      environment,
      firstSeen,
      lastSeen,
      severity,
      occurrences,
      method,
      stackSnippet
    };
  }

  function buildTodoistDraft(issue) {
    const typeLabel = issue.type === "exception" ? "Exception" : "Issue";
    const issueMarker = issue.issueId ? `[NW:${issue.issueId}]` : "[NW:unknown]";
    const suffixParts = [`${typeLabel}: ${issue.title}`];
    if (issue.environment) {
      suffixParts.push(`(${issue.environment})`);
    }

    const content = truncateText(
      `${TASK_PREFIX} ${issueMarker} ${suffixParts.join(" ")}`,
      TASK_TITLE_MAX_LENGTH
    );

    const lines = [
      `Nightwatch Key: issue:${issue.issueId}`,
      "Source: Laravel Nightwatch",
      `Issue Type: ${issue.type}`,
      `Issue ID: ${issue.issueId}`,
      `Title: ${issue.title}`,
      issue.environment ? `Environment: ${issue.environment}` : "",
      issue.severity ? `Severity: ${issue.severity}` : "",
      issue.method ? `Method: ${issue.method}` : "",
      issue.route ? `Route: ${issue.route}` : "",
      issue.requestUrl ? `Request URL: ${issue.requestUrl}` : "",
      issue.firstSeen ? `First seen: ${issue.firstSeen}` : "",
      issue.lastSeen ? `Last seen: ${issue.lastSeen}` : "",
      issue.occurrences ? `Occurrences: ${issue.occurrences}` : "",
      `Nightwatch Page: ${issue.url}`
    ].filter(Boolean);

    if (issue.stackSnippet) {
      lines.push("", "Stack snippet:", issue.stackSnippet);
    }

    const description = lines.join("\n");
    const url = new URL(DEFAULT_TODOIST_URL);
    url.searchParams.set("content", content);
    url.searchParams.set("description", description);

    return {
      content,
      description,
      url: url.toString()
    };
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({
          ok: false,
          error: "Chrome runtime messaging unavailable."
        });
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: chrome.runtime.lastError.message
            });
            return;
          }

          resolve(response || { ok: false, error: "No response from extension background." });
        });
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  async function getSettings() {
    const now = Date.now();
    if (now - settingsCache.fetchedAt <= SETTINGS_CACHE_TTL_MS) {
      return settingsCache;
    }

    const response = await sendMessage({
      type: "getSettings"
    });

    if (response && response.ok) {
      settingsCache = {
        fetchedAt: now,
        configured: Boolean(response.configured)
      };
    }

    return settingsCache;
  }

  async function getTodoistMatches(issueIds, issueHints) {
    const uniqueIssueIds = Array.from(
      new Set(
        issueIds
          .filter((id) => typeof id === "string")
          .map((id) => id.trim())
          .filter(Boolean)
      )
    ).sort();

    if (uniqueIssueIds.length === 0) {
      return {
        configured: settingsCache.configured,
        matches: {}
      };
    }

    const hintsSignature = uniqueIssueIds
      .map((issueId) => {
        const hint =
          issueHints &&
          typeof issueHints === "object" &&
          issueHints[issueId] &&
          typeof issueHints[issueId].title === "string"
            ? issueHints[issueId].title
            : "";
        return `${issueId}:${hint.slice(0, 120)}`;
      })
      .join("|");
    const signature = `${uniqueIssueIds.join("|")}::${hintsSignature}`;
    const now = Date.now();

    if (signature === matchCache.signature && now - matchCache.fetchedAt <= MATCH_CACHE_TTL_MS) {
      return {
        configured: matchCache.configured,
        matches: matchCache.matches
      };
    }

    const response = await sendMessage({
      type: "findTodoistMatches",
      issueIds: uniqueIssueIds,
      issueHints: issueHints && typeof issueHints === "object" ? issueHints : {}
    });

    if (!response || !response.ok) {
      return {
        configured: settingsCache.configured,
        matches: {}
      };
    }

    const configured = Boolean(response.configured);
    const matches = response.matches && typeof response.matches === "object" ? response.matches : {};

    matchCache = {
      signature,
      fetchedAt: now,
      configured,
      matches
    };

    settingsCache = {
      fetchedAt: now,
      configured
    };

    return {
      configured,
      matches
    };
  }

  function getAnchorElement() {
    const heading = getBestHeading();
    if (heading) {
      return heading.element;
    }

    return document.body;
  }

  function removeDetailUi() {
    const root = document.getElementById(ROOT_ID);
    if (root) {
      root.remove();
    }
  }

  function removeListBadges() {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
  }

  function getIssueMatches(matchMap, issueId) {
    const matches = matchMap && issueId ? matchMap[issueId] : null;
    return Array.isArray(matches) ? matches : [];
  }

  function renderDetailUi(issue, draft, settings, matchMap) {
    const existingMatches = getIssueMatches(matchMap, issue.issueId);
    const anchor = getAnchorElement();
    const existingRoot = document.getElementById(ROOT_ID);

    let root = existingRoot;
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;

      const button = document.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const state = root && root._todoistState ? root._todoistState : null;
        if (!state || !state.draft) {
          return;
        }

        const openDraftInTodoist = () => {
          window.open(state.draft.url, "_blank", "noopener,noreferrer");
          invalidateCaches();
          scheduleRender();
          window.setTimeout(() => {
            invalidateCaches();
            scheduleRender();
          }, 1200);
        };

        if (!state.settingsConfigured) {
          openDraftInTodoist();
          return;
        }

        const statusEl = root.querySelector(`#${STATUS_ID}`);
        if (statusEl instanceof HTMLElement) {
          statusEl.classList.remove("state-warning", "state-good", "state-neutral");
          statusEl.classList.add("state-neutral");
          statusEl.textContent = "Creating task in Todoist...";
        }

        button.disabled = true;
        button.classList.add("is-working");

        const createResponse = await sendMessage({
          type: "createTodoistTask",
          content: state.draft.content,
          description: state.draft.description
        });

        button.classList.remove("is-working");

        if (createResponse && createResponse.ok && createResponse.task && createResponse.task.url) {
          window.open(createResponse.task.url, "_blank", "noopener,noreferrer");
          invalidateCaches();
          scheduleRender();
          window.setTimeout(() => {
            invalidateCaches();
            scheduleRender();
          }, 1200);
          return;
        }

        if (statusEl instanceof HTMLElement) {
          statusEl.classList.remove("state-good", "state-neutral");
          statusEl.classList.add("state-warning");
          statusEl.textContent = "Could not set description through API. Opening Todoist draft page.";
        }

        button.disabled = false;
        openDraftInTodoist();
      });

      const status = document.createElement("span");
      status.id = STATUS_ID;

      const openExisting = document.createElement("a");
      openExisting.id = OPEN_EXISTING_ID;
      openExisting.target = "_blank";
      openExisting.rel = "noopener noreferrer";
      openExisting.hidden = true;

      root.appendChild(button);
      root.appendChild(status);
      root.appendChild(openExisting);

      if (anchor === document.body) {
        root.classList.add("floating");
        document.body.appendChild(root);
      } else {
        anchor.insertAdjacentElement("afterend", root);
      }
    }

    const button = root.querySelector(`#${BUTTON_ID}`);
    const status = root.querySelector(`#${STATUS_ID}`);
    const openExisting = root.querySelector(`#${OPEN_EXISTING_ID}`);

    if (!(button instanceof HTMLButtonElement) || !(status instanceof HTMLElement)) {
      return;
    }

    button.dataset.todoistUrl = draft.url;
    root._todoistState = {
      draft,
      settingsConfigured: Boolean(settings.configured)
    };
    button.textContent = existingMatches.length > 0 ? "Added to Todoist" : "Add to Todoist";
    button.disabled = existingMatches.length > 0;
    button.classList.toggle("is-added", existingMatches.length > 0);
    button.title = `Task title (${draft.content.length}/${TASK_TITLE_MAX_LENGTH} chars): ${draft.content}`;

    status.classList.remove("state-warning", "state-good", "state-neutral");

    if (!settings.configured) {
      status.textContent = "Todoist token missing. Open extension options to enable duplicate checks.";
      status.classList.add("state-warning");
    } else if (existingMatches.length > 0) {
      status.textContent =
        existingMatches.length === 1
          ? "Already in Todoist (1 matching task)."
          : `Already in Todoist (${existingMatches.length} matching tasks).`;
      status.classList.add("state-good");
    } else {
      status.textContent = "No matching Todoist task found yet.";
      status.classList.add("state-neutral");
    }

    if (openExisting instanceof HTMLAnchorElement) {
      if (existingMatches.length > 0 && existingMatches[0].url) {
        openExisting.hidden = false;
        openExisting.href = existingMatches[0].url;
        openExisting.textContent = "Open existing task";
      } else {
        openExisting.hidden = true;
        openExisting.removeAttribute("href");
        openExisting.textContent = "";
      }
    }
  }

  function collectListIssues() {
    const anchors = Array.from(
      document.querySelectorAll("a[href*='/exceptions/'], a[href*='/issues/']")
    );

    const byIssueId = new Map();

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement) || !isVisible(anchor)) {
        continue;
      }

      const issueRef = parseIssueReference(anchor.href || anchor.getAttribute("href") || "");
      if (!issueRef) {
        continue;
      }

      const titleHint = normalizeText(anchor.textContent);
      const existing = byIssueId.get(issueRef.issueId);
      if (existing) {
        if (!existing.titleHint && titleHint) {
          existing.titleHint = titleHint;
        }
        continue;
      }

      byIssueId.set(issueRef.issueId, {
        anchor,
        issueId: issueRef.issueId,
        titleHint
      });
    }

    return Array.from(byIssueId.values());
  }

  function createBadge(matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = BADGE_CLASS;
    button.textContent = `Todoist ${matches.length}`;
    button.title = "Open matching task in Todoist";

    const firstMatch = matches[0];
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (!firstMatch || !firstMatch.url) {
        return;
      }

      window.open(firstMatch.url, "_blank", "noopener,noreferrer");
    });

    return button;
  }

  function renderListBadges(entries, settings, matchMap) {
    removeListBadges();

    if (!settings.configured) {
      return;
    }

    for (const entry of entries) {
      const matches = getIssueMatches(matchMap, entry.issueId);
      if (matches.length === 0) {
        continue;
      }

      const badge = createBadge(matches);
      entry.anchor.insertAdjacentElement("afterend", badge);
    }
  }

  async function render() {
    const nonce = ++renderNonce;

    if (!isNightwatchContext()) {
      removeDetailUi();
      removeListBadges();
      return;
    }

    const settings = await getSettings();
    if (nonce !== renderNonce) {
      return;
    }

    const currentIssue = getCurrentIssueFromLocation();
    const currentIssueData = currentIssue ? getIssueData(currentIssue) : null;
    const listEntries = isIssueListLikePath() ? collectListIssues() : [];

    const issueIds = [];
    const issueHints = {};
    if (currentIssueData && currentIssueData.issueId) {
      issueIds.push(currentIssueData.issueId);
      issueHints[currentIssueData.issueId] = {
        title: currentIssueData.title
      };
    }
    for (const entry of listEntries) {
      issueIds.push(entry.issueId);
      if (entry.titleHint) {
        issueHints[entry.issueId] = {
          title: entry.titleHint
        };
      }
    }

    const { configured, matches } = await getTodoistMatches(issueIds, issueHints);
    if (nonce !== renderNonce) {
      return;
    }

    const effectiveSettings = {
      configured: settings.configured || configured
    };

    if (currentIssueData) {
      const draft = buildTodoistDraft(currentIssueData);
      renderDetailUi(currentIssueData, draft, effectiveSettings, matches);
    } else {
      removeDetailUi();
    }

    if (isIssueListLikePath() && listEntries.length > 0) {
      renderListBadges(listEntries, effectiveSettings, matches);
    } else {
      removeListBadges();
    }
  }

  function scheduleRender() {
    if (renderScheduled) {
      return;
    }

    renderScheduled = true;
    window.setTimeout(() => {
      renderScheduled = false;
      void render();
    }, 150);
  }

  function watchForUrlChanges() {
    window.setInterval(() => {
      if (location.href === lastHref) {
        return;
      }

      lastHref = location.href;
      scheduleRender();
    }, 500);
  }

  function init() {
    const observer = new MutationObserver(() => {
      scheduleRender();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener("popstate", scheduleRender);
    window.addEventListener("hashchange", scheduleRender);
    window.addEventListener("focus", () => {
      invalidateCaches();
      scheduleRender();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        invalidateCaches();
        scheduleRender();
      }
    });

    watchForUrlChanges();
    void render();
  }

  init();
})();
