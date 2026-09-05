import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { readRequestText, sendJson } from './http-utils.mjs';

const COOKIE_NAME = '__Host-snaptex-session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const REMEMBERED_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSIONS = 128;
const MAX_LOGIN_BYTES = 16 * 1024;
const MAX_FAILURES = 10;
const MAX_FAILURE_SOURCES = 4096;
const FAILURE_WINDOW_MS = 30 * 60_000;
const LOCKOUT_MS = 30 * 24 * 60 * 60_000;

/** Provides the shared browser-session HTTP contract for a standalone SnapTeX server. */
export function createWebSessionAuth(options) {
    if (!options) {
        return {
            handle: () => false,
            authorize: () => true,
            clear: () => undefined
        };
    }
    const { username, password } = options;
    if (!username || !password || !options.publicOrigin) {
        throw new Error('Web Session auth requires username, password, and publicOrigin.');
    }
    if (/[\u0000-\u001f\u007f]/.test(username)) {
        throw new Error('Web Session username cannot contain control characters.');
    }
    if (password.length < 16) {
        throw new Error('Web Session password must contain at least 16 characters.');
    }
    const publicUrl = new URL(options.publicOrigin);
    if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password ||
        publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
        throw new Error('Web Session publicOrigin must be an HTTPS origin without a path.');
    }
    const publicOrigin = publicUrl.origin;
    const publicPath = normalizePublicPath(options.publicPath);
    const sessions = loadSessions(options.sessionFile);
    const loginFailures = new Map();

    function findSession(request) {
        const id = readCookie(request.headers.cookie, COOKIE_NAME);
        const value = id && sessions.get(id);
        if (!value) return undefined;
        if (value.expiresAt <= Date.now()) {
            sessions.delete(id);
            saveSessions(options.sessionFile, sessions);
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
            const form = new URLSearchParams(await readRequestText(request, MAX_LOGIN_BYTES));
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
                recordLoginFailure(loginFailures, source, { failedAttempts, lockedUntil, lastAttemptAt: now }, now);
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
            const ttlSeconds = form.get('remember') === '1'
                ? REMEMBERED_SESSION_TTL_SECONDS
                : SESSION_TTL_SECONDS;
            sessions.set(id, {
                csrfToken: randomBytes(32).toString('base64url'),
                expiresAt: now + ttlSeconds * 1000
            });
            saveSessions(options.sessionFile, sessions);
            response.setHeader('Set-Cookie', sessionCookie(id, ttlSeconds));
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
            saveSessions(options.sessionFile, sessions);
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

function loadSessions(path) {
    if (!path) return new Map();
    let stored;
    try {
        stored = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return new Map();
        throw new Error(`Cannot read Web Session store: ${error.message}`);
    }
    if (!Array.isArray(stored) || stored.length > MAX_SESSIONS) throw new Error('Invalid Web Session store.');
    const sessions = new Map();
    for (const entry of stored) {
        if (!Array.isArray(entry) || entry.length !== 2 || !/^[A-Za-z0-9_-]{32,}$/.test(entry[0]) ||
            !entry[1] || !/^[A-Za-z0-9_-]{32,}$/.test(entry[1].csrfToken) || !Number.isFinite(entry[1].expiresAt)) {
            throw new Error('Invalid Web Session store.');
        }
        if (entry[1].expiresAt > Date.now()) sessions.set(entry[0], entry[1]);
    }
    return sessions;
}

function saveSessions(path, sessions) {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify([...sessions]), { mode: 0o600 });
    renameSync(tempPath, path);
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
        if (failure.lockedUntil <= now && failure.lastAttemptAt + FAILURE_WINDOW_MS <= now) {
            failures.delete(source);
        }
    }
}

function recordLoginFailure(failures, source, failure, now) {
    if (!failures.has(source) && failures.size >= MAX_FAILURE_SOURCES) {
        for (const [candidate, value] of failures) {
            if (value.lockedUntil > now) continue;
            failures.delete(candidate);
            break;
        }
        if (failures.size >= MAX_FAILURE_SOURCES) failures.delete(failures.keys().next().value);
    }
    failures.delete(source);
    failures.set(source, failure);
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

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function loginPage(returnTo, error = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SnapTeX Login</title><style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:24px}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:10px;margin:6px 0 16px}.remember{display:block;margin-bottom:18px}button{padding:10px 18px}.e{color:#b00}</style></head><body><h1>SnapTeX Server</h1><p>Sign in to access remote projects.</p>${error ? `<p class="e">${escapeHtml(error)}</p>` : ''}<form method="post"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><label class="remember"><input name="remember" type="checkbox" value="1"> Keep me signed in for 30 days</label><button type="submit">Sign in</button></form></body></html>`;
}
