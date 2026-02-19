const { spawn } = require('child_process');

const server = spawn('node', [
    'C:\\Users\\ASUS\\Desktop\\cognitive-memory\\dist\\mcp-stdio.js',
    'C:\\Users\\ASUS\\Desktop\\cognitive-memory'
]);

let output = '';
server.stdout.on('data', d => { output += d.toString(); console.log('STDOUT:', d.toString().trim()); });
server.stderr.on('data', d => console.log('STDERR:', d.toString().trim()));
server.on('error', e => console.log('ERROR:', e.message));
server.on('close', code => { console.log('EXIT:', code); });

const messages = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"force_recall","arguments":{"topic":"date formatting"}}}',
];

let i = 0;
function sendNext() {
    if (i >= messages.length) {
        setTimeout(() => { server.kill(); }, 2000);
        return;
    }
    console.log('SENDING:', messages[i].substring(0, 80) + '...');
    server.stdin.write(messages[i] + '\n');
    i++;
    setTimeout(sendNext, 500);
}

setTimeout(sendNext, 1000);
