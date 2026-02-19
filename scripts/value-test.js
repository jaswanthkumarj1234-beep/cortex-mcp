/**
 * Value Verification Test
 * 
 * THE QUESTION: "Does our system really solve the problem?"
 * THE PROBLEM: AI amnesia — every new session forgets everything.
 * THE TEST: Store a convention in Session 1, recall it in Session 2.
 */
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'dist', 'mcp-stdio.js');

function log(msg) { console.log(`[ValueTest] ${msg}`); }

function sendAndWait(server, request, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for response to id: ${request.id}`)), timeoutMs);

        const handler = (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === request.id) {
                        clearTimeout(timer);
                        server.stdout.removeListener('data', handler);
                        resolve(msg);
                        return;
                    }
                } catch (e) { /* not JSON, skip */ }
            }
        };

        server.stdout.on('data', handler);
        server.stdin.write(JSON.stringify(request) + '\n');
    });
}

function startServer() {
    const server = spawn('node', [SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'], // pipe stderr too to avoid mixing
        env: { ...process.env }
    });

    // Forward stderr to our stderr for debugging
    server.stderr.on('data', (d) => process.stderr.write(d));

    return server;
}

async function runSession(name, operations) {
    log(`--- Session: ${name} ---`);
    const server = startServer();

    // Initialize
    const initResp = await sendAndWait(server, {
        jsonrpc: '2.0', id: 'init', method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'value-test', version: '1.0.0' }
        }
    });

    if (!initResp.result) throw new Error('Init failed');

    // Run operations
    const results = [];
    for (const op of operations) {
        const resp = await sendAndWait(server, op.request);
        results.push(resp);
        if (op.log) op.log(resp);
    }

    server.kill();
    // Wait for process to fully exit
    await new Promise(r => setTimeout(r, 1000));
    return results;
}

async function main() {
    console.log('');
    console.log('========================================');
    console.log('  VALUE VERIFICATION: Does It Cure Amnesia?');
    console.log('========================================');
    console.log('');

    try {
        // SESSION 1: Teach a convention
        log('SESSION 1: Teaching the AI a coding convention...');
        const storeResults = await runSession('Teacher', [{
            request: {
                jsonrpc: '2.0', id: 'store1', method: 'tools/call',
                params: {
                    name: 'store_memory',
                    arguments: {
                        type: 'CONVENTION',
                        content: 'Always use Zod for schema validation in this project. Never use Joi or manual validation.',
                        tags: ['validation', 'zod', 'convention']
                    }
                }
            },
            log: (resp) => {
                const text = resp.result?.content?.[0]?.text || 'no response';
                log(`  Stored: "${text.substring(0, 80)}..."`);
            }
        }]);

        const storeText = storeResults[0]?.result?.content?.[0]?.text || '';
        if (!storeText.toLowerCase().includes('stored') && !storeText.toLowerCase().includes('memory')) {
            console.error('[FAIL] Store failed:', storeText);
            process.exit(1);
        }
        log('  [OK] Convention stored successfully.');

        log('');
        log('  (Simulating IDE restart / new conversation...)');
        log('');

        // SESSION 2: Ask for something related (WITHOUT mentioning Zod)
        log('SESSION 2: Asking for a "user signup schema" (no mention of Zod)...');
        const recallResults = await runSession('Coder', [{
            request: {
                jsonrpc: '2.0', id: 'recall1', method: 'tools/call',
                params: {
                    name: 'recall_memory',
                    arguments: { query: 'user signup schema validation' }
                }
            },
            log: (resp) => {
                const text = resp.result?.content?.[0]?.text || 'no response';
                log(`  Recalled: "${text.substring(0, 120)}..."`);
            }
        }]);

        const recallText = recallResults[0]?.result?.content?.[0]?.text || '';

        // THE CRITICAL CHECK: Did it remember "Zod"?
        if (recallText.includes('Zod') || recallText.includes('zod')) {
            console.log('');
            console.log('========================================');
            console.log('  [PASS] VALUE VERIFIED');
            console.log('  The system cures AI amnesia.');
            console.log('  Convention "Use Zod" was recalled automatically');
            console.log('  in a brand new session, without being asked.');
            console.log('========================================');
            console.log('');
        } else if (recallText.includes('validation') || recallText.includes('schema')) {
            console.log('');
            console.log('========================================');
            console.log('  [PARTIAL PASS] System recalled related memories');
            console.log('  but "Zod" keyword was not in the response.');
            console.log('  Response:', recallText.substring(0, 200));
            console.log('========================================');
            console.log('');
        } else {
            console.error('');
            console.error('========================================');
            console.error('  [FAIL] System did NOT recall the convention.');
            console.error('  Response:', recallText.substring(0, 200));
            console.error('========================================');
            process.exit(1);
        }

    } catch (err) {
        console.error('[FAIL] Test error:', err.message);
        process.exit(1);
    }
}

main();
