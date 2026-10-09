/**
 * Handoff Pack Builder: Test Suite (Enso)
 * Tests all required failure modes:
 * 1. Contradictory action IDs
 * 2. Missing owners / dates (never invent owners, show unknowns)
 * 3. Unresolved dependencies (missing target IDs, blocked on incomplete tasks)
 * 4. Duplicate source links
 * 5. Overdue / completed items
 * 6. Source provenance (retaining links and excerpts)
 * 7. Safe output rendering & CSV injection defense
 * 8. Zero remote network calls / zero-upload privacy check
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Engine = require('./logic.js');

console.log('Running Handoff Pack Builder test suite...');

// Test 1: Contradictory action IDs
{
  const items = [
    { type: 'action', id: 'ACT-01', title: 'Task A', owner: 'Alice', status: 'Done' },
    { type: 'action', id: 'ACT-01', title: 'Task A duplicate with different status', owner: 'Bob', status: 'Open' }
  ];
  const res = Engine.processHandoffData(items);
  assert.ok(res.validationIssues.some(v => v.type === 'contradictory_id' && v.id === 'ACT-01'));
  console.log('✓ PASS: Contradictory action IDs detected and flagged');
}

// Test 2: Missing owners / dates: never invent owners, show unknowns explicitly
{
  const items = [
    { type: 'action', id: 'ACT-10', title: 'Fix bug', owner: '', dueDate: '' },
    { type: 'action', id: 'ACT-11', title: 'Document API', owner: 'unassigned', dueDate: '2026-09-15' },
    { type: 'decision', id: 'DEC-10', title: 'Choose vendor', owner: '', status: 'Open' }
  ];
  const res = Engine.processHandoffData(items);

  const act10 = res.actions.find(a => a.id === 'ACT-10');
  assert.strictEqual(act10.owner, '[Unknown Owner]');
  assert.strictEqual(act10.hasOwner, false);
  assert.strictEqual(act10.hasDueDate, false);

  const act11 = res.actions.find(a => a.id === 'ACT-11');
  assert.strictEqual(act11.owner, '[Unknown Owner]');
  assert.strictEqual(act11.hasOwner, false);
  assert.strictEqual(act11.hasDueDate, true);

  const dec10 = res.decisions.find(d => d.id === 'DEC-10');
  assert.strictEqual(dec10.owner, '[Unknown Owner]');

  assert.strictEqual(res.missingOwnerOrDateActions.length, 2);
  console.log('✓ PASS: Missing owners/dates never invented; marked as [Unknown Owner] explicitly');
}

// Test 3: Unresolved dependencies (missing target ID & incomplete target)
{
  const items = [
    { type: 'decision', id: 'DEC-P1', title: 'Pricing decision', status: 'Open', owner: 'CEO' },
    { type: 'action', id: 'ACT-BLOCKER', title: 'Setup auth', status: 'Open', owner: 'Dave' },
    { type: 'action', id: 'ACT-DONE', title: 'Create repo', status: 'Done', owner: 'Dave' },
    { type: 'action', id: 'ACT-DEP-1', title: 'Launch site', dependencies: 'ACT-BLOCKER', owner: 'Eve' },
    { type: 'action', id: 'ACT-DEP-2', title: 'Publish pricing', dependencies: 'DEC-P1', owner: 'Eve' },
    { type: 'action', id: 'ACT-DEP-3', title: 'Deploy feature', dependencies: 'ACT-NONEXISTENT', owner: 'Eve' },
    { type: 'action', id: 'ACT-DEP-4', title: 'Start work', dependencies: 'ACT-DONE', owner: 'Eve' }
  ];

  const res = Engine.processHandoffData(items);

  // ACT-DEP-1 blocked on incomplete ACT-BLOCKER
  const dep1 = res.unresolvedDependencies.find(d => d.actionId === 'ACT-DEP-1');
  assert.ok(dep1);
  assert.strictEqual(dep1.dependencyId, 'ACT-BLOCKER');

  // ACT-DEP-2 blocked on unresolved decision DEC-P1
  const dep2 = res.unresolvedDependencies.find(d => d.actionId === 'ACT-DEP-2');
  assert.ok(dep2);
  assert.strictEqual(dep2.dependencyId, 'DEC-P1');

  // ACT-DEP-3 blocked on missing dependency ID
  const dep3 = res.unresolvedDependencies.find(d => d.actionId === 'ACT-DEP-3');
  assert.ok(dep3);
  assert.strictEqual(dep3.dependencyId, 'ACT-NONEXISTENT');

  // ACT-DEP-4 depends on ACT-DONE which is completed, so it is NOT in unresolvedDependencies
  const dep4 = res.unresolvedDependencies.find(d => d.actionId === 'ACT-DEP-4');
  assert.strictEqual(dep4, undefined);

  console.log('✓ PASS: Unresolved and missing dependencies accurately verified');
}

// Test 4: Duplicate source links
{
  const items = [
    { type: 'action', id: 'ACT-A', title: 'Doc A', sourceLink: 'https://notion.so/meeting-notes' },
    { type: 'action', id: 'ACT-B', title: 'Doc B', sourceLink: 'https://notion.so/meeting-notes' }
  ];
  const res = Engine.processHandoffData(items);
  assert.strictEqual(res.duplicateSourceLinks.length, 1);
  assert.strictEqual(res.duplicateSourceLinks[0].link, 'https://notion.so/meeting-notes');
  console.log('✓ PASS: Duplicate source links tracked');
}

// Test 5: Overdue / completed items
{
  const refDate = new Date('2026-09-25T00:00:00Z');
  const items = [
    { type: 'action', id: 'ACT-OVERDUE', title: 'Old Task', dueDate: '2026-09-10', status: 'Open' },
    { type: 'action', id: 'ACT-FUTURE', title: 'Future Task', dueDate: '2026-10-01', status: 'Open' },
    { type: 'action', id: 'ACT-FINISHED', title: 'Done Task', dueDate: '2026-09-01', status: 'Completed' }
  ];
  const res = Engine.processHandoffData(items, { referenceDate: refDate });

  const overdue = res.actions.find(a => a.id === 'ACT-OVERDUE');
  assert.strictEqual(overdue.isOverdue, true);
  assert.strictEqual(overdue.daysOverdue, 15);

  const future = res.actions.find(a => a.id === 'ACT-FUTURE');
  assert.strictEqual(future.isOverdue, false);

  const finished = res.actions.find(a => a.id === 'ACT-FINISHED');
  assert.strictEqual(finished.isOverdue, false); // Completed items are not overdue
  assert.strictEqual(finished.isComplete, true);

  console.log('✓ PASS: Overdue days calculated accurately and completed items exempt');
}

// Test 6: Source provenance (links and excerpts preserved in output brief)
{
  const items = [
    {
      type: 'decision',
      id: 'DEC-PROV',
      title: 'Adopt SQLite for embedded ledger',
      status: 'Decided',
      sourceLink: 'https://github.com/enso/rfcs/pull/12',
      sourceExcerpt: 'Benchmark confirmed SQLite meets sub-millisecond query threshold.'
    }
  ];
  const res = Engine.processHandoffData(items);
  const brief = Engine.generateMarkdownBrief(res, 'Test Brief');
  assert.ok(brief.includes('https://github.com/enso/rfcs/pull/12'), 'Must preserve sourceLink URL');
  assert.ok(brief.includes('Benchmark confirmed SQLite meets sub-millisecond query threshold.'), 'Must preserve excerpt');
  console.log('✓ PASS: Source provenance faithfully rendered in Markdown brief');
}

// Test 7: Safe output rendering & CSV formula injection defenses
{
  const items = [
    { type: 'action', id: 'ACT-XSS', title: '<script>alert("xss")</script>', owner: '=1+1', dueDate: '+1999-01-01', status: '@SUM(A1:B2)' }
  ];
  const res = Engine.processHandoffData(items);
  const csv = Engine.exportGapsCSV(res);

  assert.ok(csv.includes("'=1+1"), 'Formula = must be sanitized with prepended single quote');
  assert.ok(csv.includes("'+1999-01-01"), 'Formula + must be sanitized with prepended single quote');
  assert.ok(csv.includes("'@SUM(A1:B2)"), 'Formula @ must be sanitized with prepended single quote');
  console.log('✓ PASS: Formula injection safely defused in action CSV export');
}

// Test 8: Zero network calls / Zero-upload privacy check
{
  const logicFile = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  assert.ok(!logicFile.includes('fetch('), 'logic.js must not contain fetch()');
  assert.ok(!logicFile.includes('XMLHttpRequest'), 'logic.js must not contain XMLHttpRequest');
  assert.ok(!logicFile.includes('http://'), 'logic.js must not contain remote http links');
  assert.ok(!logicFile.includes('https://'), 'logic.js must not contain remote https links');
  console.log('✓ PASS: Zero-network transmission verified in engine');
}


// ---------------------------------------------------------------------------
// GTM-104 regressions (audit 2026-10-09). Each block targets one failure mode:
//   F1  Dependency header aliases not recognised (Blocked By read as nothing)
//   F2  Repeated dependency headers (Jira repeats "Inward issue link (Blocks)")
//       only partly read
//   F3  Substring header matching grabs the wrong column (Created -> due date)
//   F4  Unused columns dropped silently
//   F5  No dependency column at all reads as "nothing is blocked"
//   F6  Dependency cells with commas, semicolons, newlines, spaces, or titles
//   F7  Zero decisions reported as "all decisions approved"
//   F8  The all-resolved sentence is only true when decisions exist
//   F9  Section numbers duplicate or skip when optional sections are empty
//   F10 Source Link with a non-web scheme becomes a clickable link
//   F11 Project title prefilled in the page / blank title breaks the heading
//   F12 CTA links lose their UTM tags
// ---------------------------------------------------------------------------

function loadCsv(csv) {
  return Engine.itemsFromRows(Engine.parseCSV(csv));
}

function buildBrief(csv, opts) {
  const loaded = loadCsv(csv);
  const res = Engine.processHandoffData(loaded.items, Object.assign({
    referenceDate: new Date('2026-10-09T00:00:00Z'),
    ignoredColumns: loaded.ignoredColumns,
    hasDependencyColumn: loaded.hasDependencyColumn
  }, opts || {}));
  return { loaded, res, brief: Engine.generateMarkdownBrief(res, (opts && opts.title) || '') };
}

const LINEAR_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'linear-style-export.csv'), 'utf8');

// F1: audit fixture. ENG-104 is blocked by unfinished ENG-103.
{
  const { res, brief } = buildBrief(LINEAR_FIXTURE);
  const blocked = res.unresolvedDependencies.filter(d => d.actionId === 'ENG-104');
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].dependencyId, 'ENG-103');
  assert.strictEqual(res.summary.unresolvedDependenciesCount, 1);
  assert.ok(/ENG-104\*\* \(Point analytics jobs at the new replicas\) is blocked on \*\*ENG-103\*\*/.test(brief));
  console.log('✓ PASS: Linear-style "Blocked By" column makes ENG-104 blocked by unfinished ENG-103');
}

// F1: every common dependency header name, across tracker exports
{
  const names = [
    'Blocked By', 'Blocked by', 'blocked_by', 'BLOCKED BY', 'Depends On', 'Depends on', 'Dependencies',
    'Dependency', 'Blockers', 'Blocker', 'Predecessors', 'Prerequisites',
    'Blocked By (Dependencies)',         // Asana
    'Inward issue link (Blocks)'         // Jira
  ];
  names.forEach(name => {
    const csv = 'ID,Title,Status,' + name + '\nA-1,First,Open,\nA-2,Second,Open,A-1\n';
    const { res } = buildBrief(csv);
    assert.strictEqual(res.unresolvedDependencies.length, 1, 'header "' + name + '" must count as dependencies');
    assert.strictEqual(res.unresolvedDependencies[0].actionId, 'A-2');
  });
  console.log('✓ PASS: ' + names.length + ' dependency header spellings recognised');
}

// F1: a dependency header with a BOM or padding is still recognised
{
  const csv = '﻿ID,Title,Status, Blocked By \nA-1,First,Open,\nA-2,Second,Open,A-1\n';
  const { res } = buildBrief(csv);
  assert.strictEqual(res.unresolvedDependencies.length, 1);
  console.log('✓ PASS: BOM and padded header cells do not hide the dependency column');
}

// F2: Jira repeats the same header; every copy is read, direction is respected
{
  const csv = 'Issue key,Summary,Status,Inward issue link (Blocks),Inward issue link (Blocks),Outward issue link (Blocks)\n' +
    'J-1,One,To Do,,,J-3\n' +
    'J-2,Two,Done,,,\n' +
    'J-3,Three,To Do,J-1,J-2,\n';
  const { loaded, res } = buildBrief(csv);
  const j3 = res.actions.find(a => a.id === 'J-3');
  assert.deepStrictEqual(j3.dependencies, ['J-1', 'J-2']);
  assert.strictEqual(res.unresolvedDependencies.length, 1, 'J-2 is done so only J-1 blocks J-3');
  assert.strictEqual(res.unresolvedDependencies[0].dependencyId, 'J-1');
  assert.deepStrictEqual(loaded.ignoredColumns, []);
  console.log('✓ PASS: Repeated Jira link headers are merged');
}

// F2: Jira exports often carry only "Outward issue link (Blocks)": A blocks B means B is blocked by A
{
  const csv = 'Issue key,Summary,Status,Outward issue link (Blocks),Outward issue link (Relates)\n' +
    'J-1,One,To Do,"J-3, J-4",J-2\n' +
    'J-2,Two,Done,J-4,\n' +
    'J-3,Three,To Do,,\n' +
    'J-4,Four,To Do,,\n';
  const { loaded, res } = buildBrief(csv);
  assert.strictEqual(loaded.hasDependencyColumn, true);
  assert.deepStrictEqual(res.actions.find(a => a.id === 'J-3').dependencies, ['J-1']);
  assert.deepStrictEqual(res.actions.find(a => a.id === 'J-4').dependencies, ['J-1', 'J-2']);
  assert.deepStrictEqual(res.unresolvedDependencies.map(d => d.actionId + '>' + d.dependencyId), ['J-3>J-1', 'J-4>J-1']);
  assert.deepStrictEqual(loaded.ignoredColumns, ['Outward issue link (Relates)'], 'other link types are reported, not guessed');
  console.log('✓ PASS: "Blocks" columns are inverted into blocked-by; other link types are reported as unused');
}

// F3: exact aliases, so "Created", "Start Date", "Lead Time" cannot hijack a field
{
  const csv = 'ID,Title,Status,Assignee,Created,Start Date,Due Date,Lead Time,Name Suffix\n' +
    'X-1,Do it,Todo,Ann,2026-01-01,2026-02-01,2026-10-20,5,zzz\n';
  const { loaded, res } = buildBrief(csv);
  const x = res.actions[0];
  assert.strictEqual(x.dueDate, '2026-10-20');
  assert.strictEqual(x.owner, 'Ann');
  assert.strictEqual(x.title, 'Do it');
  assert.deepStrictEqual(loaded.ignoredColumns, ['Created', 'Start Date', 'Lead Time', 'Name Suffix']);
  console.log('✓ PASS: Look-alike headers do not hijack due date, owner or title');
}

// F3: Title wins over Description (both present in Linear exports); first duplicate wins
{
  const csv = 'ID,Description,Title,Title\nA-1,Long text,Short title,Other title\n';
  const { loaded, res } = buildBrief(csv);
  assert.strictEqual(res.actions[0].title, 'Short title');
  assert.deepStrictEqual(loaded.ignoredColumns, ['Description', 'Title']);
  console.log('✓ PASS: Preferred column wins; shadowed duplicates are reported');
}

// F4: unused columns are listed in the brief and on the result
{
  const { loaded, res, brief } = buildBrief(LINEAR_FIXTURE);
  assert.deepStrictEqual(loaded.ignoredColumns, ['Team', 'Priority', 'Labels']);
  assert.deepStrictEqual(res.ignoredColumns, ['Team', 'Priority', 'Labels']);
  assert.ok(brief.includes('**Input columns not used:** Team, Priority, Labels'));
  console.log('✓ PASS: Ignored columns are listed in the brief');
}

// F4: when every column is used the brief does not claim anything was ignored
{
  const { brief } = buildBrief('ID,Title,Status,Owner\nA-1,One,Open,Ann\n');
  assert.ok(!brief.includes('Input columns not used'));
  console.log('✓ PASS: No ignored-columns line when nothing was ignored');
}

// F4: blank header cells (trailing commas) are not reported as columns
{
  const { loaded } = buildBrief('ID,Title,Status,\nA-1,One,Open,\n');
  assert.deepStrictEqual(loaded.ignoredColumns, []);
  console.log('✓ PASS: Empty header cells are not reported as ignored columns');
}

// F5: no dependency column at all must not look like "nothing is blocked"
{
  const { loaded, res, brief } = buildBrief('ID,Title,Status\nA-1,One,Open\nA-2,Two,Open\n');
  assert.strictEqual(loaded.hasDependencyColumn, false);
  assert.strictEqual(res.hasDependencyColumn, false);
  assert.ok(brief.includes('**Dependencies:** no dependency column found, so blocked work cannot be detected'));
  const withCol = buildBrief('ID,Title,Status,Blocked By\nA-1,One,Open,\n');
  assert.strictEqual(withCol.res.hasDependencyColumn, true);
  assert.ok(!withCol.brief.includes('no dependency column found'));
  console.log('✓ PASS: Missing dependency column is called out instead of reading as zero blocked');
}

// F6: dependency cell formats
{
  const csv = 'ID,Title,Status,Blocked By\n' +
    'A-1,One,Open,\nA-2,Two,Open,\nA-3,Three,Open,\n' +
    'B-1,Comma,Open,"A-1, A-2"\n' +
    'B-2,Semicolon,Open,A-1;A-2\n' +
    'B-3,Newline,Open,"A-1\nA-2"\n' +
    'B-4,Spaces,Open,A-1 A-2\n' +
    'B-5,Title ref,Open,Cut over auth service\n';
  const { res } = buildBrief(csv);
  const deps = id => res.actions.find(a => a.id === id).dependencies;
  assert.deepStrictEqual(deps('B-1'), ['A-1', 'A-2']);
  assert.deepStrictEqual(deps('B-2'), ['A-1', 'A-2']);
  assert.deepStrictEqual(deps('B-3'), ['A-1', 'A-2']);
  assert.deepStrictEqual(deps('B-4'), ['A-1', 'A-2']);
  assert.deepStrictEqual(deps('B-5'), ['Cut over auth service'], 'a title is one unknown reference, not three');
  console.log('✓ PASS: Dependency cells split on commas, semicolons, newlines and spaces between IDs');
}

// F6: Asana-style exports name the blocker by title. Unique exact titles resolve; ambiguous ones do not.
{
  const csv = 'ID,Title,Status,Blocked By\n' +
    'T-1,Cut over auth service,In Progress,\n' +
    'T-2,Notify customers,Open,Cut over auth service\n' +
    'T-3,Twin,Open,\n' +
    'T-4,Twin,Open,\n' +
    'T-5,Wait on twin,Open,Twin\n';
  const { res } = buildBrief(csv);
  const t2 = res.unresolvedDependencies.find(d => d.actionId === 'T-2');
  assert.strictEqual(t2.reason, 'Blocking action is incomplete (In Progress)');
  const t5 = res.unresolvedDependencies.find(d => d.actionId === 'T-5');
  assert.strictEqual(t5.reason, 'Dependency ID not found in input dataset', 'two items share the title, so it is not guessed');
  console.log('✓ PASS: Blockers named by unique title resolve; ambiguous titles are not guessed');
}

// F7 + F8: decision wording
{
  const none = buildBrief('ID,Title,Status\nA-1,One,Open\n');
  assert.ok(none.brief.includes('No decisions were recorded in this file.'));
  assert.ok(!/formally approved|all decisions/i.test(none.brief), 'zero decisions must never read as approved');

  const resolved = buildBrief('Type,ID,Title,Status\ndecision,D-1,Pick vendor,Decided\ndecision,D-2,Pick region,Approved\n');
  assert.ok(resolved.brief.includes('All 2 decisions in this file are marked resolved.'));
  assert.ok(!resolved.brief.includes('No decisions were recorded'));

  const open = buildBrief('Type,ID,Title,Status\ndecision,D-1,Pick vendor,Open\n');
  assert.ok(!open.brief.includes('No decisions were recorded'));
  assert.ok(!open.brief.includes('are marked resolved'));
  console.log('✓ PASS: Zero decisions say none were recorded; resolved wording only when decisions exist');
}

// F9: numbering for every combination of optional sections
{
  const base = ['Type,ID,Title,Owner,Due_Date,Status,Dependencies'];
  const decisionRow = 'decision,D-1,Pick vendor,Ann,2026-10-01,Open,';
  const blockedRows = ['action,A-1,First,Ann,2026-10-01,Open,', 'action,A-2,Second,Ann,2026-10-01,Open,A-1'];
  const okRow = 'action,A-3,Third,Ann,2026-10-01,Done,';
  const noOwnerRow = 'action,A-4,Fourth,,2026-10-01,Done,';
  let combos = 0;
  for (let mask = 0; mask < 8; mask++) {
    const rows = base.slice();
    if (mask & 1) rows.push(decisionRow);
    if (mask & 2) rows.push.apply(rows, blockedRows);
    else rows.push(okRow);
    if (mask & 4) rows.push(noOwnerRow);
    const { brief } = buildBrief(rows.join('\n') + '\n');
    const nums = (brief.match(/^## (\d+)\. /gm) || []).map(h => parseInt(h.slice(3), 10));
    assert.ok(nums.length >= 3, 'mask ' + mask + ' has at least the three fixed sections');
    nums.forEach((n, i) => assert.strictEqual(n, i + 1, 'mask ' + mask + ' numbering ' + nums.join(',')));
    combos++;
  }
  console.log('✓ PASS: Section numbers run 1..n with no duplicates or gaps across ' + combos + ' combinations of empty sections');
}

// F10: only http and https Source Links are links
{
  assert.strictEqual(Engine.safeWebUrl('https://linear.app/acme/issue/ENG-1'), 'https://linear.app/acme/issue/ENG-1');
  assert.strictEqual(Engine.safeWebUrl('http://example.com/a b'), 'http://example.com/a%20b');
  assert.strictEqual(Engine.safeWebUrl(' HTTPS://Example.com '), 'https://example.com/');
  [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'ftp://example.com/x',
    'mailto:a@b.com', '//evil.example.com/x', 'https://', 'not a url', '', null, undefined
  ].forEach(bad => assert.strictEqual(Engine.safeWebUrl(bad), '', 'must not be a link: ' + JSON.stringify(bad)));
  console.log('✓ PASS: safeWebUrl accepts only http and https');
}

{
  const csv = 'ID,Title,Status,Source Link\n' +
    'A-1,Good,Open,https://example.com/ok\n' +
    'A-2,Bad,Open,javascript:alert(document.cookie)\n' +
    'A-3,Paren,Open,https://example.com/a_(b)\n';
  const { res, brief } = buildBrief(csv);
  const a2 = res.actions.find(a => a.id === 'A-2');
  assert.strictEqual(a2.sourceUrl, '');
  assert.strictEqual(a2.sourceLink, 'javascript:alert(document.cookie)', 'the text is kept for the reader');
  assert.ok(!/\]\(javascript:/i.test(brief), 'no markdown link may target javascript:');
  assert.ok(brief.includes('[link](https://example.com/ok)'));
  assert.ok(brief.includes('[link](https://example.com/a_%28b%29)'), 'parentheses cannot break out of the link');
  assert.ok(brief.includes('Source (not a web link): `javascript:alert(document.cookie)`'));
  const dec = buildBrief('Type,ID,Title,Status,Source Link\ndecision,D-1,Pick,Open,javascript:alert(1)\n');
  assert.ok(!/\]\(javascript:/i.test(dec.brief));
  assert.ok(!dec.brief.includes('[Source]('));
  console.log('✓ PASS: javascript: Source Link stays plain text in the brief; http(s) stay links');
}

// F11: title heading
{
  ['', '   ', null, undefined].forEach(t => {
    const res = Engine.processHandoffData([{ id: 'A-1', title: 'x' }]);
    assert.ok(Engine.generateMarkdownBrief(res, t).startsWith('# Operational Project Handoff Brief\n'));
  });
  const res = Engine.processHandoffData([{ id: 'A-1', title: 'x' }]);
  const injected = Engine.generateMarkdownBrief(res, '  Platform handoff\n## 9. Fake section ');
  assert.ok(injected.startsWith('# Platform handoff ## 9. Fake section\n'));
  assert.ok(!/^## 9\./m.test(injected), 'a title cannot start a new heading');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const titleInput = /<input[^>]*id="project-title"[^>]*>/.exec(html)[0];
  assert.ok(!/\svalue=/.test(titleInput), 'project title must not be prefilled');
  assert.ok(/placeholder="[^"]+"/.test(titleInput), 'project title needs a placeholder');
  assert.ok(!html.includes('Q3 Operations Architecture'));
  console.log('✓ PASS: Title is a placeholder; blank or multi-line titles cannot break the heading');
}

// F13: reviewer findings. CSV text is data, never Markdown structure or links.
{
  const csv = 'Type,ID,Title,Owner,Status,Source Link,Source Excerpt,[x](javascript:alert(1))\n' +
    'decision,D-1,"[click me](javascript:alert(1))",Ann,Open,<javascript:alert(1)>,"see <javascript:alert(2)>",x\n' +
    'action,A-1,"Pick\n## 2. Fake section\n\n[docs](javascript:alert(3))",Bo,Open,"note\n\n[docs](javascript:alert(4))",,x\n';
  const { brief } = buildBrief(csv);
  assert.ok(!/\]\(javascript:/i.test(brief), 'no markdown link may target javascript:');
  assert.ok(!/(^|[^\\])<javascript:/i.test(brief), 'no autolink to javascript:');
  const headings = brief.split('\n').filter(l => /^#{1,6} /.test(l));
  assert.ok(!headings.some(h => /Fake section/.test(h)), 'a title cannot start a heading: ' + headings.join(' | '));
  brief.split('\n').forEach(line => assert.ok(!/^\[docs\]/.test(line), 'a cell cannot start its own Markdown line'));
  console.log('✓ PASS: Hostile titles, sources, excerpts and column names cannot create links, autolinks or headings');
}

// F13: HTML helpers used by the page
{
  const hostile = { sourceLink: 'javascript:alert(1)', sourceUrl: '' };
  const html = Engine.sourceCellHtml(hostile, 'Source');
  assert.ok(!/<a\s/i.test(html) && !/href=/i.test(html), 'non-web Source Link must not render an anchor: ' + html);
  assert.ok(html.includes('javascript:alert(1)'), 'the text is still shown');
  const tagged = Engine.sourceCellHtml({ sourceLink: '"><img src=x onerror=alert(1)>', sourceUrl: '' });
  assert.ok(!/<img/i.test(tagged), 'markup in a Source Link is escaped');
  const ok = Engine.sourceCellHtml({ sourceLink: 'https://a.example/x?q="1"', sourceUrl: Engine.safeWebUrl('https://a.example/x?q="1"') }, 'Source');
  assert.ok(/<a href="https:\/\/a\.example\/x\?q=%22 ?1%22"|<a href="https:\/\/a\.example\/x\?q=(&quot;|%22)1(&quot;|%22)"/.test(ok), 'link href is escaped: ' + ok);
  assert.ok(/None/.test(Engine.sourceCellHtml({ sourceLink: '', sourceUrl: '' })));
  const notes = Engine.inputNotesHtml({ hasDependencyColumn: false, ignoredColumns: ['<img src=x onerror=alert(1)>', 'Team'] });
  assert.ok(!/<img/i.test(notes), 'column names are escaped in the notice');
  assert.ok(notes.includes('No dependency column found') && notes.includes('Team'));
  assert.strictEqual(Engine.inputNotesHtml({ hasDependencyColumn: true, ignoredColumns: [] }), '');
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(/HandoffEngine\.sourceCellHtml/.test(page) && /HandoffEngine\.inputNotesHtml/.test(page), 'page must render through the tested helpers');
  assert.ok(!/href="' \+ escapeHtml\((dec|act)\.sourceLink/.test(page), 'page must not build anchors from the raw sourceLink');
  console.log('✓ PASS: Page HTML helpers escape hostile input and only link http(s)');
}

// F13: userinfo hides the real host, so it is not a link
{
  assert.strictEqual(Engine.safeWebUrl('https://linear.app@evil.example/x'), '');
  assert.strictEqual(Engine.safeWebUrl('https://user:pw@example.com/'), '');
  console.log('✓ PASS: Links with user:pass@ are plain text');
}

// F14: decisions can be blocked too
{
  const { res } = buildBrief('Type,ID,Title,Status,Blocked By\naction,A-1,Gather quotes,Open,\ndecision,D-1,Pick vendor,Open,A-1\n');
  assert.strictEqual(res.unresolvedDependencies.length, 1);
  assert.strictEqual(res.unresolvedDependencies[0].actionId, 'D-1');
  assert.strictEqual(res.unresolvedDependencies[0].dependencyId, 'A-1');
  console.log('✓ PASS: A decision waiting on an open action is reported as blocked');
}

// F15: the same blocker named twice counts once
{
  const csv = 'ID,Title,Status,Blocked By,Dependencies\nA-1,One,Open,,\nA-2,Two,Open,A-1,a-1\nA-3,Three,Open,"A-1, A-1",\n';
  const { res } = buildBrief(csv);
  assert.strictEqual(res.unresolvedDependencies.filter(d => d.actionId === 'A-2').length, 1);
  assert.strictEqual(res.unresolvedDependencies.filter(d => d.actionId === 'A-3').length, 1);
  console.log('✓ PASS: Repeated or differently-cased references to one blocker count once');
}

// F16: placeholder cells and titles with commas
{
  const csv = 'ID,Title,Status,Blocked By\nA-1,Fix login, then deploy,Open,\n'.replace('Fix login, then deploy', '"Fix login, then deploy"') +
    'A-2,Two,Open,None\nA-3,Three,Open,N/A\nA-4,Four,Open,-\nA-5,Five,Open,TBD\nA-6,Six,Open,"Fix login, then deploy"\n';
  const { res } = buildBrief(csv);
  assert.deepStrictEqual(res.unresolvedDependencies.map(d => d.actionId + '>' + d.dependencyId), ['A-6>Fix login, then deploy']);
  assert.strictEqual(res.unresolvedDependencies[0].reason, 'Blocking action is incomplete (Open)');
  console.log('✓ PASS: None, N/A, - and TBD are not blockers; a whole-cell title with commas resolves');
}

// F17: lowercase IDs resolve; an item cannot block itself
{
  const { res } = buildBrief('ID,Title,Status,Blocked By\nENG-103,Replicas,Open,\nENG-104,Jobs,Open,eng-103\nENG-105,Self,Open,ENG-105\n');
  assert.deepStrictEqual(res.unresolvedDependencies.map(d => d.actionId + '>' + d.dependencyId), ['ENG-104>eng-103']);
  console.log('✓ PASS: IDs match regardless of case; self-references are ignored');
}

// F18: header spellings the old matcher accepted still map
{
  const csv = 'Ticket Key,Issue Title,Owner(s),Due Date (UTC),Current Status,Deps,Source Links\nT-1,One,Ann,2026-10-20,Open,,https://example.com/1\nT-2,Two,Bo,2026-10-21,Open,T-1,https://example.com/2\n';
  const { loaded, res } = buildBrief(csv);
  assert.deepStrictEqual(loaded.ignoredColumns, []);
  assert.strictEqual(res.unresolvedDependencies.length, 1);
  assert.strictEqual(res.actions[1].owner, 'Bo');
  assert.strictEqual(res.actions[1].dueDate, '2026-10-21');
  assert.strictEqual(res.actions[1].sourceUrl, 'https://example.com/2');
  console.log('✓ PASS: Common header variants (Ticket Key, Owner(s), Due Date (UTC), Deps, ...) map');
}

// F19: Asana has no Status column; Completed At decides whether a blocker is finished
{
  const csv = 'Task ID,Name,Assignee,Due Date,Completed At,Blocked By (Dependencies)\n11,Cut over,Ann,2026-10-01,2026-10-02T10:00:00Z,\n12,Notify,Bo,2026-10-05,,11\n13,Wait,Cy,2026-10-06,,12\n';
  const { loaded, res } = buildBrief(csv);
  assert.deepStrictEqual(loaded.ignoredColumns, []);
  assert.strictEqual(res.summary.completedActions, 1);
  assert.deepStrictEqual(res.unresolvedDependencies.map(d => d.actionId + '>' + d.dependencyId), ['13>12'], 'task 12 is blocked only by finished task 11');
  console.log('✓ PASS: Asana Completed At marks finished blockers');
}

// F12: every outbound Enso link on the page carries the campaign tags
{
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const hrefs = (html.match(/<a [^>]*href="([^"]+)"/g) || []).map(a => /href="([^"]+)"/.exec(a)[1].replace(/&amp;/g, '&'))
    .filter(h => /^https?:\/\//.test(h));
  assert.ok(hrefs.length >= 2, 'the CTA block must have at least a booking link and a pricing link');
  hrefs.forEach(h => {
    const u = new URL(h);
    assert.ok(/(^|\.)(ensohq\.ai|koalendar\.com)$/.test(u.hostname), 'unexpected outbound host ' + u.hostname);
    assert.strictEqual(u.searchParams.get('utm_source'), 'tool', h);
    assert.strictEqual(u.searchParams.get('utm_medium'), 'lead-magnet', h);
    assert.strictEqual(u.searchParams.get('utm_campaign'), 'handoff-pack-builder', h);
    assert.ok(u.searchParams.get('utm_content'), 'each CTA needs its own utm_content: ' + h);
  });
  assert.strictEqual(new Set(hrefs.map(h => new URL(h).searchParams.get('utm_content'))).size, hrefs.length, 'utm_content must differ per CTA');
  assert.ok(!/nodestar/i.test(html), 'Enso tool must not carry NodeStar messaging');
  console.log('✓ PASS: All ' + hrefs.length + ' outbound CTA links carry UTM tags and a distinct utm_content');
}

console.log('\nAll Handoff Pack Builder test suites passed successfully!');
