const fs = require('fs');
let code = fs.readFileSync('scripts/fb-account-setup.ts', 'utf8');

code = code.replace(
  "const isVerify = args.includes('--verify');",
  "const isVerify = args.includes('--verify');\n  const isRegister = args.includes('--register');"
);

code = code.replace(
  "console.error('Usage: npx ts-node scripts/fb-account-setup.ts --account <name> [--cookies \"...\"] [--verify]');",
  "console.error('Usage: npx ts-node scripts/fb-account-setup.ts --account <name> [--cookies \"...\"] [--verify] [--register]');"
);

// Add the logic to create empty session if --register
const registerLogic = `
  if (isRegister) {
    console.log('📝 Initializing empty session for new account registration...');
    fs.writeFileSync(sessionPath, JSON.stringify({ cookies: [], origins: [] }, null, 2));
    if (!fs.existsSync(metaPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({ status: 'registering', createdAt: new Date().toISOString() }, null, 2));
    }
  }
`;

code = code.replace(
  "// ── Step 1: Import cookies if provided ──────────────────────────────────────",
  registerLogic + "\n  // ── Step 1: Import cookies if provided ──────────────────────────────────────"
);

fs.writeFileSync('scripts/fb-account-setup.ts', code);
