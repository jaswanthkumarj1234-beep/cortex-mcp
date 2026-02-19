const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.cortex', 'cortex.db');
const TOTAL_WORKERS = 3;
const MEMORIES_PER_WORKER = 300;
const TOTAL_MEMORIES = TOTAL_WORKERS * MEMORIES_PER_WORKER;

console.log('🔥 STARTING CHAOS TEST: CORTEX MCP MEMORY STORE');
console.log(`target: ${DB_PATH}`);
console.log(`workers: ${TOTAL_WORKERS}`);
console.log(`memories total: ${TOTAL_MEMORIES}`);

// Worker function: Spawn a node process that runs specific DB operations
function runWorker(id) {
    return new Promise((resolve, reject) => {
        const script = `
            const Database = require('better-sqlite3');
            const path = require('path');
            const os = require('os');
            
            const dbPath = path.join(os.homedir(), '.cortex', 'cortex.db');
            const db = new Database(dbPath, { timeout: 5000 }); // Wait 5s for lock
            
            const workerId = ${id};
            const count = ${MEMORIES_PER_WORKER};
            
            let success = 0;
            let collisions = 0;

            const content = 'Chaos Memory from Worker ' + workerId + ' - ' + Date.now();
            
            const stmt = db.prepare(\`
                INSERT INTO memories (id, type, intent, content, created_at, is_active, confidence)
                VALUES (?, ?, ?, ?, ?, 1, 1.0)
            \`);

            const verifyStmt = db.prepare('SELECT id FROM memories WHERE id = ?');
            
            for (let i = 0; i < count; i++) {
                const memId = 'chaos-' + workerId + '-' + i + '-' + Math.random().toString(36).substring(7);
                try {
                    stmt.run(memId, 'INSIGHT', 'Chaos Test ' + i, content, Date.now());
                    
                    // Verify immediately
                    const check = verifyStmt.get(memId);
                    if (check && check.id === memId) {
                        success++;
                    } else {
                        console.error('Worker ' + workerId + ' failed verification for ' + memId);
                    }
                    
                } catch (err) {
                    if (err.code === 'SQLITE_BUSY') {
                        collisions++;
                        // Simple retry
                        try {
                           stmt.run(memId, 'INSIGHT', 'Chaos Test Retry ' + i, content, Date.now());
                           success++;
                        } catch (e) {
                           console.error('Worker ' + workerId + ' retry failed: ' + e.message);
                        }
                    } else {
                        console.error('Worker ' + workerId + ' error: ' + err.message);
                    }
                }
            }
            
            console.log(JSON.stringify({ worker: workerId, success, collisions }));
            db.close();
        `;

        const child = spawn('node', ['-e', script], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        let error = '';

        child.stdout.on('data', (d) => output += d.toString());
        child.stderr.on('data', (d) => error += d.toString());

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker ${id} failed with code ${code}: ${error}`));
            } else {
                try {
                    const result = JSON.parse(output.trim());
                    resolve(result);
                } catch (e) {
                    reject(new Error(`Worker ${id} invalid output: ${output} / ${error}`));
                }
            }
        });
    });
}

// Main execution
async function main() {
    const startTime = Date.now();

    // 1. Ensure DB exists and schema is initialized
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Initialize schema in main process to avoid table creation race conditions
    const db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            intent TEXT,
            content TEXT NOT NULL,
            created_at INTEGER,
            is_active INTEGER DEFAULT 1,
            confidence REAL DEFAULT 1.0,
            embedding BLOB
        )
    `);
    db.close();

    console.log('\n🚀 Spawning concurrent workers...');

    const promises = [];
    for (let i = 0; i < TOTAL_WORKERS; i++) {
        promises.push(runWorker(i));
    }

    try {
        const results = await Promise.all(promises);

        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;

        let totalSuccess = 0;
        let totalCollisions = 0;

        console.log('\nWORKER RESULTS:');
        results.forEach(r => {
            console.log(`   Worker ${r.worker}: ${r.success} successes, ${r.collisions} collisions (handled)`);
            totalSuccess += r.success;
            totalCollisions += r.collisions;
        });

        console.log('\n📈 SUMMARY:');
        console.log(`   Total Writes: ${totalSuccess} / ${TOTAL_MEMORIES}`);
        console.log(`   Total Collisions (Busy): ${totalCollisions}`);
        console.log(`   Time Taken: ${duration.toFixed(2)}s`);
        console.log(`   Throughput: ${(totalSuccess / duration).toFixed(0)} ops/sec`);

        if (totalSuccess >= TOTAL_MEMORIES * 0.95) {
            console.log('\n✅ CHAOS TEST PASSED (Concurrency Handled)');
            process.exit(0);
        } else {
            console.error('\n❌ CHAOS TEST FAILED (Too many failures)');
            process.exit(1);
        }

    } catch (err) {
        console.error('\n❌ CHAOS TEST CRASHED:', err);
        process.exit(1);
    }
}

main();
