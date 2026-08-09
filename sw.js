// Lexia Core5 AMF Bypass Service Worker v4
// Intercepts AMF gateway requests and returns mock responses
// Simple AMF format (no Flex AcknowledgeMessage) for max Ruffle compatibility

const AMF_PATTERNS = [
  /clientapi\/gateway\.php/i,
  /\/amf\/gateway/i,
  /amf\/gateway\.php/i,
  /mylexia\.com/i,
  /lexialearning\.com/i
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

// AMF0 type markers
const AMF0_NUMBER = 0x00;
const AMF0_BOOLEAN = 0x01;
const AMF0_STRING = 0x02;
const AMF0_OBJECT = 0x03;
const AMF0_NULL = 0x05;
const AMF0_UNDEFINED = 0x06;
const AMF0_LONGSTRING = 0x0C;
const AMF0_TYPED_OBJECT = 0x10;
const AMF0_OBJECT_END = 0x00;

function writeU29(buf, val) {
  val = val & 0x1FFFFFFF;
  if (val < 0x80) buf.push(val);
  else if (val < 0x4000) buf.push((val >> 7) | 0x80, val & 0x7F);
  else if (val < 0x200000) buf.push((val >> 14) | 0x80, ((val >> 7) & 0x7F) | 0x80, val & 0x7F);
  else buf.push((val >> 22) | 0x80, ((val >> 15) & 0x7F) | 0x80, ((val >> 8) & 0x7F) | 0x80, val & 0xFF);
}

function writeAMF3String(buf, str, st) {
  const idx = st.indexOf(str);
  if (idx >= 0) { writeU29(buf, (idx << 1)); }
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
  } else if (Array.isArray(val)) {
    buf.push(AMF3_ARRAY);
    writeU29(buf, (val.length << 1) | 0x01);
    for (const item of val) writeAMF3Value(buf, item, st);
  } else if (typeof val === 'object') {
    writeAMF3Object(buf, val, st);
  }
}

function writeAMF3TypedObject(buf, className, props, st) {
  buf.push(AMF3_OBJECT);
  writeU29(buf, 0x05); // inline + named + dynamic
  writeAMF3String(buf, className, st);
  for (const [k, v] of Object.entries(props)) {
    writeAMF3String(buf, k, st);
    writeAMF3Value(buf, v, st);
  }
  writeAMF3String(buf, '', st); // end dynamic
}

function writeAMF3Object(buf, props, st) {
  buf.push(AMF3_OBJECT);
  writeU29(buf, 0x07); // inline + anonymous + dynamic
  for (const [k, v] of Object.entries(props)) {
    writeAMF3String(buf, k, st);
    writeAMF3Value(buf, v, st);
  }
  writeAMF3String(buf, '', st);
}

// AMF0 helpers (for AMF0 responses - more compatible with Ruffle)
function writeAMF0String(buf, str) {
  const u8 = new TextEncoder().encode(str);
  buf.push((u8.length >> 24) & 0xFF, (u8.length >> 16) & 0xFF, (u8.length >> 8) & 0xFF, u8.length & 0xFF);
  buf.push(...u8);
}

function writeAMF0Value(buf, val) {
  if (val === null || val === undefined) { buf.push(AMF0_NULL); }
  else if (val === true) { buf.push(AMF0_BOOLEAN, 0x01); }
  else if (val === false) { buf.push(AMF0_BOOLEAN, 0x00); }
  else if (typeof val === 'number') {
    buf.push(AMF0_NUMBER);
    const f64 = new Float64Array([val]); const u8 = new Uint8Array(f64.buffer);
    buf.push(...u8);
  } else if (typeof val === 'string') {
    buf.push(AMF0_STRING);
    writeAMF0String(buf, val);
  } else if (Array.isArray(val)) {
    // AMF0 array
    buf.push(AMF0_OBJECT);
    for (let i = 0; i < val.length; i++) {
      const key = String(i);
      const k8 = new TextEncoder().encode(key);
      buf.push((k8.length >> 8) & 0xFF, k8.length & 0xFF, ...k8);
      writeAMF0Value(buf, val[i]);
    }
    buf.push(0x00, 0x00, AMF0_OBJECT_END); // end marker
  } else if (typeof val === 'object') {
    writeAMF0TypedObject(buf, '', val);
  }
}

function writeAMF0TypedObject(buf, className, props) {
  buf.push(AMF0_TYPED_OBJECT);
  writeAMF0String(buf, className);
  for (const [k, v] of Object.entries(props)) {
    const k8 = new TextEncoder().encode(k);
    buf.push((k8.length >> 8) & 0xFF, k8.length & 0xFF, ...k8);
    writeAMF0Value(buf, v);
  }
  buf.push(0x00, 0x00, AMF0_OBJECT_END); // end marker
}

// Build AMF3 response packet
function buildAMF3Response(targetURI, resultObj, resultClassName) {
  const buf = []; const st = [];
  buf.push(0x00, 0x03, 0x00, 0x00, 0x00, 0x01); // v3, 0 headers, 1 body
  const tStr = targetURI + '/onResult';
  const tBytes = new TextEncoder().encode(tStr);
  buf.push(0x00, (tBytes.length >> 8) & 0xFF, tBytes.length & 0xFF, ...tBytes, 0x00, 0x00, 0x03);
  if (resultClassName) writeAMF3TypedObject(buf, resultClassName, resultObj, st);
  else writeAMF3Object(buf, resultObj, st);
  return new Uint8Array(buf);
}

// Build AMF0 response packet (most compatible)
function buildAMF0Response(targetURI, resultObj, resultClassName) {
  const buf = [];
  buf.push(0x00, 0x00, 0x00, 0x00, 0x00, 0x01); // v0 (AMF0), 0 headers, 1 body
  const tStr = targetURI + '/onResult';
  const tBytes = new TextEncoder().encode(tStr);
  buf.push(0x00, (tBytes.length >> 8) & 0xFF, tBytes.length & 0xFF, ...tBytes, 0x00, 0x00);
  writeAMF0TypedObject(buf, resultClassName || '', resultObj);
  return new Uint8Array(buf);
}

// Try AMF0 first (most compatible with Ruffle), fall back to AMF3
function buildAMFResponse(targetURI, resultObj, resultClassName, useAMF3) {
  if (useAMF3) return buildAMF3Response(targetURI, resultObj, resultClassName);
  return buildAMF0Response(targetURI, resultObj, resultClassName);
}

// Mock responses
const mockResponses = {
  'HandshakeRequestVO': {
    data: { success: true, sessionId: 'offline-001', version: '1.1.5.131',
            serverTime: String(Date.now()), minVersion: '1.0.0', maxVersion: '9.9.9', features: [] },
    className: 'com.lexialearning.lrs.api.HandshakeResponseVO'
  },
  'LoginRequestVO': {
    data: { success: true, studentId: 1, studentName: 'Student', authToken: 'mock-token-xyz',
            ssoAuthToken: 'mock-sso-token', programStatus: 'ACTIVE',
            currentLevel: 1, currentUnit: 1, units: [], placedOut: false,
            subdomain: 'offline', authenticateOnly: false },
    className: 'com.lexialearning.lrs.api.LoginResponseVO'
  },
  'VerifySiteIdRequestVO': {
    data: { success: true, siteId: '0000', siteName: 'Offline Mode', isCore5: true, isValid: true },
    className: 'com.lexialearning.lrs.api.VerifySiteIdResponseVO'
  },
  'UnitStatusRequestVO': {
    data: { success: true, units: [], currentUnit: 1, roundLeader: 0, stepId: 0,
            isStruggling: false, errorKindList: [] },
    className: 'com.lexialearning.lrs.api.UnitStatusResponseVO'
  },
  'StepEndRequestVO': {
    data: { success: true, score: 100, passed: true, nextUnit: 1 },
    className: 'com.lexialearning.lrs.api.StepEndResponseVO'
  },
  'LogoutRequestVO': {
    data: { success: true },
    className: 'com.lexialearning.lrs.api.LogoutResponseVO'
  },
  'TeacherRequestVO': {
    data: { success: true, teacherName: 'Teacher', isAuthenticated: true },
    className: 'com.lexialearning.lrs.api.TeacherResponseVO'
  },
  'GetCustomerFromTeacherRequestVO': {
    data: { success: true, customerName: 'Offline Customer', customerId: 1 },
    className: null
  },
  'SaveWarmupScoreRequestVO': {
    data: { success: true, contentId: 0, overrideKind: '', time: 0, attemptList: [], work: '' },
    className: 'com.lexialearning.lrs.api.SaveWarmupScoreResponseVO'
  },
  'LoggingRequestVO': {
    data: { success: true },
    className: 'com.lexialearning.lrs.api.LoggingResponseVO'
  },
  'SaveUnitDataRequestVO': {
    data: { success: true },
    className: null
  },
  'default': {
    data: { success: true },
    className: null
  }
};

const CROSSDOMAIN_XML = `<?xml version="1.0"?>
<cross-domain-policy>
  <allow-access-from domain="*" secure="false"/>
  <allow-http-request-headers-from domain="*" headers="*"/>
</cross-domain-policy>`;

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Track if we should use AMF3 (will try AMF0 first, switch to AMF3 if needed)
let useAMF3 = false;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.endsWith('crossdomain.xml')) {
    console.log('[Bypass] crossdomain.xml:', url.href);
    event.respondWith(new Response(CROSSDOMAIN_XML, {
      status: 200,
      headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
    }));
    return;
  }

  const isAMF = AMF_PATTERNS.some(p => p.test(url.pathname) || p.test(url.href));

  if (isAMF && event.request.method === 'POST') {
    console.log('[Bypass] AMF POST:', url.href);
    event.respondWith(
      event.request.arrayBuffer().then(body => {
        const bodyStr = new TextDecoder('utf-8', { fatal: false }).decode(body);
        console.log('[Bypass] Body length:', body.length, 'bytes');

        let op = 'default';
        for (const key of Object.keys(mockResponses)) {
          if (key !== 'default' && bodyStr.includes(key)) { op = key; break; }
        }
        console.log('[Bypass] Detected op:', op);

        const mock = mockResponses[op] || mockResponses.default;
        const amf = buildAMFResponse('1', mock.data, mock.className, useAMF3);
        console.log('[Bypass] Response:', amf.length, 'bytes, AMF' + (useAMF3 ? '3' : '0'));

        return new Response(amf, {
          status: 200,
          headers: { 'Content-Type': 'application/x-amf', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
        });
      }).catch((err) => {
        console.error('[Bypass] Error:', err);
        const amf = buildAMF0Response('1', { success: true }, '');
        return new Response(amf, { status: 200, headers: { 'Content-Type': 'application/x-amf', 'Access-Control-Allow-Origin': '*' } });
      })
    );
    return;
  }

  if (isAMF && event.request.method === 'OPTIONS') {
    console.log('[Bypass] AMF OPTIONS (preflight):', url.href);
    event.respondWith(new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' }
    }));
    return;
  }

  if (isAMF && event.request.method === 'GET') {
    console.log('[Bypass] AMF GET:', url.href);
    const amf = buildAMF0Response('1', { success: true }, '');
    event.respondWith(new Response(amf, {
      status: 200,
      headers: { 'Content-Type': 'application/x-amf', 'Access-Control-Allow-Origin': '*' }
    }));
    return;
  }

  event.respondWith(fetch(event.request));
});
