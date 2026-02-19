#!/usr/bin/env node
/**
 * Cortex Automated Test Suite
 * 
 * Tests:
 * 1. Memory store — add, dedup, search, update
 * 2. MCP handshake — initialize + tools/list
 * 3. verify_code — catches fake imports
 * 
 * Run: node scripts/test-suite.js
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT_ROOT = path.join(__dirname, '..');
const MCP_SERVER = path.join(PROJECT_ROOT, 'dist', 'mcp-stdio.js');
const TEST_DB_DIR = path.join(os.tmpdir(), 'cortex-test-' + Date.now());

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  [PASS] ${message}`);
        passed++;
    } else {
        console.error(`  [FAIL] ${message}`);
        failed++;
    }
}

function assertEqual(actual, expected, message) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  [PASS] ${message}`);
        passed++;
    } else {
        console.error(`  [FAIL] ${message}`);
        console.error(`     Expected: ${JSON.stringify(expected)}`);
        console.error(`     Actual:   ${JSON.stringify(actual)}`);
        failed++;
    }
}

// ─── Test 1: Memory Store ─────────────────────────────────────────────────────

async function testMemoryStore() {
    console.log('\n[TEST] Test 1: Memory Store');

    // Dynamically require the compiled module
    const { CognitiveDatabase } = require(path.join(PROJECT_ROOT, 'dist', 'db', 'database'));
    const { MemoryStore } = require(path.join(PROJECT_ROOT, 'dist', 'db', 'memory-store'));

    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    const db = new CognitiveDatabase(TEST_DB_DIR);
    const store = new MemoryStore(db);

    // Test: add a memory
    const m1 = store.add({
        type: 'CONVENTION',
        intent: 'Always use functional components never class components',
        action: 'Always use functional components never class components',
    });
    assert(m1.id, 'Memory created with ID');
    assert(m1.isActive, 'Memory is active');

    // Test: deduplication — same intent should return existing
    const m2 = store.add({
        type: 'CONVENTION',
        intent: 'Always use functional components never class components in React',
        action: 'Always use functional components never class components in React',
    });
    assertEqual(m1.id, m2.id, 'Duplicate memory returns existing (deduplication works)');

    // Test: different type should NOT deduplicate
    const m3 = store.add({
        type: 'DECISION',
        intent: 'Always use functional components never class components',
        action: 'Always use functional components never class components',
    });
    assert(m1.id !== m3.id, 'Different type creates new memory (no false dedup)');

    // Test: active count
    const count = store.activeCount();
    assert(count >= 2, `Active count is ${count} (at least 2)`);

    // Test: deactivate
    store.deactivate(m3.id);
    const afterDeactivate = store.activeCount();
    assert(afterDeactivate < count, 'Deactivate reduces active count');

    db.close();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

// ─── Test 2: MCP Handshake ────────────────────────────────────────────────────

async function testMCPHandshake() {
    console.log('\n[TEST] Test 2: MCP Handshake');

    return new Promise((resolve) => {
        const server = spawn('node', [MCP_SERVER, PROJECT_ROOT], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let output = '';
        let resolved = false;

        server.stdout.on('data', (chunk) => {
            output += chunk.toString();
            // Try to parse each line
            const lines = output.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === 1 && msg.result) {
                        assert(msg.result.serverInfo, 'Server returns serverInfo in initialize');
                        assert(msg.result.capabilities, 'Server returns capabilities');

                        // Send tools/list
                        const toolsReq = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
                        server.stdin.write(toolsReq + '\n');
                    }
                    if (msg.id === 2 && msg.result) {
                        const tools = msg.result.tools || [];
                        const toolNames = tools.map(t => t.name);
                        assert(toolNames.includes('force_recall'), 'force_recall tool registered');
                        assert(toolNames.includes('quick_store'), 'quick_store tool registered');
                        assert(toolNames.includes('verify_code'), 'verify_code tool registered');
                        assert(toolNames.includes('update_memory'), 'update_memory tool registered');
                        assert(toolNames.includes('recall_memory'), 'recall_memory tool registered');
                        assert(toolNames.includes('list_memories'), 'list_memories tool registered');
                        assert(toolNames.includes('delete_memory'), 'delete_memory tool registered');
                        assert(toolNames.includes('auto_learn'), 'auto_learn tool registered');
                        assert(toolNames.includes('export_memories'), 'export_memories tool registered');
                        assert(toolNames.includes('import_memories'), 'import_memories tool registered');
                        assert(toolNames.includes('health_check'), 'health_check tool registered');

                        if (!resolved) {
                            resolved = true;
                            server.kill();
                            resolve();
                        }
                    }
                } catch { /* partial JSON, wait for more */ }
            }
        });

        server.stderr.on('data', () => { }); // suppress stderr

        // Send initialize
        const initReq = JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
        });
        server.stdin.write(initReq + '\n');

        // Timeout after 10s
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                assert(false, 'MCP handshake timed out after 10s');
                server.kill();
                resolve();
            }
        }, 10000);
    });
}

// ─── Test 3: verify_code ─────────────────────────────────────────────────────

async function testVerifyCode() {
    console.log('\n[TEST] Test 3: verify_code -- Hallucination Detection');

    const { verifyCode } = require(path.join(PROJECT_ROOT, 'dist', 'scanners', 'code-verifier'));

    // Test: fake package should be flagged
    const fakeImportCode = `import { magic } from 'totally-fake-package-xyz';`;
    const result1 = verifyCode(fakeImportCode, PROJECT_ROOT);
    assert(result1.imports.invalid.includes('totally-fake-package-xyz'), 'Fake package import is flagged in imports.invalid');

    // Test: real package should pass
    const realImportCode = `import { v4 as uuidv4 } from 'uuid';`;
    const result2 = verifyCode(realImportCode, PROJECT_ROOT);
    assert(result2.imports.invalid.length === 0, 'Real package (uuid) passes — no invalid imports');
    assert(result2.imports.valid.includes('uuid'), 'Real package (uuid) is in valid list');

    // Test: empty code should pass
    const result3 = verifyCode('const x = 1;', PROJECT_ROOT);
    assert(result3.imports.invalid.length === 0, 'Code with no imports has no invalid imports');
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('Cortex Test Suite\n' + '='.repeat(40));

    try {
        await testMemoryStore();
    } catch (err) {
        console.error('  ❌ Memory store test crashed:', err.message);
        failed++;
    }

    try {
        await testMCPHandshake();
    } catch (err) {
        console.error('  ❌ MCP handshake test crashed:', err.message);
        failed++;
    }

    try {
        await testVerifyCode();
    } catch (err) {
        console.error('  ❌ verify_code test crashed:', err.message);
        failed++;
    }

    console.log('\n' + '='.repeat(40));
    console.log(`Results: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        console.error('\n[FAIL] Some tests failed!');
        process.exit(1);
    } else {
        console.log('\n[PASS] All tests passed!');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
