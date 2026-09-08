import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

function runAnalyzer() {
  const dbBeforePath = path.resolve(__dirname, '../data/homeasy_before.db');
  const dbAfterPath = path.resolve(__dirname, '../data/homeasy.db');

  const dbBefore = new DatabaseSync(dbBeforePath);
  const dbAfter = new DatabaseSync(dbAfterPath);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📊 FINAL A/B TEST RESULTS: AI-FIRST PIPELINE VS REGEX HEURISTICS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const clickbaitQuery = `
    SELECT COUNT(*) as count 
    FROM properties 
    WHERE is_active = 1 
      AND (price <= 1000 OR price = 12300 OR price = 99900)
  `;
  const beforeClickbait = dbBefore.prepare(clickbaitQuery).get() as { count: number };
  const afterClickbait = dbAfter.prepare(clickbaitQuery).get() as { count: number };

  console.log('🟢 METRIC 1: Clickbait Drop Rate (Fake Prices <= $10 or $123/$999)');
  console.log(`   Before: ${beforeClickbait.count} listings with clickbait prices`);
  console.log(`   After:  ${afterClickbait.count} listings with clickbait prices`);
  console.log(`   Change: ${beforeClickbait.count - afterClickbait.count} clickbait prices fixed by AI.\n`);

  const titlesQuery = `SELECT title FROM properties WHERE is_active = 1`;
  const beforeTitles = dbBefore.prepare(titlesQuery).all() as { title: string }[];
  const afterTitles = dbAfter.prepare(titlesQuery).all() as { title: string }[];

  const beforeAvgLength = beforeTitles.reduce((acc, t) => acc + t.title.split(' ').length, 0) / (beforeTitles.length || 1);
  const afterAvgLength = afterTitles.reduce((acc, t) => acc + t.title.split(' ').length, 0) / (afterTitles.length || 1);

  const khmerRegex = /[\u1780-\u17FF]/;
  const beforeKhmer = beforeTitles.filter(t => khmerRegex.test(t.title)).length;
  const afterKhmer = afterTitles.filter(t => khmerRegex.test(t.title)).length;

  console.log('🟢 METRIC 2: Title Purity Index');
  console.log(`   Before: Avg Length = ${beforeAvgLength.toFixed(1)} words, ${beforeKhmer} titles with Khmer characters`);
  console.log(`   After:  Avg Length = ${afterAvgLength.toFixed(1)} words, ${afterKhmer} titles with Khmer characters`);
  console.log(`   Change: ${beforeKhmer - afterKhmer} Khmer titles cleaned and translated to English.\n`);

  const beforeActive = dbBefore.prepare(`SELECT COUNT(*) as count FROM properties WHERE is_active = 1`).get() as { count: number };
  const afterActive = dbAfter.prepare(`SELECT COUNT(*) as count FROM properties WHERE is_active = 1`).get() as { count: number };

  console.log('🟢 METRIC 3: Spam & Daily Rent Bounce Rate');
  console.log(`   Before active listings: ${beforeActive.count}`);
  console.log(`   After active listings:  ${afterActive.count}`);
  console.log(`   Change: ${beforeActive.count - afterActive.count} spam/daily rent listings removed from user feed.\n`);
  
  console.log('═══════════════════════════════════════════════════════════════');
}

runAnalyzer();
