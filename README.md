# Handoff Pack Builder

**Live tool: https://www.ensohq.ai/tools/handoff-pack-builder**

![Handoff brief built from the synthetic demo data](https://raw.githubusercontent.com/Nodestarllc/enso-handoff-pack-builder/main/docs/screenshot.png)

A focused, browser-based operations utility for engineering managers, operations leads, and project owners to assemble audit-ready handoff briefs, identify unresolved decisions, flag unowned tasks, and surface blocked dependencies.

## Problem

Project handoffs fail when context is scattered across meetings, pull requests, Slack threads, and fragmented trackers:
1. **Unresolved decisions**: Critical architectural or operational choices remain "under review" without a decision deadline.
2. **Missing ownership & dates**: Action items lack an assigned owner or due date, causing them to fall through the cracks post-handoff.
3. **Broken dependencies**: Downstream tasks stall because their prerequisite actions or decisions were never completed.
4. **Invented context**: Many AI tools fabricate decisions or owners when inputs are ambiguous.

## How It Works

1. **Input Decisions & Actions**: Upload a CSV export from your tracker (Linear-style, Jira-style and Asana-style headers are recognised) or click "Load Synthetic Demo Data" to explore immediately. Header names are matched exactly, case and punctuation aside. Dependencies are read from `Blocked By`, `Depends On`, `Dependencies`, `Blockers`, `Predecessors`, `Prerequisites`, `Deps`, Asana's `Blocked By (Dependencies)` and Jira's `Inward issue link (Blocks)` (repeated columns are merged, and the same blocker named twice counts once). Columns that point the other way (`Outward issue link (Blocks)`, `Blocks`, `Blocking`) are inverted into "blocked by" on the listed items. Asana exports have no Status column, so `Completed At` marks a task finished. `Parent` columns describe hierarchy, not blockers, so they are reported as unused. Every column that was not used is listed in the results and in the brief, and a file with no dependency column says so instead of reporting zero blocked.
2. **Deterministic Processing**: The engine processes decisions, action items, assignees, deadlines, and dependencies locally without external LLM calls or hallucinations.
3. **Strict Accountability**: Never invents owners or decisions. Unassigned items are explicitly called out as `[Unknown Owner]`.
4. **Dependency Resolution**: Audits every stated dependency. Flags missing prerequisite IDs and incomplete blockers.
5. **Audit-Ready Markdown Brief**: Generates a structured brief with executive summary, decision logs with provenance links, blocked dependencies, and checklist tables.
6. **Safe CSV Export**: Exports action audits with formula injection defenses (prefixes cells starting with `=, +, -, @` with single quotes).

## Privacy and local processing

CSV parsing, handoff analysis, Markdown generation and downloads run in your browser. Project notes, source links, task titles and team member names are not sent to Enso. Brief generation and downloads work offline. On ensohq.ai, the optional form submits only a consented email and campaign tags to the owned `/api/tools/handoff-lead` endpoint. Enso stores that capture and sends an inbox notification and visitor confirmation. The form is hidden in standalone copies. The brief is not submitted or emailed.

## Architecture

- `index.html`: Lightweight, responsive single-page web app styled with Enso's visual identity (`#2C5530`).
- `logic.js`: Universal JavaScript engine (browser and Node.js compatible).
- `test.js`: Automated test suite covering edge cases and failure modes.
- `demo-data.csv`: Synthetic demo dataset for testing.
- `fixtures/`: Linear-style export used by the regression tests.

The canonical source is `growth-ops/magnets/handoff-pack-builder`. The Enso marketing site generates its hosted copy with `scripts/sync-tool.mjs`; `pnpm tools:check` detects drift. The [public repository](https://github.com/Nodestarllc/enso-handoff-pack-builder) mirrors the source.

## How to Run

Open `index.html` in a browser with `logic.js` beside it, or use the live tool above. Click "Load Synthetic Demo Data" to see a brief without uploading a file. Copy or download the Markdown brief when it is ready.

## Running Tests

Run the test suite using Node.js 18 or later. No dependencies are required:

```bash
node test.js
```

## Commercial Integration

This lead magnet generates point-in-time handoff briefs. For organizations requiring continuous, automated cross-tool context across meetings, PRs, trackers, and team messaging, visit [ensohq.ai](https://www.ensohq.ai/?utm_source=tool&utm_medium=lead-magnet&utm_campaign=handoff-pack-builder&utm_content=readme).

## License

MIT (c) 2026 Enso. See [LICENSE](LICENSE) for details.
