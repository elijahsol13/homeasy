const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const guard = path.join(__dirname, '..', 'scripts', 'check-staged-private-files.cjs');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function withRepo(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-git-guard-'));
  try {
    git(directory, 'init', '-q');
    fs.writeFileSync(path.join(directory, '.gitignore'), 'data/\n*.db\n*.sqlite3\n');
    git(directory, 'add', '.gitignore');
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function stage(cwd, filename) {
  const fullPath = path.join(cwd, filename);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, 'dummy content');
  git(cwd, 'add', '-f', '--', filename);
}

function check(cwd) {
  return spawnSync(process.execPath, [guard], { cwd, encoding: 'utf8' });
}

test('allows ordinary staged source files', () => withRepo((repo) => {
  stage(repo, 'src/example.ts');
  const result = check(repo);
  assert.equal(result.status, 0, result.stderr);
}));

for (const filename of [
  'data/homeasy.db',
  'data/backups/archive.bin',
  'data/fb_session.json',
  'snapshots/production.sqlite3',
  'snapshots/production.db-wal',
  'snapshots/production.sqlite-shm',
  'backups/anything.json',
]) {
  test(`rejects forced-staged private file ${filename}`, () => withRepo((repo) => {
    stage(repo, filename);
    const result = check(repo);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Blocked private files/i);
    assert.ok(result.stderr.includes(filename), result.stderr);
  }));
}

test('allows staged removal of an accidentally tracked database', () => withRepo((repo) => {
  stage(repo, 'data/old.db');
  git(repo, '-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'historical tracking');
  git(repo, 'rm', '--cached', 'data/old.db');
  const result = check(repo);
  assert.equal(result.status, 0, result.stderr);
}));

test('pre-commit hook prevents a real commit containing forced-added SQLite', () => withRepo((repo) => {
  fs.mkdirSync(path.join(repo, '.githooks'));
  fs.mkdirSync(path.join(repo, 'scripts'));
  const hookPath = path.join(repo, '.githooks', 'pre-commit');
  fs.copyFileSync(path.join(__dirname, '..', '.githooks', 'pre-commit'), hookPath);
  fs.chmodSync(hookPath, 0o755);
  fs.copyFileSync(guard, path.join(repo, 'scripts', 'check-staged-private-files.cjs'));
  stage(repo, 'data/homeasy.db');

  const commit = spawnSync('git', [
    '-C', repo, '-c', 'core.hooksPath=.githooks',
    '-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'must not commit private data',
  ], { encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, /Blocked private files/i);
  assert.match(commit.stderr, /data\/homeasy\.db/);
}));
