const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.cortex', 'cortex.db');
const ITERATIONS = 2000;

console.log('💧 STARTING MEMORY LEAK TEST');
console.log(`target: ${DB_PATH}`);
console.log(`iterations: ${ITERATIONS}`);

function runLeakCheck() {
    return new Promise((resolve, reject) => {
        const script = `
            const Database = require('better-sqlite3');
            const path = require('path');
            const os = require('os');
            
            const dbPath = path.join(os.homedir(), '.cortex', 'cortex.db');
            const db = new Database(dbPath);
            
            // Initial memory usage
            const startMem = process.memoryUsage().heapUsed / 1024 / 1024;
            console.log('Start Memory: ' + startMem.toFixed(2) + ' MB');
            
            const stmt = db.prepare(\`
                INSERT INTO memories (id, type, intent, content, created_at, is_active, confidence)
                VALUES (?, ?, ?, ?, ?, 1, 1.0)
            \`);
            
            const delStmt = db.prepare('DELETE FROM memories WHERE id = ?');
            
            // Run loop
            for (let i = 0; i < ${ITERATIONS}; i++) {
                const id = 'leak-' + i;
                stmt.run(id, 'INSIGHT', 'Leak Test', 'Content ' + i, Date.now());
                if (i % 10 === 0) {
                     delStmt.run(id); // cleanup to keep DB size constant, check only process RAM
                }
                
                if (i % 500 === 0) {
                     if (global.gc) global.gc(); // Force GC if available to measure real leaks
                     const current = process.memoryUsage().heapUsed / 1024 / 1024;
                     // console.log('Iter ' + i + ': ' + current.toFixed(2) + ' MB');
                }
            }
            
            if (global.gc) global.gc();
            const endMem = process.memoryUsage().heapUsed / 1024 / 1024;
            console.log('End Memory:   ' + endMem.toFixed(2) + ' MB');
            console.log('Growth:       ' + (endMem - startMem).toFixed(2) + ' MB');
            
            db.close();
        `;

        const child = spawn('node', ['--expose-gc', '-e', script], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        child.stdout.on('data', d => output += d.toString());
        child.stderr.on('data', d => console.error(d.toString()));

        child.on('close', (code) => {
            if (code !== 0) reject(new Error('Process crashed'));
            resolve(output);
        });
    });
}

async function main() {
    try {
        const output = await runLeakCheck();
        console.log(output);

        // Parse output for growth
        const match = output.match(/Growth:\s+([0-9.-]+) MB/);
        if (match) {
            const growth = parseFloat(match[1]);
            if (growth < 10) { // Allow <10MB fluctuation
                console.log('✅ MEMORY LEAK TEST PASSED (Stable RAM usage)');
                process.exit(0);
            } else {
                console.error('❌ MEMORY LEAK DETECTED (Growth > 10MB)');
                process.exit(1);
            }
        } else {
            console.error('❌ COULD NOT READ MEMORY STATS');
            process.exit(1);
        }
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

main();
