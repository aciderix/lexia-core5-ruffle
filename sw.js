// Lexia Core5 AMF Bypass Service Worker
// Intercepts AMF gateway requests and returns mock responses

const AMF_ENDPOINTS = [
    'https://student.mylexia.com/clientapi/gateway.php',
    'https://dev10.lexialearning.com/clientapi/gateway.php',
    'https://qa10.lexialearning.com/clientapi/gateway.php'
];

// AMF3 type markers
const AMF3_UNDEFINED = 0x00;
const AMF3_NULL = 0x01;
const AMF3_FALSE = 0x02;
const AMF3_TRUE = 0x03;
const AMF3_INTEGER = 0x04;
const AMF3_DOUBLE = 0x05;
const AMF3_STRING = 0x06;
const AMF3_ARRAY = 0x09;
const AMF3_OBJECT = 0x0A;
const AMF3_DICT = 0x11;

// Write AMF3 string (with string table)
function writeAMF3String(buf, str, stringTable) {
    const idx = stringTable.indexOf(str);
    if (idx >= 0) {
        writeU29(buf, (idx << 1) | 0x01); // reference
    } else {
        const utf8 = new TextEncoder().encode(str);
        writeU29(buf, (utf8.length << 1) | 0x01); // length + inline flag
        buf.push(...utf8);
        stringTable.push(str);
    }
}

// Write U29 variable-length integer
function writeU29(buf, val) {
    val = val & 0x1FFFFFFF;
    if (val < 0x80) {
        buf.push(val);
    } else if (val < 0x4000) {
        buf.push((val >> 7) | 0x80, val & 0x7F);
    } else if (val < 0x200000) {
        buf.push((val >> 14) | 0x80, ((val >> 7) & 0x7F) | 0x80, val & 0x7F);
    } else {
        buf.push((val >> 22) | 0x80, ((val >> 15) & 0x7F) | 0x80, ((val >> 8) & 0x7F) | 0x80, val & 0xFF);
    }
}

// Write AMF3 integer
function writeAMF3Integer(buf, val) {
    buf.push(AMF3_INTEGER);
    writeU29(buf, val);
}

// Write AMF3 boolean
function writeAMF3Bool(buf, val) {
    buf.push(val ? AMF3_TRUE : AMF3_FALSE);
}

// Write AMF3 string
function writeAMF3StringVal(buf, val, stringTable) {
    buf.push(AMF3_STRING);
    writeAMF3String(buf, val, stringTable);
}

// Write AMF3 object (anonymous, dynamic)
function writeAMF3Object(buf, props, stringTable) {
    buf.push(AMF3_OBJECT);
    // Traits: inline + dynamic + no externalizable + 0 sealed members + anonymous class
    writeU29(buf, 0x07); // (0 << 4) | (0 << 3) | (1 << 2) | (1 << 1) | 1 = 0x0B... let me recalculate
    // U29 traits: inline(1) + dynamic(1) + externalizable(0) + sealedCount(0)
    // = 0b11 | (0 << 2) | (0 << 4) = 0x03... 
    // Actually: bit 0 = inline, bit 1 = dynamic, bit 2 = externalizable, bits 3-4 = count
    // inline=1, dynamic=1, externalizable=0, count=0 => 0b011 = 3
    writeU29(buf, 0x07); // 0b111 = inline + dynamic + 0 sealed... let me fix
    // U29-traits value: (count << 4) | (externalizable << 3) | (dynamic << 2) | (anonymous << 1) | inline
    // inline=1, anonymous=1, dynamic=1, ext=0, count=0 => (0<<4)|(0<<3)|(1<<2)|(1<<1)|1 = 0x07
    // No class name for anonymous
    // No sealed member names
    // Dynamic properties:
    for (const [key, val] of Object.entries(props)) {
        writeAMF3String(buf, key, stringTable);
        if (val === true || val === false) {
            writeAMF3Bool(buf, val);
        } else if (typeof val === 'number' && Number.isInteger(val)) {
            writeAMF3Integer(buf, val);
        } else if (typeof val === 'string') {
            writeAMF3StringVal(buf, val, stringTable);
        } else if (val === null) {
            buf.push(AMF3_NULL);
        } else if (typeof val === 'object') {
            writeAMF3Object(buf, val, stringTable);
        } else {
            buf.push(AMF3_NULL);
        }
    }
    // End of dynamic properties
    writeAMF3String(buf, '', stringTable); // empty string terminates dynamic props
}

// Build an AMF0/AMF3 response for NetConnection.call()
function buildAMFResponse(targetURI, resultObj) {
    const buf = [];
    const stringTable = [];
    
    // AMF header
    buf.push(0x00, 0x03); // AMF3
    buf.push(0x00, 0x00); // 0 headers
    
    // 1 body
    buf.push(0x00, 0x01); // 1 body
    
    // Target URI (the method name + "/onResult")
    const targetStr = targetURI + '/onResult';
    // AMF0 string for target URI
    const targetBytes = new TextEncoder().encode(targetStr);
    buf.push(0x00, (targetBytes.length >> 8) & 0xFF, targetBytes.length & 0xFF);
    buf.push(...targetBytes);
    
    // Response URI (empty string)
    buf.push(0x00, 0x00);
    
    // Result - AMF3 value
    // First byte 0x03 means AMF3 follows
    buf.push(0x03); // AMF3 marker in AMF0 context
    writeAMF3Object(buf, resultObj, stringTable);
    
    return new Uint8Array(buf);
}

// Mock responses for each AMF operation
const mockResponses = {
    'HandshakeRequestVO': {
        success: true,
        sessionId: 'offline-session-001',
        version: '1.1.5.131',
        serverTime: Date.now().toString()
    },
    'LoginRequestVO': {
        success: true,
        studentId: 1,
        studentName: 'Student',
        authToken: 'mock-auth-token-xyz',
        sessionData: {
            programStatus: 'ACTIVE',
            currentLevel: 1,
            currentUnit: 1
        }
    },
    'VerifySiteIdRequestVO': {
        success: true,
        siteId: '0000',
        siteName: 'Offline Mode'
    },
    'UnitStatusRequestVO': {
        success: true,
        units: []
    },
    'StepEndRequestVO': {
        success: true,
        score: 100
    },
    'LogoutRequestVO': {
        success: true
    },
    'TeacherRequestVO': {
        success: true,
        teacherName: 'Teacher'
    },
    'SaveWarmupScoreRequestVO': {
        success: true
    },
    'LoggingRequestVO': {
        success: true
    }
};

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = event.request.url;
    
    // Check if this is an AMF gateway request
    const isAMF = AMF_ENDPOINTS.some(ep => url.includes(ep.replace('https://', '')));
    
    if (isAMF && event.request.method === 'POST') {
        event.respondWith(
            event.request.arrayBuffer().then(body => {
                // Try to determine the operation type from the AMF request body
                let operation = 'HandshakeRequestVO'; // default
                const bodyStr = new TextDecoder().decode(body);
                
                for (const op of Object.keys(mockResponses)) {
                    if (bodyStr.includes(op)) {
                        operation = op;
                        break;
                    }
                }
                
                console.log('[Lexia Bypass] AMF request:', operation);
                
                const mockResult = mockResponses[operation] || { success: true };
                const targetURI = '1'; // Generic result target
                
                const amfResponse = buildAMFResponse(targetURI, mockResult);
                
                return new Response(amfResponse, {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/x-amf',
                        'Cache-Control': 'no-cache'
                    }
                });
            }).catch(err => {
                console.error('[Lexia Bypass] Error:', err);
                // Return a generic success response
                const amfResponse = buildAMFResponse('1', { success: true });
                return new Response(amfResponse, {
                    status: 200,
                    headers: { 'Content-Type': 'application/x-amf' }
                });
            })
        );
    }
    
    // Pass through all other requests
    event.respondWith(fetch(event.request).catch(() => {
        return new Response('', { status: 200 });
    }));
});
