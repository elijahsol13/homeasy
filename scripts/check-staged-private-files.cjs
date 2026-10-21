#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

// This inspects the INDEX, not the worktree, so `git add -f` cannot bypass it.
const staged = spawnSync('git', [
  'diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z',
], { encoding: 'buffer' });

if (staged.error || staged.status !== 0) {
  console.error('Could not inspect staged Git files:', staged.error?.message ?? staged.stderr.toString());
  process.exit(1);
}

const stagedPaths = staged.stdout.toString('utf8').split('\0').filter(Boolean);
const blocked = stagedPaths.filter((file) => {
  const normalized = file.replaceAll('\\', '/');
  return /^(?:data|backups)\//i.test(normalized)
    || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(normalized);
});

if (blocked.length) {
  console.error('Blocked private files in staged Git changes:');
  for (const file of blocked) console.error(`  ${JSON.stringify(file)}`);
  console.error('Remove them from the index with: git restore --staged -- <path>');
  process.exit(1);
}
