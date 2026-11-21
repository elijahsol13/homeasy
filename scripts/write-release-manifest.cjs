#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const component = process.argv[2];
const outputDirectory = process.argv[3] || 'webapp/dist';
const supportedComponents = new Set(['web', 'tma']);

if (!supportedComponents.has(component)) {
  console.error('Usage: node scripts/write-release-manifest.cjs web|tma [build-dir]');
  process.exit(2);
}

const absoluteDirectory = path.resolve(outputDirectory);
if (!existsSync(path.join(absoluteDirectory, 'index.html'))) {
  console.error('Expected built index.html in ' + absoluteDirectory);
  process.exit(2);
}

const gitStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
if (gitStatus) {
  throw new Error('Refusing to attribute uncommitted source changes to a Git SHA');
}
const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== gitSha) {
  throw new Error('GITHUB_SHA differs from the checked-out commit');
}

function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(prefix, entry.name);
    if (relativePath === 'release-manifest.json') return [];
    if (entry.isDirectory()) return listFiles(path.join(directory, entry.name), relativePath);
    if (!entry.isFile()) throw new Error('Unexpected build artifact: ' + relativePath);
    return [relativePath];
  });
}

const files = listFiles(absoluteDirectory).sort().map((relativePath) => {
  const fullPath = path.join(absoluteDirectory, relativePath);
  return {
    path: relativePath,
    bytes: statSync(fullPath).size,
    sha256: createHash('sha256').update(readFileSync(fullPath)).digest('hex'),
  };
});
const contentTreeSha256 = createHash('sha256')
  .update(files.map(({ path: file, bytes, sha256 }) => file + '\t' + bytes + '\t' + sha256 + '\n').join(''))
  .digest('hex');

const manifest = {
  schemaVersion: 1,
  component,
  gitSha,
  generatedAtUtc: new Date().toISOString(),
  nodeVersion: process.version,
  contentTreeSha256,
  files,
};
writeFileSync(
  path.join(absoluteDirectory, 'release-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(component + ': ' + gitSha + ' ' + contentTreeSha256 + ' (' + files.length + ' files)');
