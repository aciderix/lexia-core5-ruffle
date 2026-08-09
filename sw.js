// Lexia Core5 AMF Bypass Service Worker
// Intercepts AMF gateway requests and returns mock responses

const AMF_PATHS = [
  '/lexia-core5-ruffle/amf/gateway.php',
  '/amf/gateway.php',
  'amf/gateway.php'
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

function writeAMF3String(buf, str, stringTable) {
  const idx = stringTable.indexOf(str);
  if (idx >= 0) {
    writeU29(buf, (idx << 1) | 0x01);
  } else {
    const utf8 = new TextEncoder().encode(str);
    writeU29(buf, (utf8.length << 1) | 0x01);
    buf.push(...utf8);
    stringTable.push(str);
  }
}

function writeAMF3Value(buf, val, stringTable) {
  if (val === null || val === undefined) {
    buf.push(AMF3_NULL);
  } else if (val === true) {
    buf.push(AMF3_TRUE);
  } else if (val === false) {
    buf.push(AMF3_FALSE);
  } else if (typeof val === 'number' && Number.isInteger(val) && val >= -268435456 && val <= 268435455) {
    buf.push(AMF3_INTEGER);
    writeU29(buf, val);
  } else if (typeof val === 'number') {
    buf.push(AMF3_DOUBLE);
    const float64 = new Float64Array([val]);
    const int8 = new Uint8Array(float64.buffer);
    buf.push(...int8);
  } else if (typeof val === 'string') {
    buf.push(AMF3_STRING);
    writeAMF3String(buf, val, stringTable);
  } else if (typeof val === 'object') {
    writeAMF3Object(buf, val, stringTable);
  }
}

function writeAMF3Object(buf, props, stringTable) {
  buf.push(AMF3_OBJECT);
  // Traits: inline(1) + anonymous(1) + dynamic(1) + externalizable(0) + sealedCount(0)
  // = (0 << 4) | (0 << 3) | (1 << 2) | (1 << 1) | 1 = 0x07
  writeU29(buf, 0x07);
  // No class name (anonymous)
  // No sealed member names
  // Dynamic properties:
  for (const [key, val] of Object.entries(props)) {
    writeAMF3String(buf, key, stringTable);
    writeAMF3Value(buf, val, stringTable);
  }
  // End of dynamic properties (empty string)
  writeAMF3String(buf, '', stringTable);
}

function buildAMFResponse(targetURI, resultObj) {
  const buf = [];
  const stringTable = [];
  
  // AMF0 envelope with AMF3 body
  buf.push(0x00, 0x03); // AMF3 version
  buf.push(0x00, 0x00); // 0 headers
  buf.push(0x00, 0x01); // 1 body
  
  // Target URI with /onResult suffix
  const targetStr = targetURI + '/onResult';
  const targetBytes = new TextEncoder().encode(targetStr);
  buf.push(0x00, (targetBytes.length >> 8) & 0xFF, targetBytes.length & 0xFF);
  buf.push(...targetBytes);
  
  // Response URI (empty)
  buf.push(0x00, 0x00);
  
  // AMF3 value (preceded by AMF0->AMF3 marker)
  buf.push(0x03); // Switch to AMF3
  writeAMF3Object(buf, resultObj, stringTable);
  
  return new Uint8Array(buf);
}

// Mock responses
const mockResponses = {
  'HandshakeRequestVO': {
    success: true,
    sessionId: 'offline-001',
    version: '1.1.5.131',
    serverTime: String(Date.now()),
    minVersion: '1.0.0',
    maxVersion: '9.9.9',
    features: []
  },
  'LoginRequestVO': {
    success: true,
    studentId: 1,
    studentName: 'Student',
    authToken: 'mock-token-xyz',
    programStatus: 'ACTIVE',
    currentLevel: 1,
    currentUnit: 1,
    units: [],
    placedOut: false
  },
  'VerifySiteIdRequestVO': {
    success: true,
    siteId: '0000',
    siteName: 'Offline Mode',
    isCore5: true
  },
  'UnitStatusRequestVO': {
    success: true,
    units: [],
    currentUnit: 1
  },
  'StepEndRequestVO': {
    success: true,
    score: 100,
    passed: true
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
  },
  'default': {
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
  const url = new URL(event.request.url);
  
  // Check if this is an AMF gateway request
  const isAMF = AMF_PATHS.some(path => url.pathname.includes('amf/gateway') || url.href.includes('amf/gateway'));
  
  if (isAMF && event.request.method === 'POST') {
    console.log('[Lexia Bypass] AMF request intercepted:', url.href);
    
    event.respondWith(
      event.request.arrayBuffer().then(body => {
        // Try to determine operation from request body
        let operation = 'default';
        const bodyStr = new TextDecoder('utf-8', { fatal: false }).decode(body);
        
        for (const op of Object.keys(mockResponses)) {
          if (op !== 'default' && bodyStr.includes(op)) {
            operation = op;
            break;
          }
        }
        
        console.log('[Lexia Bypass] Operation:', operation);
        
        const mockResult = mockResponses[operation] || mockResponses.default;
        const amfResponse = buildAMFResponse('1', mockResult);
        
        return new Response(amfResponse, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-amf',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }).catch(err => {
        console.error('[Lexia Bypass] Error:', err);
        const amfResponse = buildAMFResponse('1', { success: true });
        return new Response(amfResponse, {
          status: 200,
          headers: { 'Content-Type': 'application/x-amf' }
        });
      })
    );
    return;
  }
  
  // Pass through all other requests
  event.respondWith(fetch(event.request));
});
