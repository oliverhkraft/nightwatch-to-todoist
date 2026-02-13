# Nightwatch to Todoist Chrome Extension

This extension injects Todoist helpers into Laravel Nightwatch pages.

## Features

- Detail page action:
  - Adds an `Add to Todoist` button on `/exceptions/<id>` and `/issues/<id>`.
  - With API token configured: creates the task via Todoist API (description is preserved), then opens the created task.
  - Without API token: opens Todoist add-task page (`https://todoist.com/add`) with prefilled title.
  - Button color is bright red when not yet matched in Todoist and turns green when an existing Todoist task is detected.
- Task title guardrail:
  - Caps Todoist `content` at 120 characters.
- Rich description metadata:
  - Includes issue key, issue ID, type, title, environment, severity, method, route/URL, seen timestamps, and current Nightwatch page URL.
  - Includes a short stack snippet when available.
- Duplicate awareness:
  - On detail page, shows whether matching Todoist task(s) already exist.
  - On list pages, shows per-issue badges (`Todoist N`) for existing matches.

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select:
   - `{REPO_ROOT}/nightwatch-chrome-plugin`

## Configure Todoist token

1. In `chrome://extensions`, open this extension details.
2. Click `Extension options`.
3. Paste Todoist API token and save.
4. Optional: click `Test connection`.

Without a token, add-task still works, but duplicate detection is disabled.

## Matching strategy

Duplicate detection matches active Todoist tasks by metadata markers in task text:

- `[NW:<issue-id>]` marker in task title
- `Nightwatch Key: issue:<id>`
- `Issue ID: <id>`

Todoist API requests use `https://api.todoist.com/api/v1/*`.

## Files

- `/Users/ohk-mini/dev/nightwatch-chrome-plugin/manifest.json`
- `/Users/ohk-mini/dev/nightwatch-chrome-plugin/background.js`
- `/Users/ohk-mini/dev/nightwatch-chrome-plugin/content.js`
- `/Users/ohk-mini/dev/nightwatch-chrome-plugin/content.css`
- `/Users/ohk-mini/dev/nightwatch-chrome-plugin/options.html`
- `/Users/ohk-mini/dev/nightwatch-chrome-plugin/options.css`
- `/Users/ohk-mini/dev/nightwatch-chrome-plugin/options.js`
