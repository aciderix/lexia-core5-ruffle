// Service Worker for intercepting Lexia Core5 AMF requests
// No SWF patching needed - Ruffle's NetConnection.connect() works for HTTP URLs!

importScripts('amf.js');

const GATEWAY_PATTERNS = [
    /student\.mylexia\.com\/clientapi\/gateway\.php/,
    /dev10\.lexialearning\.com\/clientapi\/gateway\.php/,
    /qa10\.lexialearning\.com\/clientapi\/gateway\.php/,
    /\/clientapi\/gateway\.php/,
    /\/amf\/gateway\.php/
];

const GATEWAY_URL = 'https://student.mylexia.com/clientapi/gateway.php';

self.addEventListener('install', (event) => {
    console.log('[SW] Installing Service Worker');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activating Service Worker');
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    console.log('[SW] Fetch intercepted:', url.href);

    const isGateway = GATEWAY_PATTERNS.some(p => p.test(url.href));

    if (isGateway && event.request.method === 'POST') {
        console.log('[SW] Intercepted AMF gateway request');
        event.respondWith(handleAMFRequest(event.request));
        return;
    }

    // Also intercept crossdomain.xml requests
    if (url.pathname.endsWith('crossdomain.xml')) {
        console.log('[SW] Serving crossdomain.xml');
        event.respondWith(new Response(
            `<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" secure="false"/><allow-http-request-headers-from domain="*" headers="*"/></cross-domain-policy>`,
            { headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' } }
        ));
        return;
    }

    // Pass through everything else
    event.respondWith(fetch(event.request).catch(err => {
        console.log('[SW] Fetch failed (offline?), returning empty:', url.href);
        return new Response('', { status: 200 });
    }));
});

async function handleAMFRequest(request) {
    try {
        const body = await request.arrayBuffer();
        console.log('[SW] AMF request body:', body.byteLength, 'bytes');

        // Parse the AMF0 request to identify the operation
        let operation = 'unknown';
        let targetURI = '';
        try {
            const reader = new AMFReader(body);
            const msg = reader.readRemotingMessage();
            console.log('[SW] AMF message:', JSON.stringify(msg.bodies?.map(b => b.targetURI)));
            if (msg.bodies && msg.bodies.length > 0) {
                targetURI = msg.bodies[0].targetURI;
                // Target URI format: "destination.operation" e.g. "APIService.handshake"
                const parts = targetURI.split('.');
                operation = parts[parts.length - 1];
                console.log('[SW] Operation:', operation, 'Target:', targetURI);
            }
        } catch (e) {
            console.log('[SW] AMF parse error:', e.message);
        }

        // Build response based on the operation
        let responseData;
        let responseURI = '/1/onResult';

        switch (operation.toLowerCase()) {
            case 'handshake':
                console.log('[SW] -> Returning HandshakeResponseVO');
                responseData = createHandshakeResponse();
                break;

            case 'login':
                console.log('[SW] -> Returning LoginResponseVO');
                responseData = createLoginResponse();
                break;

            case 'authenticatewithtoken':
                console.log('[SW] -> Returning LoginResponseVO (auth)');
                responseData = createLoginResponse();
                break;

            case 'callkeepalive':
            case 'keepalive':
                console.log('[SW] -> Returning keep-alive success');
                responseData = createDefaultResponse();
                break;

            case 'getunitstatus':
                console.log('[SW] -> Returning unit status');
                responseData = {
                    __className: 'com.lexialearning.lrs.api:UnitStatusVO',
                    success: true,
                    unitId: 1,
                    isComplete: false,
                    isStarted: false,
                    currentActivityId: 0
                };
                break;

            case 'requestprogramstatus':
            case 'getprogramstatus':
                console.log('[SW] -> Returning program status');
                responseData = {
                    __className: 'com.lexialearning.lrs.api:ProgramStatusVO',
                    success: true,
                    level: 1,
                    unit: 1,
                    program: 'Core5',
                    currentActivityId: 1
                };
                break;

            case 'saveunitdata':
                console.log('[SW] -> Returning save success');
                responseData = createDefaultResponse();
                break;

            case 'logout':
                console.log('[SW] -> Returning logout success');
                responseData = createDefaultResponse();
                break;

            case 'loadprogram':
                console.log('[SW] -> Returning program data');
                responseData = {
                    __className: 'com.lexialearning.lrs.api:ProgramVO',
                    success: true,
                    program: 'Core5',
                    levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
                    units: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
                };
                break;

            default:
                console.log('[SW] -> Returning default response for:', operation);
                responseData = createDefaultResponse();
                break;
        }

        // Build the AMF0 remoting response
        const responseBuffer = buildRemotingResponse('', responseURI, responseData);
        console.log('[SW] AMF response:', responseBuffer.byteLength, 'bytes');

        return new Response(responseBuffer, {
            status: 200,
            headers: {
                'Content-Type': 'application/x-amf',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, *'
            }
        });
    } catch (e) {
        console.log('[SW] Error handling AMF request:', e.message, e.stack);
        // Return a minimal success response even on error
        const w = new AMFWriter();
        w.writeShort(0); // version
        w.writeShort(0); // headers
        w.writeShort(1); // bodies
        w.writeUTF('/1/onResult');
        w.writeUTF('');
        w.writeInt(-1);
        w.writeValue(createDefaultResponse());

        return new Response(w.toBuffer(), {
            status: 200,
            headers: {
                'Content-Type': 'application/x-amf',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}
