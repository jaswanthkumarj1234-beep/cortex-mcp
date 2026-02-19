const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const TARGET = 'host'; // Use current Node version (v22) to match native module compilation


// Ensure bin directory exists
if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
}

console.log('[BUILD] Building Cortex MCP Binaries...');

// 1. Rebuild TypeScript
try {
    console.log('[BUILD] Compiling TypeScript...');
    execSync('npm run build', { stdio: 'inherit', cwd: PROJECT_ROOT });
} catch (e) {
    console.error('[FAIL] TypeScript build failed');
    process.exit(1);
}

// 2. Run pkg
try {
    console.log(`[BUILD] Packaging for ${TARGET}...`);
    // npx pkg . --target host --output bin/cortex-host.exe
    execSync(`npx pkg . --target ${TARGET} --output bin/cortex-win.exe`, { stdio: 'inherit', cwd: PROJECT_ROOT });
} catch (e) {
    console.error('[FAIL] Pkg build failed');
    process.exit(1);
}

// 3. Copy Native Module (better_sqlite3.node)
try {
    console.log('[BUILD] Bundling native modules...');
    const sourceNode = path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    const destNode = path.join(BIN_DIR, 'better_sqlite3.node');

    if (fs.existsSync(sourceNode)) {
        fs.copyFileSync(sourceNode, destNode);
        console.log(`[OK] Copied better_sqlite3.node to bin/`);
    } else {
        console.warn(`[WARN] Warning: better_sqlite3.node not found at ${sourceNode}`);
        console.warn('   The binary might fail correctly unless the native module is present.');
    }
} catch (e) {
    console.error('[FAIL] Failed to copy native module:', e);
}

console.log('\n[OK] Build Complete!');
console.log(`   Executable: ${path.join(BIN_DIR, 'cortex-win.exe')}`);
console.log('   (Requires better_sqlite3.node in same folder)\n');
