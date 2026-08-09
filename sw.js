// Lexia Core5 AMF Bypass Service Worker v2
// Intercepts AMF gateway requests and returns mock responses

const AMF_PATTERNS = [
  /\/lexia-core5-ruffle\/amf/,
  /\/amf\/gateway/,
  /amf\/gateway\.php/
];

// AMF3 type markers
const AMF3_NULL = 0x01;
const AMF3_FALSE = 0x02;
const AMF3_TRUE = 0x03;
const AMF3_INTEGER = 0x04;
const AMF3_DOUBLE = 0x05;
const AMF3_STRING = 0x06;
const AMF3_ARRAY = 0x09;
const AMF3_OBJECT = 0x0A;

function writeU29(buf, val) {
  val = val & 0x1FFFFFFF;
  if (val < 0x80) { buf.push(val); }
  else if (val < 0x4000) { buf.push((val >> 7) | 0x80, val & 0x7F); }
  else if (val < 0x200000) { buf.push((val >> 14) | 0x80, ((val >> 7) & 0x7F) | 0x80, val & 0x7F); }
  else { buf.push((val >> 22) | 0x80, ((val >> 15) & 0x7F) | 0x80, ((val >> 8) & 0x7F) | 0x80, val & 0xFF); }
}

function writeAMF3String(buf, str, st) {
  const idx = st.indexOf(str);
  if (idx >= 0) { writeU29(buf, (idx << 1) | 0x01); }
  else {
    const u8 = new TextEncoder().encode(str);
    writeU29(buf, (u8.length << 1) | 0x01);
    buf.push(...u8);
    st.push(str);
  }
}

function writeAMF3Value(buf, val, st) {
  if (val === null || val === undefined) { buf.push(AMF3_NULL); }
  else if (val === true) { buf.push(AMF3_TRUE); }
  else if (val === false) { buf.push(AMF3_FALSE); }
  else if (typeof val === 'number' && Number.isInteger(val) && val >= -268435456 && val <= 268435455) {
    buf.push(AMF3_INTEGER); writeU29(buf, val);
  } else if (typeof val === 'number') {
    buf.push(AMF3_DOUBLE);
    const f64 = new Float64Array([val]); const u8 = new Uint8Array(f64.buffer);
    buf.push(...u8);
  } else if (typeof val === 'string') {
    buf.push(AMF3_STRING); writeAMF3String(buf, val, st);
  } else if (typeof val === 'object') {
    writeAMF3Object(buf, val, st);
  }
}

function writeAMF3Object(buf, props, st) {
  buf.push(AMF3_OBJECT);
  // Traits: inline(1) + anonymous(1) + dynamic(1) + externalizable(0) + sealedCount(0) = 0x07
  writeU29(buf, 0x07);
  for (const [k, v] of Object.entries(props)) {
    writeAMF3String(buf, k, st);
    writeAMF3Value(buf, v, st);
  }
  writeAMF3String(buf, '', st); // end dynamic props
}

function buildAMFResponse(targetURI, resultObj) {
  const buf = []; const st = [];
  buf.push(0x00, 0x03); // AMF3 version
  buf.push(0x00, 0x00); // 0 headers
  buf.push(0x00, 0x01); // 1 body
  const tStr = targetURI + '/onResult';
  const tBytes = new TextEncoder().encode(tStr);
  buf.push(0x00, (tBytes.length >> 8) & 0xFF, tBytes.length & 0xFF);
  buf.push(...tBytes);
  buf.push(0x00, 0x00); // response URI empty
  buf.push(0x03); // switch to AMF3
  writeAMF3Object(buf, resultObj, st);
  return new Uint8Array(buf);
}

// Mock responses - keyed by operation name found in request body
const mockResponses = {
  'HandshakeRequestVO': {
    success: true, sessionId: 'offline-001', version: '1.1.5.131',
    serverTime: String(Date.now()), minVersion: '1.0.0', maxVersion: '9.9.9', features: []
  },
  'LoginRequestVO': {
    success: true, studentId: 1, studentName: 'Student', authToken: 'mock-token-xyz',
    programStatus: 'ACTIVE', currentLevel: 1, currentUnit: 1, units: [], placedOut: false
  },
  'VerifySiteIdRequestVO': { success: true, siteId: '0000', siteName: 'Offline Mode', isCore5: true },
  'UnitStatusRequestVO': { success: true, units: [], currentUnit: 1 },
  'StepEndRequestVO': { success: true, score: 100, passed: true },
  'LogoutRequestVO': { success: true },
  'TeacherRequestVO': { success: true, teacherName: 'Teacher' },
  'SaveWarmupScoreRequestVO': { success: true },
  'LoggingRequestVO': { success: true },
  'default': { success: true }
};

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isAMF = AMF_PATTERNS.some(p => p.test(url.pathname) || p.test(url.href));
  
  if (isAMF && event.request.method === 'POST') {
    console.log('[Bypass] AMF:', url.href);
    event.respondWith(
      event.request.arrayBuffer().then(body => {
        let op = 'default';
        const bodyStr = new TextDecoder('utf-8', { fatal: false }).decode(body);
        for (const key of Object.keys(mockResponses)) {
          if (key !== 'default' && bodyStr.includes(key)) { op = key; break; }
        }
        console.log('[Bypass] Op:', op);
        const result = mockResponses[op] || mockResponses.default;
        const amf = buildAMFResponse('1', result);
        return new Response(amf, {
          status: 200,
          headers: { 'Content-Type': 'application/x-amf', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
        });
      }).catch(() => {
        const amf = buildAMFResponse('1', { success: true });
        return new Response(amf, { status: 200, headers: { 'Content-Type': 'application/x-amf' } });
      })
    );
    return;
  }
  
  event.respondWith(fetch(event.request));
});
