export async function readRequestText(request, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('Request body is too large.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function sendJson(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}
