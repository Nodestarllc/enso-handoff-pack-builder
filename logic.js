/**
 * Handoff Pack Builder: Core Engine (Enso)
 * Deterministic local processing. Zero external dependencies.
 * Parses structured handoff inputs (decisions, actions, owners, dates, dependencies, source links),
 * preserves provenance, identifies unresolved decisions, missing owners/dates, and unresolved dependencies,
 * and compiles Markdown/HTML handoff briefs and safe action CSV exports.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.HandoffEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Standard RFC4180 CSV parser
  function parseCSV(text) {
    if (typeof text !== 'string') return [];
    var row = [''], rows = [row], inQuote = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuote) {
        if (c === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            row[row.length - 1] += '"';
            i++;
          } else {
            inQuote = false;
          }
        } else {
          row[row.length - 1] += c;
        }
      } else {
        if (c === '"') {
          inQuote = true;
        } else if (c === ',') {
          row.push('');
        } else if (c === '\r') {
          if (i + 1 < text.length && text[i + 1] === '\n') {
            i++;
          }
          row = [''];
          rows.push(row);
        } else if (c === '\n') {
          row = [''];
          rows.push(row);
        } else {
          row[row.length - 1] += c;
        }
      }
    }
    while (rows.length > 0) {
      var last = rows[rows.length - 1];
      var allBlank = true;
      for (var k = 0; k < last.length; k++) {
        if (last[k].trim() !== '') {
          allBlank = false;
          break;
        }
      }
      if (allBlank) rows.pop();
      else break;
    }
    return rows;
  }

  // Safe CSV cell sanitizer against formula injection
  function sanitizeForCSV(val) {
    if (val === null || val === undefined) return '';
    var str = String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
      return "'" + str;
    }
    return str;
  }

  function exportSafeCSV(headers, rows) {
    var out = [];
    var headerRow = headers.map(function (h) {
      return '"' + String(h).replace(/"/g, '""') + '"';
    }).join(',');
    out.push(headerRow);

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cells = [];
      for (var j = 0; j < headers.length; j++) {
        var h = headers[j];
        var val = row[h];
        if (val === null || val === undefined) val = '';
        var safeVal = sanitizeForCSV(val);
        var escaped = String(safeVal).replace(/"/g, '""');
        cells.push('"' + escaped + '"');
      }
      out.push(cells.join(','));
    }
    return out.join('\r\n');
  }

  // Parse calendar date safely in UTC
  function parseDateSafe(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    var trimmed = dateStr.trim();
    if (!trimmed) return null;

    var isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
    if (isoMatch) {
      var y = parseInt(isoMatch[1], 10);
      var m = parseInt(isoMatch[2], 10) - 1;
      var d = parseInt(isoMatch[3], 10);
      var dt = new Date(Date.UTC(y, m, d));
      if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d) {
        return dt;
      }
      return null;
    }

    var usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
    if (usMatch) {
      var y2 = parseInt(usMatch[3], 10);
      var m2 = parseInt(usMatch[1], 10) - 1;
      var d2 = parseInt(usMatch[2], 10);
      var dt2 = new Date(Date.UTC(y2, m2, d2));
      if (dt2.getUTCFullYear() === y2 && dt2.getUTCMonth() === m2 && dt2.getUTCDate() === d2) {
        return dt2;
      }
      return null;
    }

    var ts = Date.parse(trimmed);
    if (isNaN(ts)) return null;
    return new Date(ts);
  }

  // Only http and https Source Links may render as links. Everything else stays text.
  function safeWebUrl(value) {
    if (typeof value !== 'string') return '';
    var trimmed = value.trim();
    if (!trimmed) return '';
    var url;
    try {
      url = new URL(trimmed);
    } catch {
      return '';
    }
    var isWeb = url.protocol === 'http:' || url.protocol === 'https:';
    // user:pass@host links disguise the real host, so they stay text too.
    return isWeb && !url.username && !url.password ? url.href : '';
  }

  // Tracker export header names, matched exactly after normalisation so look-alikes
  // ("Created", "Start Date", "Lead Time") cannot hijack a field. Aliases are listed in
  // order of preference: the first alias present in the file wins.
  var FIELD_ALIASES = {
    type: ['type', 'item type', 'issue type', 'issuetype', 'kind'],
    id: ['id', 'issue key', 'key', 'ticket key', 'identifier', 'task id', 'ticket id', 'ticket', 'issue id'],
    title: ['title', 'issue title', 'task title', 'name', 'summary', 'task name', 'task', 'issue', 'subject', 'description'],
    owner: ['owner', 'owner s', 'owners', 'assignee', 'assigned to', 'assigned', 'assignee name', 'dri', 'responsible', 'lead'],
    dueDate: ['due date', 'due date utc', 'due', 'due at', 'due by', 'deadline', 'target date', 'due on'],
    status: ['status', 'current status', 'issue status', 'state'],
    sourceLink: ['source link', 'source links', 'source url', 'source', 'evidence link', 'link', 'url'],
    sourceExcerpt: ['source excerpt', 'excerpt', 'source quote', 'quote']
  };

  // Every header in this list counts as a dependency column, and all of them are read:
  // Jira repeats one header per linked issue, Asana adds "(Dependencies)".
  // "Parent" columns are hierarchy, not blockers, so they are reported as unused.
  // The columns in BLOCKS_ALIASES point the other way (this row blocks those items) and
  // are inverted into dependencies of the listed items.
  var DEPENDENCY_ALIASES = [
    'blocked by', 'blocked by dependencies', 'depends on', 'depends', 'dependent on', 'dependencies', 'dependency', 'deps',
    'blockers', 'blocker', 'predecessors', 'predecessor', 'prerequisites', 'prerequisite',
    'inward issue link blocks'
  ];

  var BLOCKS_ALIASES = ['blocks', 'blocking', 'blocking dependencies', 'outward issue link blocks'];

  function normalizeHeader(h) {
    return String(h === null || h === undefined ? '' : h)
      .replace(/^﻿/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function mapColumns(headerRow) {
    var cells = (headerRow || []).map(function (h) { return String(h === null || h === undefined ? '' : h).replace(/^﻿/, '').trim(); });
    var norm = cells.map(normalizeHeader);
    var fields = {};
    var used = {};

    Object.keys(FIELD_ALIASES).forEach(function (field) {
      var aliases = FIELD_ALIASES[field];
      for (var a = 0; a < aliases.length && fields[field] === undefined; a++) {
        var idx = norm.indexOf(aliases[a]);
        if (idx !== -1) {
          fields[field] = idx;
          used[idx] = true;
        }
      }
    });

    if (fields.status === undefined) {
      var completedIdx = norm.indexOf('completed at');
      if (completedIdx !== -1) {
        fields.completedAt = completedIdx;
        used[completedIdx] = true;
      }
    }

    fields.blocks = [];
    fields.dependencies = [];
    norm.forEach(function (h, idx) {
      if (BLOCKS_ALIASES.indexOf(h) !== -1) {
        fields.blocks.push(idx);
        used[idx] = true;
        return;
      }
      if (DEPENDENCY_ALIASES.indexOf(h) !== -1) {
        fields.dependencies.push(idx);
        used[idx] = true;
      }
    });

    var ignored = [];
    cells.forEach(function (text, idx) {
      if (text && !used[idx]) ignored.push(text);
    });

    return { fields: fields, ignored: ignored, hasDependencyColumn: fields.dependencies.length > 0 || fields.blocks.length > 0 };
  }

  // Turn parsed CSV rows (header first) into raw items plus a report of what was read.
  function itemsFromRows(rows) {
    if (!rows || rows.length < 1) return { items: [], ignoredColumns: [], hasDependencyColumn: false };
    var map = mapColumns(rows[0]);
    var f = map.fields;
    function cell(row, idx) {
      return idx !== undefined && row[idx] !== undefined ? row[idx] : '';
    }
    // Asana has no Status column; a task is finished when "Completed At" has a value.
    var items = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var deps = f.dependencies.map(function (idx) { return cell(r, idx).trim(); }).filter(Boolean).join('; ');
      items.push({
        type: cell(r, f.type),
        id: cell(r, f.id),
        title: cell(r, f.title),
        owner: cell(r, f.owner),
        dueDate: cell(r, f.dueDate),
        status: f.status === undefined && f.completedAt !== undefined ? (cell(r, f.completedAt).trim() ? 'Completed' : 'Open') : cell(r, f.status),
        dependencies: deps,
        sourceLink: cell(r, f.sourceLink),
        sourceExcerpt: cell(r, f.sourceExcerpt),
        rowIndex: i + 1
      });
    }

    // "A blocks B" in A's row is "B is blocked by A".
    var byId = {};
    items.forEach(function (item) {
      if (item.id && !byId[item.id.toLowerCase()]) byId[item.id.toLowerCase()] = item;
    });
    for (var b = 0; b < items.length; b++) {
      var blocker = items[b];
      if (!blocker.id) continue;
      f.blocks.forEach(function (idx) {
        parseDependencyRefs(cell(rows[b + 1], idx)).forEach(function (ref) {
          var blocked = byId[ref.toLowerCase()];
          if (blocked && blocked !== blocker) blocked.dependencies = [blocked.dependencies, blocker.id].filter(Boolean).join('; ');
        });
      });
    }

    return { items: items, ignoredColumns: map.ignored, hasDependencyColumn: map.hasDependencyColumn };
  }

  // A dependency cell holds IDs separated by commas, semicolons, newlines or spaces.
  // Spaces only split when every piece looks like an ID; otherwise the cell is a title.
  var ID_LIKE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
  var NO_DEPENDENCY = /^(none|n\/a|na|tbd|nil|null|-+)$/i;
  function parseDependencyRefs(raw) {
    var refs = [];
    function add(ref) {
      var seen = refs.some(function (r) { return r.toLowerCase() === ref.toLowerCase(); });
      if (!seen) refs.push(ref);
    }
    String(raw || '').split(/[,;\n\r|]+/).forEach(function (piece) {
      var ref = piece.trim();
      if (!ref || NO_DEPENDENCY.test(ref)) return;
      var words = ref.split(/\s+/);
      if (words.length > 1 && words.every(function (w) { return ID_LIKE.test(w); })) {
        words.forEach(add);
      } else {
        add(ref);
      }
    });
    return refs;
  }

  var COMPLETED_ACTION_STATUSES = ['done', 'completed', 'resolved', 'closed', 'verified'];
  var RESOLVED_DECISION_STATUSES = ['decided', 'approved', 'resolved', 'agreed', 'closed'];

  function isActionCompleted(status) {
    if (!status) return false;
    return COMPLETED_ACTION_STATUSES.indexOf(String(status).trim().toLowerCase()) !== -1;
  }

  function isDecisionResolved(status) {
    if (!status) return false;
    return RESOLVED_DECISION_STATUSES.indexOf(String(status).trim().toLowerCase()) !== -1;
  }

  /**
   * Process raw items (from CSV or structured array)
   * Each item may have:
   * - type: 'action' | 'decision' | 'note'
   * - id: string
   * - title / description: string
   * - owner: string (if empty: NEVER invent an owner, mark as "[Unknown Owner]")
   * - dueDate: string
   * - status: string
   * - dependencies: string (comma-separated IDs)
   * - sourceLink / sourceExcerpt: string
   */
  function processHandoffData(items, options) {
    options = options || {};
    var refDate = options.referenceDate ? new Date(options.referenceDate) : new Date();
    var refDateUTC = Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate());

    var decisions = [];
    var actions = [];
    var actionMap = {};
    var decisionMap = {};
    var validationIssues = [];
    var seenSourceLinks = {};
    var duplicateSourceLinks = [];

    // Pass 1: Parse and normalize items
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var rawType = it.type ? String(it.type).trim().toLowerCase() : '';
      var rawId = it.id ? String(it.id).trim() : '';
      var rawTitle = it.title !== undefined && it.title !== null ? String(it.title).trim() : (it.description ? String(it.description).trim() : '');
      var rawOwner = it.owner !== undefined && it.owner !== null ? String(it.owner).trim() : '';
      var rawDueDate = it.dueDate !== undefined && it.dueDate !== null ? String(it.dueDate).trim() : '';
      var rawStatus = it.status !== undefined && it.status !== null ? String(it.status).trim() : '';
      var rawDeps = it.dependencies !== undefined && it.dependencies !== null ? String(it.dependencies).trim() : '';
      var rawSource = it.sourceLink !== undefined && it.sourceLink !== null ? String(it.sourceLink).trim() : (it.source ? String(it.source).trim() : '');
      var sourceExcerpt = it.sourceExcerpt !== undefined && it.sourceExcerpt !== null ? String(it.sourceExcerpt).trim() : '';

      var rowNum = it.rowIndex || (i + 1);

      // Duplicate source link detection
      if (rawSource) {
        var normLink = rawSource.toLowerCase();
        if (seenSourceLinks[normLink]) {
          seenSourceLinks[normLink].count++;
          seenSourceLinks[normLink].items.push(rawId || ('Row ' + rowNum));
          duplicateSourceLinks.push({ link: rawSource, item1: seenSourceLinks[normLink].firstId, item2: rawId || ('Row ' + rowNum) });
        } else {
          seenSourceLinks[normLink] = { count: 1, firstId: rawId || ('Row ' + rowNum), items: [rawId || ('Row ' + rowNum)] };
        }
      }

      // Infer type if unspecified
      var itemType = 'action';
      if (rawType === 'decision' || (!rawType && rawId.toLowerCase().startsWith('dec-'))) {
        itemType = 'decision';
      } else if (rawType === 'action' || (!rawType && rawId.toLowerCase().startsWith('act-'))) {
        itemType = 'action';
      } else if (rawType) {
        itemType = rawType;
      }

      var parsedDueDate = parseDateSafe(rawDueDate);
      var isDateInvalid = rawDueDate !== '' && parsedDueDate === null;
      if (isDateInvalid) {
        validationIssues.push({
          row: rowNum,
          id: rawId,
          type: 'invalid_date',
          message: 'Invalid date format: "' + rawDueDate + '"'
        });
      }

      // Owner check: Never invent an owner! Mark explicitly as Unknown
      var hasOwner = rawOwner !== '' && rawOwner.toLowerCase() !== 'unassigned' && rawOwner.toLowerCase() !== 'unknown';
      var displayOwner = hasOwner ? rawOwner : '[Unknown Owner]';

      // Parse dependencies
      var parsedDepsList = parseDependencyRefs(rawDeps);

      var normalizedItem = {
        id: rawId || ('ITEM-' + (i + 1)),
        hasOriginalId: !!rawId,
        title: rawTitle || '[No Title Specified]',
        owner: displayOwner,
        rawOwner: rawOwner,
        hasOwner: hasOwner,
        dueDate: rawDueDate || '[No Date Specified]',
        parsedDueDate: parsedDueDate,
        isDateInvalid: isDateInvalid,
        hasDueDate: !!parsedDueDate,
        status: rawStatus || 'Open',
        dependencies: parsedDepsList,
        rawDependencies: rawDeps,
        sourceLink: rawSource,
        sourceUrl: safeWebUrl(rawSource),
        sourceExcerpt: sourceExcerpt,
        rowIndex: rowNum
      };

      if (itemType === 'decision') {
        var isResolved = isDecisionResolved(rawStatus);
        normalizedItem.isResolved = isResolved;

        // Check for contradictory decision IDs
        if (rawId && decisionMap[rawId]) {
          validationIssues.push({
            row: rowNum,
            id: rawId,
            type: 'contradictory_id',
            message: 'Duplicate/contradictory decision ID: ' + rawId
          });
        } else if (rawId) {
          decisionMap[rawId] = normalizedItem;
        }
        decisions.push(normalizedItem);
      } else {
        var isComplete = isActionCompleted(rawStatus);
        normalizedItem.isComplete = isComplete;

        // Overdue check
        var isOverdue = false;
        var daysOverdue = 0;
        if (!isComplete && parsedDueDate) {
          var dueUTC = Date.UTC(parsedDueDate.getUTCFullYear(), parsedDueDate.getUTCMonth(), parsedDueDate.getUTCDate());
          if (dueUTC < refDateUTC) {
            isOverdue = true;
            daysOverdue = Math.floor((refDateUTC - dueUTC) / (1000 * 60 * 60 * 24));
          }
        }
        normalizedItem.isOverdue = isOverdue;
        normalizedItem.daysOverdue = daysOverdue;

        // Check for contradictory action IDs
        if (rawId && actionMap[rawId]) {
          validationIssues.push({
            row: rowNum,
            id: rawId,
            type: 'contradictory_id',
            message: 'Contradictory duplicate action ID: ' + rawId
          });
        } else if (rawId) {
          actionMap[rawId] = normalizedItem;
        }
        actions.push(normalizedItem);
      }
    }

    // Pass 2: Dependency Resolution Check
    // Verify each dependency of every action and decision: does it exist, and is it done?
    var unresolvedDependenciesList = [];
    var blockable = actions.concat(decisions);

    // A reference is an ID (case-insensitive) or, for exports that name blockers by
    // title (Asana), an exact unique title. An ambiguous title stays unresolved.
    var idIndex = {};
    var titleIndex = {};
    blockable.forEach(function (item) {
      var idKey = item.id.toLowerCase();
      if (item.hasOriginalId && !idIndex[idKey]) idIndex[idKey] = item;
      var titleKey = item.title.toLowerCase();
      titleIndex[titleKey] = Object.prototype.hasOwnProperty.call(titleIndex, titleKey) ? null : item;
    });
    function resolveRef(ref) {
      var key = ref.toLowerCase();
      if (idIndex[key]) return idIndex[key];
      return Object.prototype.hasOwnProperty.call(titleIndex, key) ? titleIndex[key] : null;
    }

    for (var a = 0; a < blockable.length; a++) {
      var act = blockable[a];
      act.unresolvedDeps = [];
      act.missingDeps = [];

      // A whole cell can be one title that contains commas ("Fix login, then deploy").
      var wholeCell = act.rawDependencies;
      if (wholeCell && act.dependencies.length > 1 && resolveRef(wholeCell)) act.dependencies = [wholeCell];

      for (var d = 0; d < act.dependencies.length; d++) {
        var depId = act.dependencies[d];
        var target = resolveRef(depId);
        if (target === act) continue;
        var kind = act.isResolved === undefined ? 'Action' : 'Decision';

        if (!target) {
          act.missingDeps.push(depId);
          unresolvedDependenciesList.push({
            actionId: act.id,
            actionTitle: act.title,
            dependencyId: depId,
            reason: 'Dependency ID not found in input dataset'
          });
          validationIssues.push({
            id: act.id,
            type: 'missing_dependency',
            message: kind + ' ' + act.id + ' depends on non-existent ID: ' + depId
          });
        } else if (target.isResolved === undefined && !target.isComplete) {
          act.unresolvedDeps.push(depId);
          unresolvedDependenciesList.push({
            actionId: act.id,
            actionTitle: act.title,
            dependencyId: depId,
            dependencyTitle: target.title,
            dependencyStatus: target.status,
            reason: 'Blocking action is incomplete (' + target.status + ')'
          });
        } else if (target.isResolved === false) {
          act.unresolvedDeps.push(depId);
          unresolvedDependenciesList.push({
            actionId: act.id,
            actionTitle: act.title,
            dependencyId: depId,
            dependencyTitle: target.title,
            dependencyStatus: target.status,
            reason: 'Blocking decision is unresolved (' + target.status + ')'
          });
        }
      }
    }

    // Pass 3: Extract Missing Owners and Dates list
    var missingOwnerOrDateActions = actions.filter(function (act) {
      return !act.hasOwner || !act.hasDueDate;
    });

    var unresolvedDecisions = decisions.filter(function (dec) {
      return !dec.isResolved;
    });

    return {
      decisions: decisions,
      actions: actions,
      unresolvedDecisions: unresolvedDecisions,
      missingOwnerOrDateActions: missingOwnerOrDateActions,
      unresolvedDependencies: unresolvedDependenciesList,
      duplicateSourceLinks: duplicateSourceLinks,
      validationIssues: validationIssues,
      ignoredColumns: options.ignoredColumns || [],
      hasDependencyColumn: options.hasDependencyColumn !== false,
      summary: {
        totalItems: items.length,
        totalActions: actions.length,
        completedActions: actions.filter(function (a) { return a.isComplete; }).length,
        openActions: actions.filter(function (a) { return !a.isComplete; }).length,
        overdueActions: actions.filter(function (a) { return a.isOverdue; }).length,
        missingOwnersCount: actions.filter(function (a) { return !a.hasOwner; }).length,
        missingDatesCount: actions.filter(function (a) { return !a.hasDueDate; }).length,
        totalDecisions: decisions.length,
        resolvedDecisionsCount: decisions.filter(function (d) { return d.isResolved; }).length,
        unresolvedDecisionsCount: unresolvedDecisions.length,
        unresolvedDependenciesCount: unresolvedDependenciesList.length
      }
    };
  }

  // Markdown link targets must not be able to close the link early.
  function escapeMarkdownUrl(url) {
    return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  // Text from the CSV is data, never markup: one line, no link or autolink syntax.
  function mdInline(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\]\(/g, ']\\(')
      .replace(/[<>]/g, '\\$&')
      .replace(/`/g, "'");
  }

  // A web link renders as [label](url); any other Source Link is shown as plain text.
  function sourceMarkdown(item, label) {
    if (item.sourceUrl) return '[' + label + '](' + escapeMarkdownUrl(item.sourceUrl) + ')';
    if (item.sourceLink) return 'Source (not a web link): `' + mdInline(item.sourceLink) + '`';
    return '';
  }

  // Generate clean Markdown handoff brief
  function generateMarkdownBrief(handoffResult, title) {
    var projectTitle = String(title || '').replace(/\s+/g, ' ').trim() || 'Operational Project Handoff Brief';
    var md = [];
    var sectionNumber = 0;
    function section(name) {
      sectionNumber++;
      md.push('## ' + sectionNumber + '. ' + name);
      md.push('');
    }

    md.push('# ' + projectTitle);
    md.push('');
    md.push('*Generated via Enso Handoff Pack Builder. Deterministic local brief.*');
    md.push('');

    // Executive Summary
    section('Executive Summary & Readiness');
    var s = handoffResult.summary;
    md.push('- **Open Actions:** ' + s.openActions + ' of ' + s.totalActions + ' (' + s.overdueActions + ' overdue)');
    md.push('- **Unresolved Decisions:** ' + s.unresolvedDecisionsCount + ' of ' + s.totalDecisions);
    md.push('- **Actions Missing Owner or Due Date:** ' + handoffResult.missingOwnerOrDateActions.length);
    md.push('- **Blocked / Unresolved Dependencies:** ' + s.unresolvedDependenciesCount);
    if (handoffResult.hasDependencyColumn === false) {
      md.push('- **Dependencies:** no dependency column found, so blocked work cannot be detected. Add a "Blocked By" or "Depends On" column and rebuild.');
    }
    if (handoffResult.ignoredColumns && handoffResult.ignoredColumns.length > 0) {
      md.push('- **Input columns not used:** ' + handoffResult.ignoredColumns.map(mdInline).join(', '));
    }
    md.push('');

    // Unresolved Decisions
    section('Unresolved Decisions');
    if (s.totalDecisions === 0) {
      md.push('No decisions were recorded in this file.');
    } else if (handoffResult.unresolvedDecisions.length === 0) {
      md.push(s.totalDecisions === 1
        ? 'The 1 decision in this file is marked resolved.'
        : 'All ' + s.totalDecisions + ' decisions in this file are marked resolved.');
    } else {
      for (var d = 0; d < handoffResult.unresolvedDecisions.length; d++) {
        var dec = handoffResult.unresolvedDecisions[d];
        md.push('### ' + mdInline(dec.id) + ': ' + mdInline(dec.title));
        md.push('- **Status:** ' + mdInline(dec.status));
        md.push('- **Owner:** ' + mdInline(dec.owner));
        md.push('- **Target Date:** ' + mdInline(dec.dueDate));
        if (dec.sourceExcerpt) md.push('- **Excerpt:** "' + mdInline(dec.sourceExcerpt) + '"');
        if (dec.sourceLink) md.push('- **Provenance:** ' + (dec.sourceUrl || sourceMarkdown(dec)));
        md.push('');
      }
    }
    md.push('');

    // Full Decision Log (Provenance & Rationale)
    if (handoffResult.decisions.length > 0) {
      section('Decision Log & Provenance');
      for (var dl = 0; dl < handoffResult.decisions.length; dl++) {
        var dItem = handoffResult.decisions[dl];
        var dSource = sourceMarkdown(dItem, 'Source');
        var statusBadge = dItem.isResolved ? '[RESOLVED]' : '[OPEN]';
        md.push('- **' + mdInline(dItem.id) + '** ' + statusBadge + ': ' + mdInline(dItem.title) + (dSource ? ' (' + dSource + ')' : ''));
        md.push('  - Owner: ' + mdInline(dItem.owner) + ' | Status: ' + mdInline(dItem.status) + ' | Date: ' + mdInline(dItem.dueDate));
        if (dItem.sourceExcerpt) md.push('  - Excerpt: "' + mdInline(dItem.sourceExcerpt) + '"');
      }
      md.push('');
    }

    // Blocked Dependencies
    if (handoffResult.unresolvedDependencies.length > 0) {
      section('Blocked Dependencies');
      for (var u = 0; u < handoffResult.unresolvedDependencies.length; u++) {
        var dep = handoffResult.unresolvedDependencies[u];
        md.push('- **' + mdInline(dep.actionId) + '** (' + mdInline(dep.actionTitle) + ') is blocked on **' + mdInline(dep.dependencyId) + '**: ' + mdInline(dep.reason));
      }
      md.push('');
    }

    // Owner / Due Date Action Checklist
    section('Action Ownership & Due Date Checklist');
    if (handoffResult.actions.length === 0) {
      md.push('No actions recorded.');
    } else {
      for (var a = 0; a < handoffResult.actions.length; a++) {
        var act = handoffResult.actions[a];
        var checkbox = act.isComplete ? '[x]' : '[ ]';
        var flag = act.isOverdue ? ' **[OVERDUE]**' : '';
        var unknownWarn = (!act.hasOwner || !act.hasDueDate) ? ' *(Needs Assignment/Date)*' : '';
        var src = sourceMarkdown(act, 'link');
        md.push('- ' + checkbox + ' **' + mdInline(act.id) + '**: ' + mdInline(act.title) + flag + unknownWarn);
        md.push('  - Owner: ' + mdInline(act.owner) + ' | Due: ' + mdInline(act.dueDate) + ' | Status: ' + mdInline(act.status) + (src ? ' | ' + src : ''));
      }
    }
    md.push('');

    // Missing Ownership / Dates Callout
    if (handoffResult.missingOwnerOrDateActions.length > 0) {
      section('Items Requiring Immediate Assignment');
      md.push('The following items are missing an explicit owner or deadline and must be assigned:');
      md.push('');
      for (var m = 0; m < handoffResult.missingOwnerOrDateActions.length; m++) {
        var miss = handoffResult.missingOwnerOrDateActions[m];
        var issues = [];
        if (!miss.hasOwner) issues.push('Unknown Owner');
        if (!miss.hasDueDate) issues.push('No Due Date');
        md.push('- **' + mdInline(miss.id) + '**: ' + mdInline(miss.title) + ' *(' + issues.join(', ') + ')*');
      }
      md.push('');
    }

    return md.join('\n');
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Table cell for a Source Link: a link only for http and https, text for anything else.
  function sourceCellHtml(item, label) {
    if (item.sourceUrl) {
      return '<a href="' + escapeHtml(item.sourceUrl) + '" target="_blank" rel="noopener noreferrer" style="color:#72b37a;">' + escapeHtml(label || item.sourceUrl) + '</a>';
    }
    if (item.sourceLink) {
      return '<span style="color:#95a396;" title="Not a web link, so it is not clickable">' + escapeHtml(item.sourceLink) + '</span>';
    }
    return '<span style="color:#6b7f6e;">None</span>';
  }

  // Notice shown above the results when the input was only partly understood.
  function inputNotesHtml(handoffResult) {
    var lines = [];
    if (handoffResult.hasDependencyColumn === false) {
      lines.push('<p><strong>No dependency column found.</strong> Blocked work cannot be detected. Add a "Blocked By" or "Depends On" column and rebuild.</p>');
    }
    if (handoffResult.ignoredColumns && handoffResult.ignoredColumns.length > 0) {
      lines.push('<p><strong>Columns not used:</strong> ' + handoffResult.ignoredColumns.map(escapeHtml).join(', ') + '</p>');
    }
    return lines.join('');
  }

  // Export clean CSV of actions with missing ownership, dates or references
  function exportGapsCSV(handoffResult) {
    var headers = ['Action_ID', 'Title', 'Owner', 'Due_Date', 'Status', 'Dependencies', 'Source_Link', 'Issue_Flags'];
    var rows = handoffResult.actions.map(function (act) {
      var issues = [];
      if (!act.hasOwner) issues.push('Missing Owner');
      if (!act.hasDueDate) issues.push('Missing Due Date');
      if (act.isOverdue) issues.push('Overdue (' + act.daysOverdue + 'd)');
      if (act.missingDeps && act.missingDeps.length > 0) issues.push('Unresolved Dep ID: ' + act.missingDeps.join('; '));
      if (act.unresolvedDeps && act.unresolvedDeps.length > 0) issues.push('Blocked on Incomplete Dep: ' + act.unresolvedDeps.join('; '));
      if (!act.sourceLink) issues.push('No Source Link');

      return {
        'Action_ID': act.id,
        'Title': act.title,
        'Owner': act.owner,
        'Due_Date': act.dueDate,
        'Status': act.status,
        'Dependencies': act.dependencies.join('; '),
        'Source_Link': act.sourceLink || '',
        'Issue_Flags': issues.join('; ') || 'OK'
      };
    });

    return exportSafeCSV(headers, rows);
  }

  return {
    parseCSV: parseCSV,
    parseDateSafe: parseDateSafe,
    safeWebUrl: safeWebUrl,
    escapeHtml: escapeHtml,
    sourceCellHtml: sourceCellHtml,
    inputNotesHtml: inputNotesHtml,
    mapColumns: mapColumns,
    itemsFromRows: itemsFromRows,
    sanitizeForCSV: sanitizeForCSV,
    exportSafeCSV: exportSafeCSV,
    processHandoffData: processHandoffData,
    generateMarkdownBrief: generateMarkdownBrief,
    exportGapsCSV: exportGapsCSV
  };
});
