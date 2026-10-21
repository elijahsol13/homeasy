/** Compare an API-container read-only Pending export with local moderation code.
 * The input can contain contacts. Never print or upload the original text.
 * Usage: node -r ts-node/register scripts/audit-pending-v4-compare.cjs
 */
'use strict';
const fs = require('node:fs');
const current = require('../src/modules/parser/canonical-moderation-policy');
const previous = require('../dist/modules/parser/canonical-moderation-policy');
const input = process.env.HOMEASY_PENDING_ROWS || '/private/tmp/homeasy-pending-v4-live-rows-20261019.json';
const output = process.env.HOMEASY_PENDING_REPORT || '/private/tmp/homeasy-pending-v4-comparison-20261019.json';
const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!Array.isArray(rows) || !rows.every(r => Number.isInteger(r.id)
  && (r.raw_text === null || typeof r.raw_text === 'string'))) {
  throw new Error('Invalid or incomplete local Pending export');
}
const counts = {};
const items = rows.map(row => {
  const oldDecision = previous.evaluateModerationCandidate(row);
  const newDecision = current.evaluateModerationCandidate(row);
  for (const reason of newDecision.reasons) counts[reason] = (counts[reason] || 0) + 1;
  return { id: row.id, sourceType: row.source_type, previousEligible: oldDecision.approved,
    currentEligible: newDecision.approved,
    currentReasons: newDecision.reasons,
    wouldChange: oldDecision.approved !== newDecision.approved };
});
const report = { generatedAt: new Date().toISOString(), previousVersion: previous.MODERATION_POLICY_VERSION,
  currentVersion: current.MODERATION_POLICY_VERSION, total: rows.length,
  previousEligible: items.filter(i => i.previousEligible).map(i => i.id),
  currentEligible: items.filter(i => i.currentEligible).map(i => i.id),
  newlyEligible: items.filter(i => !i.previousEligible && i.currentEligible).map(i => i.id),
  newlyHeld: items.filter(i => i.previousEligible && !i.currentEligible).map(i => i.id),
  reasonCounts: Object.fromEntries(Object.entries(counts).sort((a,b) => b[1]-a[1])), items };
fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ previousVersion: report.previousVersion, currentVersion: report.currentVersion,
  total: report.total, previousEligible: report.previousEligible, currentEligible: report.currentEligible,
  newlyEligible: report.newlyEligible, newlyHeld: report.newlyHeld, reasonCounts: report.reasonCounts }, null, 2));
