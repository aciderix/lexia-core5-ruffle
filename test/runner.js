/**
 * Playwright test runner for Lexia Core5 Ruffle
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
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader']
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const page = await context.newPage();

    const state = {
        errors: [], warnings: [], networkReqs: [], amfReqs: [], amfResponses: [],
        swMessages: [], swRegistered: false, swActive: false, swIntercepted: 0,
        ruffleVersion: null, swfLoaded: false, swfError: null, pageErrors: 0,
    };

    // ── Console capture ──
    page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();
        const line = `[${ts()}] [${type.toUpperCase()}] ${text}\n`;
        consoleLog.write(line);

        if (type === 'error') { state.errors.push(text); state.pageErrors++; }
        if (type === 'warning') state.warnings.push(text);
        if (text.includes('version') && text.includes('nightly')) state.ruffleVersion = text.replace(/.*Version: /, '').replace(/ .*/, '').trim();
        if (text.match(/SWF loaded/i) || text.match(/loadedmetadata/i)) state.swfLoaded = true;
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
                networkLog.write(`[${ts()}] AMF response body: ${body.length} bytes\n`);
                if (body.length > 0) {
                    const hex = Buffer.from(body.slice(0, 200)).toString('hex');
                    networkLog.write(`[${ts()}] AMF response hex: ${hex}\n`);
                }
            } catch (e) {
                networkLog.write(`[${ts()}] Could not read AMF response: ${e.message}\n`);
            }
        }
    });

    // ── Navigate ──
    consoleLog.write(`[${ts()}] Navigating to ${BASE_URL}\n`);
    try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        consoleLog.write(`[${ts()}] Page loaded\n`);
    } catch (e) {
        consoleLog.write(`[${ts()}] Navigation error: ${e.message}\n`);
        state.errors.push(`Navigation: ${e.message}`);
    }

    // ── Wait for Service Worker ──
    try {
        await page.waitForFunction(() => navigator.serviceWorker !== undefined, { timeout: 5000 }).catch(() => {});
        state.swRegistered = await page.evaluate(() =>
            navigator.serviceWorker?.getRegistrations?.().then(regs => regs.length > 0).catch(() => false)
        ).catch(() => false);
        state.swActive = await page.evaluate(() =>
            navigator.serviceWorker?.controller !== null && navigator.serviceWorker?.controller !== undefined
        ).catch(() => false);
        consoleLog.write(`[${ts()}] SW registered: ${state.swRegistered}, active: ${state.swActive}\n`);

        if (state.swRegistered && !state.swActive) {
            for (let i = 0; i < 10; i++) {
                await page.waitForTimeout(1000);
                state.swActive = await page.evaluate(() =>
                    navigator.serviceWorker?.controller !== null && navigator.serviceWorker?.controller !== undefined
                ).catch(() => false);
                if (state.swActive) { consoleLog.write(`[${ts()}] SW activated after ${i+1}s\n`); break; }
            }
        }
    } catch (e) {
        consoleLog.write(`[${ts()}] SW check error: ${e.message}\n`);
    }

    // ── Wait for Ruffle to initialize, then click the player ──
    await page.waitForTimeout(3000);
    try {
        // Try clicking on the ruffle-player to trigger interaction
        const clicked = await page.evaluate(() => {
            const rp = document.getElementById('ruffle-player') || document.querySelector('ruffle-player');
            if (rp) {
                rp.click();
                rp.focus();
                // Try to play
                if (rp.play) { try { rp.play(); } catch(e) {} }
                return true;
            }
            return false;
        });
        consoleLog.write(`[${ts()}] Clicked ruffle-player: ${clicked}\n`);
    } catch (e) {
        consoleLog.write(`[${ts()}] Click failed: ${e.message}\n`);
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
            const logText = await page.evaluate(() => document.getElementById('log')?.textContent || '').catch(() => '');
            if (logText) consoleLog.write(`[${ts()}] --- Page log @ ${label} ---\n${logText}\n`);
        } catch (e) {}

        // Capture Ruffle player state — INCLUDING shadow DOM
        try {
            const ruffleState = await page.evaluate(() => {
                const p = document.getElementById('player');
                const ruffleEl = p?.querySelector('ruffle-player, embed, object');
                // Try to find canvas in shadow DOM
                let canvas = null;
                let canvasSize = null;
                let shadowContent = null;
                if (ruffleEl?.shadowRoot) {
                    canvas = ruffleEl.shadowRoot.querySelector('canvas');
                    canvasSize = canvas ? `${canvas.width}x${canvas.height}` : null;
                    shadowContent = ruffleEl.shadowRoot.innerHTML?.substring(0, 200) || '';
                }
                // Also check direct children (non-shadow)
                if (!canvas) {
                    canvas = p?.querySelector('canvas');
                    canvasSize = canvas ? `${canvas.width}x${canvas.height}` : null;
                }
                return {
                    hasPlayer: !!p,
                    hasCanvas: !!canvas,
                    canvasSize,
                    hasRuffleElement: !!ruffleEl,
                    hasShadowRoot: !!ruffleEl?.shadowRoot,
                    shadowContent,
                    innerHTML: p?.innerHTML?.substring(0, 300),
                };
            }).catch(() => ({}));
            consoleLog.write(`[${ts()}] Player state @ ${label}: canvas=${ruffleState.canvasSize}, ruffleEl=${ruffleState.hasRuffleElement}, shadow=${ruffleState.hasShadowRoot}\n`);
            if (ruffleState.shadowContent) {
                consoleLog.write(`[${ts()}] Shadow DOM: ${ruffleState.shadowContent.substring(0, 150)}\n`);
            }
        } catch (e) {}

        // Click the player again at each interval to try to trigger AMF
        try {
            await page.evaluate(() => {
                const rp = document.getElementById('ruffle-player') || document.querySelector('ruffle-player');
                if (rp) { rp.click(); rp.focus(); if (rp.play) { try { rp.play(); } catch(e) {} } }
            }).catch(() => {});
        } catch (e) {}
    }

    // Final screenshot
    try {
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'final_full.png'), fullPage: true });
    } catch (e) {}

    // ── Final page state ──
    let pageState = {};
    try {
        pageState = await page.evaluate(() => {
            const p = document.getElementById('player');
            const ruffleEl = p?.querySelector('ruffle-player, embed, object');
            let canvasSize = null;
            let shadowHTML = null;
            if (ruffleEl?.shadowRoot) {
                const canvas = ruffleEl.shadowRoot.querySelector('canvas');
                canvasSize = canvas ? `${canvas.width}x${canvas.height}` : null;
                shadowHTML = ruffleEl.shadowRoot.innerHTML?.substring(0, 500);
            }
            return {
                title: document.title,
                logLines: (document.getElementById('log')?.textContent || '').split('\n').filter(l => l.trim()).length,
                hasRuffle: !!window.RufflePlayer,
                hasSWF: !!ruffleEl,
                canvasSize,
                shadowHTML,
                playerHTML: p?.innerHTML?.substring(0, 300),
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
        `    Canvas:      ${pageState.canvasSize || 'NOT FOUND'}`,
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
        `    Canvas size:     ${pageState.canvasSize || 'N/A'}`,
        `    Log lines:       ${pageState.logLines || 0}`,
        `    SW controller:   ${pageState.swController ? '✅' : '❌'}`,
        '',
    ];

    if (pageState.shadowHTML) {
        lines.push(`  SHADOW DOM (first 200 chars):`);
        lines.push(`    ${pageState.shadowHTML.substring(0, 200)}`);
        lines.push('');
    }

    if (pageState.playerHTML) {
        lines.push(`  PLAYER HTML:`);
        lines.push(`    ${pageState.playerHTML.substring(0, 300)}`);
        lines.push('');
    }

    if (state.amfReqs.length > 0) {
        lines.push('  ── AMF GATEWAY REQUESTS ──');
        state.amfReqs.forEach((r, i) => lines.push(`    ${i+1}. ${r.ts} ${r.method} ${r.url}`));
        lines.push('');
    }

    if (state.amfResponses.length > 0) {
        lines.push('  ── AMF GATEWAY RESPONSES ──');
        state.amfResponses.forEach((r, i) => lines.push(`    ${i+1}. ${r.status} ${r.size}B CT=${r.ct} ${r.url.substring(0, 80)}`));
        lines.push('');
    }

    if (state.swMessages.length > 0) {
        lines.push('  ── SERVICE WORKER MESSAGES ──');
        state.swMessages.slice(0, 30).forEach(m => lines.push(`    ${m.substring(0, 200)}`));
        lines.push('');
    }

    if (state.errors.length > 0) {
        lines.push('  ── ERRORS (first 10) ──');
        state.errors.slice(0, 10).forEach((e, i) => lines.push(`    ${i+1}. ${e.substring(0, 250)}`));
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
    lines.push(`  AMF Intercepted: ${state.swIntercepted > 0 ? '✅' : '⚠️ (SWF may need interaction)'}`);
    lines.push(`  OVERALL: ${passed ? '✅ PASSED' : '⚠️ NEEDS ATTENTION'}`);
    lines.push('═══════════════════════════════════════════════════════════');

    const summary = lines.join('\n');
    summaryLog.write(summary);
    console.log('\n' + summary);

    consoleLog.end(); networkLog.end(); swLog.end(); summaryLog.end();
    await browser.close();
    process.exit(passed ? 0 : 1);
}

run().catch(err => {
    const msg = `FATAL: ${err.message}\n${err.stack || ''}`;
    consoleLog.write(`\n${msg}\n`); summaryLog.write(msg + '\n');
    console.error(msg);
    consoleLog.end(); networkLog.end(); swLog.end(); summaryLog.end();
    process.exit(2);
});
