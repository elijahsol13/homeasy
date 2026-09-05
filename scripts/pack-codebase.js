const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT_DIR, 'repomix-output.xml');

// Directories and files to ignore
const IGNORED_PATHS = [
  'node_modules',
  'dist',
  'data',
  '.git',
  '.env',
  'coverage',
  '.DS_Store',
  'repomix-output.xml',
  'package-lock.json',
];

const ALLOWED_EXTENSIONS = ['.ts', '.js', '.json', '.md', '.yml', '.yaml', 'Dockerfile', '.dockerignore'];

function shouldInclude(filePath) {
  const relPath = path.relative(ROOT_DIR, filePath);
  const parts = relPath.split(path.sep);

  for (const part of parts) {
    if (IGNORED_PATHS.includes(part)) return false;
  }

  const base = path.basename(filePath);
  if (base.startsWith('.env')) return base === '.env.example';
  if (base === 'Dockerfile' || base === '.dockerignore') return true;

  const ext = path.extname(filePath);
  return ALLOWED_EXTENSIONS.includes(ext);
}

function getAllFiles(dirPath, arrayOfFiles = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_PATHS.includes(entry.name)) {
        getAllFiles(fullPath, arrayOfFiles);
      }
    } else if (entry.isFile()) {
      if (shouldInclude(fullPath)) {
        arrayOfFiles.push(fullPath);
      }
    }
  }

  return arrayOfFiles;
}

function buildXml() {
  console.log('📦 Scanning repository files...');
  const files = getAllFiles(ROOT_DIR).sort();
  console.log(`Found ${files.length} relevant files for AI review.`);

  let xml = 'This file is a merged representation of the entire codebase, packaged for AI architectural evaluation.\n\n';
  xml += '<repository_summary>\n';
  xml += '  <project_name>HomEasy</project_name>\n';
  xml += '  <description>Cambodia Real Estate Aggregator & Notification Telegram Bot</description>\n';
  xml += '  <runtime>Node.js 22+ (TypeScript), SQLite WAL (node:sqlite), Playwright Stealth, Sharp, Docker</runtime>\n';
  xml += '  <file_count>' + files.length + '</file_count>\n';
  xml += '</repository_summary>\n\n';

  xml += '<files>\n';
  for (const filePath of files) {
    const relPath = path.relative(ROOT_DIR, filePath);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      xml += `\n<file path="${relPath}">\n`;
      xml += content;
      if (!content.endsWith('\n')) xml += '\n';
      xml += `</file>\n`;
    } catch (err) {
      console.warn(`Could not read ${relPath}:`, err.message);
    }
  }
  xml += '</files>\n';

  fs.writeFileSync(OUTPUT_FILE, xml, 'utf8');
  const sizeMb = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`✅ Codebase successfully packaged into ${OUTPUT_FILE} (${sizeMb} MB)`);
}

buildXml();

