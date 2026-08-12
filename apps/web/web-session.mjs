import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const COOKIE_NAME = '__Host-snaptex-session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_SESSIONS = 128;
const MAX_LOGIN_BYTES = 16 * 1024;
const MAX_FAILURES = 10;
const MAX_FAILURE_SOURCES = 4096;
const LOCKOUT_MS = 30 * 24 * 60 * 60_000;

/** Provides the shared browser-session HTTP contract for a standalone SnapTeX server. */
export function createWebSessionAuth(options) {
    if (!options) {
        return {
            handle: (_request, response, pathname) => {
                if (pathname !== '/web-auth/session') return false;
                sendJson(response, 200, { authenticated: true, csrfToken: '' });
                return true;
            },
            authorize: () => true,
            clear: () => undefined
        };
    }
    const { username, password } = options;
    if (!username || !password || !options.publicOrigin) {
        throw new Error('Web Session auth requires username, password, and publicOrigin.');
    }
    const publicOrigin = new URL(options.publicOrigin).origin;
    const publicPath = normalizePublicPath(options.publicPath);
    const sessions = new Map();
    const loginFailures = new Map();

    function findSession(request) {
        const id = readCookie(request.headers.cookie, COOKIE_NAME);
        const value = id && sessions.get(id);
        if (!value) return undefined;
        if (value.expiresAt <= Date.now()) {
            sessions.delete(id);
            return undefined;
        }
        return { id, value };
    }

    async function handle(request, response, pathname) {
        if (!pathname.startsWith('/web-auth/')) return false;
        response.setHeader('Cache-Control', 'no-store');
        if (pathname === '/web-auth/login' && request.method === 'GET') {
            response.setHeader('Referrer-Policy', 'same-origin');
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(loginPage(safeReturnTo(new URL(request.url, publicOrigin).searchParams.get('return_to'), publicPath)));
            return true;
        }
        if (pathname === '/web-auth/login' && request.method === 'POST') {
            if (!sameOrigin(request, response, publicOrigin)) return true;
            const form = new URLSearchParams(await readBody(request, MAX_LOGIN_BYTES));
            const returnTo = safeReturnTo(form.get('return_to'), publicPath);
            const now = Date.now();
            const source = requestSource(request);
            const failure = loginFailures.get(source);
            if (failure?.lockedUntil > now) {
                response.setHeader('Retry-After', String(Math.ceil((failure.lockedUntil - now) / 1000)));
                response.writeHead(429);
                response.end('Login is temporarily locked after repeated failures.');
                return true;
            }
            const usernameMatches = constantTimeEqual(form.get('username') ?? '', username);
            const passwordMatches = constantTimeEqual(form.get('password') ?? '', password);
            if (!usernameMatches || !passwordMatches) {
                pruneLoginFailures(loginFailures, now);
                const failedAttempts = (loginFailures.get(source)?.failedAttempts ?? 0) + 1;
                const lockedUntil = failedAttempts >= MAX_FAILURES ? now + LOCKOUT_MS : 0;
                loginFailures.delete(source);
                loginFailures.set(source, { failedAttempts, lockedUntil, lastAttemptAt: now });
                if (lockedUntil) {
                    response.setHeader('Retry-After', String(LOCKOUT_MS / 1000));
                }
                response.writeHead(failedAttempts >= MAX_FAILURES ? 429 : 401, { 'Content-Type': 'text/html; charset=utf-8' });
                response.end(loginPage(returnTo, 'Invalid username or password.'));
                return true;
            }
            loginFailures.delete(source);
            pruneSessions(sessions);
            while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
            const id = randomBytes(32).toString('base64url');
            sessions.set(id, {
                csrfToken: randomBytes(32).toString('base64url'),
                expiresAt: now + SESSION_TTL_SECONDS * 1000
            });
            response.setHeader('Set-Cookie', sessionCookie(id, SESSION_TTL_SECONDS));
            response.writeHead(303, { Location: returnTo });
            response.end();
            return true;
        }

        const session = findSession(request);
        if (!session) {
            sendJson(response, 401, { error: 'unauthorized' });
            return true;
        }
        if (pathname === '/web-auth/session' && request.method === 'GET') {
            sendJson(response, 200, { authenticated: true, csrfToken: session.value.csrfToken });
            return true;
        }
        if (pathname === '/web-auth/check' && request.method === 'GET') {
            const originalMethod = String(request.headers['x-original-method'] ?? 'GET').toUpperCase();
            if (!SAFE_METHODS.has(originalMethod) && request.headers['x-csrf-token'] !== session.value.csrfToken) {
                response.writeHead(403);
                response.end();
                return true;
            }
            response.setHeader('X-Authenticated-User', username);
            response.setHeader('X-Authenticated-CSRF', session.value.csrfToken);
            response.writeHead(204);
            response.end();
            return true;
        }
        if (pathname === '/web-auth/logout' && request.method === 'POST') {
            if (!sameOrigin(request, response, publicOrigin) || request.headers['x-csrf-token'] !== session.value.csrfToken) {
                if (!response.headersSent) {
                    response.writeHead(403);
                    response.end();
                }
                return true;
            }
            sessions.delete(session.id);
            response.setHeader('Set-Cookie', sessionCookie('', 0));
            response.writeHead(204);
            response.end();
            return true;
        }
        response.writeHead(405);
        response.end('Method not allowed');
        return true;
    }

    function authorize(request, response) {
        const session = findSession(request);
        if (!session) {
            sendJson(response, 401, { error: 'unauthorized' });
            return false;
        }
        if (!SAFE_METHODS.has(request.method ?? 'GET') &&
            (!sameOrigin(request, response, publicOrigin) || request.headers['x-csrf-token'] !== session.value.csrfToken)) {
            if (!response.headersSent) {
                response.writeHead(403);
                response.end();
            }
            return false;
        }
        return true;
    }

    return {
        handle,
        authorize,
        clear: () => {
            sessions.clear();
            loginFailures.clear();
        }
    };
}

function normalizePublicPath(value = '/') {
    const path = `/${value}`.replace(/\/{2,}/g, '/');
    const normalized = path.endsWith('/') ? path : `${path}/`;
    if (normalized !== '/' && (!/^\/[A-Za-z0-9._~/-]*\/$/.test(normalized) || normalized.includes('/../') || normalized.includes('/./'))) {
        throw new Error('publicPath must be an absolute URL path.');
    }
    return normalized;
}

function requestSource(request) {
    const socketAddress = String(request.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const forwardedAddress = request.headers['x-real-ip'];
    if ((socketAddress === '127.0.0.1' || socketAddress === '::1') &&
        typeof forwardedAddress === 'string' && isIP(forwardedAddress.trim())) {
        return forwardedAddress.trim();
    }
    return socketAddress;
}

function pruneLoginFailures(failures, now) {
    for (const [source, failure] of failures) {
        if (failure.lockedUntil <= now && failure.lastAttemptAt + LOCKOUT_MS <= now) {
            failures.delete(source);
        }
    }
    while (failures.size >= MAX_FAILURE_SOURCES) failures.delete(failures.keys().next().value);
}

function safeReturnTo(value, fallback) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
        /[\\\u0000-\u001f\u007f]/.test(value) || value.length > 2048) return fallback;
    const url = new URL(value, 'https://snaptex.invalid');
    return url.origin === 'https://snaptex.invalid' && url.pathname.startsWith(fallback)
        ? `${url.pathname}${url.search}`
        : fallback;
}

function sameOrigin(request, response, publicOrigin) {
    if (request.headers.origin === publicOrigin) return true;
    sendJson(response, 403, { error: 'origin_not_allowed' });
    return false;
}

function readCookie(header = '', name) {
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator >= 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
    }
    return undefined;
}

async function readBody(request, maximum) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maximum) throw new Error('Request body is too large.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function constantTimeEqual(left, right) {
    return timingSafeEqual(
        createHash('sha256').update(left).digest(),
        createHash('sha256').update(right).digest()
    );
}

function pruneSessions(sessions) {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
}

function sessionCookie(value, maxAge) {
    return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function sendJson(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function loginPage(returnTo, error = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SnapTeX Login</title><style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:24px}input{box-sizing:border-box;width:100%;padding:10px;margin:6px 0 16px}button{padding:10px 18px}.e{color:#b00}</style></head><body><h1>SnapTeX Server</h1><p>Sign in to access remote projects.</p>${error ? `<p class="e">${escapeHtml(error)}</p>` : ''}<form method="post"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></body></html>`;
}
