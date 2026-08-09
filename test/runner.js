/**
 * Playwright test runner for Lexia Core5 Ruffle
 * 
 * Tests:
 *  - Page loads and Ruffle initializes
 *  - Service Worker registers and activates
 *  - SWF loads in Ruffle player
 *  - AMF gateway requests are intercepted by Service Worker
 *  - Screenshots at 5s, 15s, 30s, 45s, 60s, 75s, 90s
 *  - Console logs, network requests, and page errors captured
 *  - Summary report with pass/fail and metrics
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const LOG_DIR = path.join(__dirname, 'logs');

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const consoleLog = fs.createWriteStream(path.join(LOG_DIR, 'console.log'));
const networkLog = fs.createWriteStream(path.join(LOG_DIR, 'network.log'));
const swLog = fs.createWriteStream(path.join(LOG_DIR, 'service-worker.log'));
const summaryLog = fs.createWriteStream(path.join(LOG_DIR, 'summary.txt'));

const ts = () => new Date().toISOString();

async function run() {
    consoleLog.write(`# Lexia Core5 Ruffle Test — ${ts()}\n# URL: ${BASE_URL}\n# Playwright + Chromium headless\n\n`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--enable-unsafe-swiftshader'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 1024 },
    });

    const page = await context.newPage();

    const state = {
        errors: [],
        warnings: [],
        networkReqs: [],
        amfReqs: [],
        amfResponses: [],
        swMessages: [],
        swRegistered: false,
        swActive: false,
        swIntercepted: 0,
        ruffleVersion: null,
        swfLoaded: false,
        swfError: null,
        pageErrors: 0,
    };

    // ── Console capture ──
    page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();
        const line = `[${ts()}] [${type.toUpperCase()}] ${text}\n`;
        consoleLog.write(line);

        if (type === 'error') { state.errors.push(text); state.pageErrors++; }
        if (type === 'warning') state.warnings.push(text);
        if (text.includes('Ruffle') && text.includes('version')) state.ruffleVersion = text;
        if (text.includes('SWF loaded')) state.swfLoaded = true;
        if (text.includes('SWF FAIL') || text.includes('SWF FAILED')) state.swfError = text;
        if (text.includes('[SW]')) {
            swLog.write(line);
            state.swMessages.push(text);
            if (text.includes('Intercepted AMF')) state.swIntercepted++;
        }
    });

    page.on('pageerror', err => {
        const line = `[${ts()}] [PAGE_ERROR] ${err.message}\n${err.stack || ''}\n`;
        consoleLog.write(line);
        state.errors.push(`PAGE_ERROR: ${err.message}`);
        state.pageErrors++;
    });

    // ── Network capture ──
    page.on('request', req => {
        const url = req.url();
        const method = req.method();
        const rtype = req.resourceType();
        state.networkReqs.push({ url, method, rtype, ts: ts() });
        networkLog.write(`[${ts()}] REQ ${method} ${rtype} ${url}\n`);
        if (url.includes('gateway.php') || url.includes('clientapi')) {
            state.amfReqs.push({ url, method, ts: ts() });
            networkLog.write(`[${ts()}] *** AMF GATEWAY REQUEST *** ${method} ${url}\n`);
        }
    });

    page.on('response', async res => {
        const url = res.url();
        const status = res.status();
        const ct = res.headers()['content-type'] || '';
        networkLog.write(`[${ts()}] RES ${status} ${url} (${ct})\n`);
        if (url.includes('gateway.php') || url.includes('clientapi')) {
            networkLog.write(`[${ts()}] *** AMF GATEWAY RESPONSE *** ${status} ${ct} ${url}\n`);
            try {
                const body = await res.body();
                state.amfResponses.push({ url, status, size: body.length, ct });
                networkLog.write(`[${ts()}] AMF response body: ${body.length} bytes, CT: ${ct}\n`);
                if (body.length > 0) {
                    // Log first 200 bytes as hex for debugging
                    const hex = Buffer.from(body.slice(0, 200)).toString('hex');
                    networkLog.write(`[${ts()}] AMF response hex (first 200B): ${hex}\n`);
                }
            } catch (e) {
                networkLog.write(`[${ts()}] Could not read AMF response body: ${e.message}\n`);
            }
        }
    });

    // ── Navigate ──
    consoleLog.write(`[${ts()}] Navigating to ${BASE_URL}\n`);
    try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        consoleLog.write(`[${ts()}] Page loaded (domcontentloaded)\n`);
    } catch (e) {
        consoleLog.write(`[${ts()}] Navigation error: ${e.message}\n`);
        state.errors.push(`Navigation: ${e.message}`);
    }

    // ── Wait for Service Worker ──
    try {
        await page.waitForFunction(
            () => navigator.serviceWorker !== undefined,
            { timeout: 5000 }
        ).catch(() => {});

        state.swRegistered = await page.evaluate(() =>
            navigator.serviceWorker?.getRegistrations?.()
                .then(regs => regs.length > 0)
                .catch(() => false)
        ).catch(() => false);

        state.swActive = await page.evaluate(() =>
            navigator.serviceWorker?.controller !== null &&
            navigator.serviceWorker?.controller !== undefined
        ).catch(() => false);

        consoleLog.write(`[${ts()}] SW registered: ${state.swRegistered}, active: ${state.swActive}\n`);

        // Wait a bit more for SW to activate if registered but not active
        if (state.swRegistered && !state.swActive) {
            consoleLog.write(`[${ts()}] Waiting for SW activation...\n`);
            for (let i = 0; i < 10; i++) {
                await page.waitForTimeout(1000);
                state.swActive = await page.evaluate(() =>
                    navigator.serviceWorker?.controller !== null &&
                    navigator.serviceWorker?.controller !== undefined
                ).catch(() => false);
                if (state.swActive) {
                    consoleLog.write(`[${ts()}] SW activated after ${(i+1)}s\n`);
                    break;
                }
            }
        }
    } catch (e) {
        consoleLog.write(`[${ts()}] SW check error: ${e.message}\n`);
    }

    // ── Screenshot schedule ──
    const times = [5000, 15000, 30000, 45000, 60000, 75000, 90000];
    for (const ms of times) {
        await page.waitForTimeout(ms).catch(() => {});
        const label = `${ms / 1000}s`;
        const file = `screen_${String(ms / 1000).padStart(2, '0')}s.png`;
        try {
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, file), fullPage: false });
            consoleLog.write(`[${ts()}] 📸 Screenshot: ${file}\n`);
        } catch (e) {
            consoleLog.write(`[${ts()}] Screenshot failed at ${label}: ${e.message}\n`);
        }

        // Capture page log content
        try {
            const logText = await page.evaluate(() => 
                document.getElementById('log')?.textContent || ''
            ).catch(() => '');
            if (logText) {
                consoleLog.write(`[${ts()}] --- Page log @ ${label} ---\n${logText}\n`);
            }
        } catch (e) {}

        // Capture Ruffle player state
        try {
            const ruffleState = await page.evaluate(() => {
                const p = document.getElementById('player');
                const inner = p?.innerHTML?.substring(0, 300) || '';
                const canvas = p?.querySelector('canvas');
                const ruffleEl = p?.querySelector('ruffle-player, embed, object');
                return {
                    hasPlayer: !!p,
                    hasCanvas: !!canvas,
                    canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
                    hasRuffleElement: !!ruffleEl,
                    innerHTML: inner,
                };
            }).catch(() => ({}));
            if (ruffleState.hasPlayer) {
                consoleLog.write(`[${ts()}] Player state @ ${label}: canvas=${ruffleState.canvasSize}, ruffleEl=${ruffleState.hasRuffleElement}\n`);
            }
        } catch (e) {}
    }

    // Final full-page screenshot
    try {
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'final_full.png'), fullPage: true });
    } catch (e) {}

    // ── Final page state ──
    let pageState = {};
    try {
        pageState = await page.evaluate(() => {
            const p = document.getElementById('player');
            const swf = p?.querySelector('canvas, embed, object, ruffle-player');
            return {
                title: document.title,
                logLines: (document.getElementById('log')?.textContent || '').split('\n').filter(l => l.trim()).length,
                hasRuffle: !!window.RufflePlayer,
                hasSWF: !!swf,
                playerHTML: p?.innerHTML?.substring(0, 500),
                swController: !!navigator.serviceWorker?.controller,
            };
        });
    } catch (e) {
        pageState = { error: e.message };
    }

    // ── Network summary ──
    const rtypes = {};
    state.networkReqs.forEach(r => { rtypes[r.rtype] = (rtypes[r.rtype] || 0) + 1; });

    // ── Summary ──
    const lines = [
        '═══════════════════════════════════════════════════════════',
        '  LEXIA CORE5 — RUFFLE TEST REPORT',
        `  Date: ${ts()}`,
        `  URL: ${BASE_URL}`,
        '═══════════════════════════════════════════════════════════',
        '',
        `  RUFFLE`,
        `    Version:     ${state.ruffleVersion || 'NOT DETECTED'}`,
        `    SWF Loaded:  ${state.swfLoaded ? '✅ YES' : '❌ NO'}`,
        `    SWF Error:   ${state.swfError || 'none'}`,
        '',
        `  SERVICE WORKER`,
        `    Registered:  ${state.swRegistered ? '✅' : '❌'}`,
        `    Active:      ${state.swActive ? '✅' : '❌'}`,
        `    Intercepted: ${state.swIntercepted} AMF requests`,
        '',
        `  NETWORK`,
        `    Total requests: ${state.networkReqs.length}`,
        `    By type: ${Object.entries(rtypes).map(([k,v]) => `${k}=${v}`).join(', ')}`,
        `    AMF requests:  ${state.amfReqs.length}`,
        `    AMF responses: ${state.amfResponses.length}`,
        '',
        `  CONSOLE`,
        `    Errors:   ${state.errors.length}`,
        `    Warnings: ${state.warnings.length}`,
        `    Page errors: ${state.pageErrors}`,
        '',
        `  PAGE STATE`,
        `    Title:           ${pageState.title || '?'}`,
        `    Has Ruffle:      ${pageState.hasRuffle ? '✅' : '❌'}`,
        `    Has SWF element:  ${pageState.hasSWF ? '✅' : '❌'}`,
        `    Log lines:       ${pageState.logLines || 0}`,
        `    SW controller:   ${pageState.swController ? '✅' : '❌'}`,
        '',
    ];

    if (pageState.playerHTML) {
        lines.push(`  PLAYER HTML (first 300 chars):`);
        lines.push(`    ${pageState.playerHTML}`);
        lines.push('');
    }

    if (state.amfReqs.length > 0) {
        lines.push('  ── AMF GATEWAY REQUESTS ──');
        state.amfReqs.forEach((r, i) => lines.push(`    ${i+1}. ${r.ts} ${r.method} ${r.url}`));
        lines.push('');
    }

    if (state.amfResponses.length > 0) {
        lines.push('  ── AMF GATEWAY RESPONSES ──');
        state.amfResponses.forEach((r, i) => 
            lines.push(`    ${i+1}. ${r.status} ${r.size}B CT=${r.ct} ${r.url.substring(0, 80)}`));
        lines.push('');
    }

    if (state.swMessages.length > 0) {
        lines.push('  ── SERVICE WORKER MESSAGES ──');
        state.swMessages.slice(0, 30).forEach(m => lines.push(`    ${m.substring(0, 200)}`));
        lines.push('');
    }

    if (state.errors.length > 0) {
        lines.push('  ── ERRORS (first 15) ──');
        state.errors.slice(0, 15).forEach((e, i) => 
            lines.push(`    ${i+1}. ${e.substring(0, 250)}`));
        lines.push('');
    }

    // ── Status ──
    const swfOk = state.swfLoaded;
    const swOk = state.swRegistered && state.swActive;
    const noFatalErrors = state.pageErrors < 10;
    const passed = swfOk && swOk && noFatalErrors;

    lines.push('═══════════════════════════════════════════════════════════');
    lines.push(`  SWF Loaded:      ${swfOk ? '✅' : '❌'}`);
    lines.push(`  Service Worker: ${swOk ? '✅' : '⚠️'}`);
    lines.push(`  No fatal errors: ${noFatalErrors ? '✅' : '❌'}`);
    lines.push(`  OVERALL: ${passed ? '✅ PASSED' : '⚠️ NEEDS ATTENTION'}`);
    lines.push('═══════════════════════════════════════════════════════════');

    const summary = lines.join('\n');
    summaryLog.write(summary);
    console.log('\n' + summary);

    // Cleanup
    consoleLog.end();
    networkLog.end();
    swLog.end();
    summaryLog.end();
    await browser.close();
    process.exit(passed ? 0 : 1);
}

run().catch(err => {
    const msg = `FATAL: ${err.message}\n${err.stack || ''}`;
    consoleLog.write(`\n${msg}\n`);
    summaryLog.write(msg + '\n');
    console.error(msg);
    consoleLog.end();
    networkLog.end();
    swLog.end();
    summaryLog.end();
    process.exit(2);
});
