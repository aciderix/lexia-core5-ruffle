// Lexia Core5 AMF Bypass Service Worker v4
// Intercepts AMF gateway requests and returns mock responses

const AMF_PATTERNS = [
  /clientapi\/gateway\.php/i,
  /\/amf\/gateway/i,
  /amf\/gateway\.php/i,
  /mylexia\.com/i,
  /lexialearning\.com/i
];

// AMF0 type markers
const AMF0_NUMBER = 0x00;
const AMF0_BOOLEAN = 0x01;
const AMF0_STRING = 0x02;
const AMF0_OBJECT = 0x03;
const AMF0_NULL = 0x05;
const AMF0_TYPED_OBJECT = 0x10;
const AMF0_OBJECT_END = 0x00;

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
  if (val < 0x80) buf.push(val);
  else if (val < 0x4000) buf.push((val >> 7) | 0x80, val & 0x7F);
  else if (val < 0x200000) buf.push((val >> 14) | 0x80, ((val >> 7) & 0x7F) | 0x80, val & 0x7F);
  else buf.push((val >> 22) | 0x80, ((val >> 15) & 0x7F) | 0x80, ((val >> 8) & 0x7F) | 0x80, val & 0xFF);
}

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
    const f64 = new Float64Array([val]); buf.push(...new Uint8Array(f64.buffer));
  } else if (typeof val === 'string') {
    buf.push(AMF0_STRING); writeAMF0String(buf, val);
  } else if (Array.isArray(val)) {
    buf.push(AMF0_OBJECT);
    for (let i = 0; i < val.length; i++) {
      const k8 = new TextEncoder().encode(String(i));
      buf.push((k8.length >> 8) & 0xFF, k8.length & 0xFF, ...k8);
      writeAMF0Value(buf, val[i]);
    }
    buf.push(0x00, 0x00, AMF0_OBJECT_END);
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
  buf.push(0x00, 0x00, AMF0_OBJECT_END);
}

function buildAMF0Response(targetURI, resultObj, resultClassName) {
  const buf = [];
  buf.push(0x00, 0x00, 0x00, 0x00, 0x00, 0x01);
  const tStr = targetURI + '/onResult';
  const tB = new TextEncoder().encode(tStr);
  buf.push(0x00, (tB.length >> 8) & 0xFF, tB.length & 0xFF, ...tB, 0x00, 0x00);
  writeAMF0TypedObject(buf, resultClassName || '', resultObj);
  return new Uint8Array(buf);
}

// AMF3 helpers
function writeAMF3String(buf, str, st) {
  const idx = st.indexOf(str);
  if (idx >= 0) writeU29(buf, idx << 1);
  else { const u8 = new TextEncoder().encode(str); writeU29(buf, (u8.length << 1) | 1); buf.push(...u8); st.push(str); }
}
function writeAMF3Value(buf, val, st) {
  if (val === null || val === undefined) buf.push(AMF3_NULL);
  else if (val === true) buf.push(AMF3_TRUE);
  else if (val === false) buf.push(AMF3_FALSE);
  else if (typeof val === 'number' && Number.isInteger(val) && val >= -268435456 && val <= 268435455) { buf.push(AMF3_INTEGER); writeU29(buf, val); }
  else if (typeof val === 'number') { buf.push(AMF3_DOUBLE); buf.push(...new Uint8Array(new Float64Array([val]).buffer)); }
  else if (typeof val === 'string') { buf.push(AMF3_STRING); writeAMF3String(buf, val, st); }
  else if (Array.isArray(val)) { buf.push(AMF3_ARRAY); writeU29(buf, (val.length << 1) | 1); val.forEach(i => writeAMF3Value(buf, i, st)); }
  else if (typeof val === 'object') writeAMF3Object(buf, val, st);
}
function writeAMF3TypedObject(buf, cn, p, st) {
  buf.push(AMF3_OBJECT); writeU29(buf, 0x05); writeAMF3String(buf, cn, st);
  Object.entries(p).forEach(([k, v]) => { writeAMF3String(buf, k, st); writeAMF3Value(buf, v, st); });
  writeAMF3String(buf, '', st);
}
function writeAMF3Object(buf, p, st) {
  buf.push(AMF3_OBJECT); writeU29(buf, 0x07);
  Object.entries(p).forEach(([k, v]) => { writeAMF3String(buf, k, st); writeAMF3Value(buf, v, st); });
  writeAMF3String(buf, '', st);
}
function buildAMF3Response(t, o, c) {
  const buf = [], st = [];
  buf.push(0x00, 0x03, 0x00, 0x00, 0x00, 0x01);
  const tB = new TextEncoder().encode(t + '/onResult');
  buf.push(0x00, (tB.length >> 8) & 0xFF, tB.length & 0xFF, ...tB, 0x00, 0x00, 0x03);
  if (c) writeAMF3TypedObject(buf, c, o, st); else writeAMF3Object(buf, o, st);
  return new Uint8Array(buf);
}

// Notify all clients (for debug overlay)
function notifyClients(msg) {
  self.clients.matchAll().then(clients => {
    clients.forEach(c => c.postMessage({ type: 'AMF_INTERCEPT', ...msg }));
  });
}

const mockResponses = {
  'HandshakeRequestVO': { data: { success: true, sessionId: 'offline-001', version: '1.1.5.131', serverTime: String(Date.now()), minVersion: '1.0.0', maxVersion: '9.9.9', features: [] }, className: 'com.lexialearning.lrs.api.HandshakeResponseVO' },
  'LoginRequestVO': { data: { success: true, studentId: 1, studentName: 'Student', authToken: 'mock-token-xyz', ssoAuthToken: 'mock-sso-token', programStatus: 'ACTIVE', currentLevel: 1, currentUnit: 1, units: [], placedOut: false, subdomain: 'offline', authenticateOnly: false }, className: 'com.lexialearning.lrs.api.LoginResponseVO' },
  'VerifySiteIdRequestVO': { data: { success: true, siteId: '0000', siteName: 'Offline Mode', isCore5: true, isValid: true }, className: 'com.lexialearning.lrs.api.VerifySiteIdResponseVO' },
  'UnitStatusRequestVO': { data: { success: true, units: [], currentUnit: 1, roundLeader: 0, stepId: 0, isStruggling: false, errorKindList: [] }, className: 'com.lexialearning.lrs.api.UnitStatusResponseVO' },
  'StepEndRequestVO': { data: { success: true, score: 100, passed: true, nextUnit: 1 }, className: 'com.lexialearning.lrs.api.StepEndResponseVO' },
  'LogoutRequestVO': { data: { success: true }, className: 'com.lexialearning.lrs.api.LogoutResponseVO' },
  'TeacherRequestVO': { data: { success: true, teacherName: 'Teacher', isAuthenticated: true }, className: 'com.lexialearning.lrs.api.TeacherResponseVO' },
  'GetCustomerFromTeacherRequestVO': { data: { success: true, customerName: 'Offline Customer', customerId: 1 }, className: null },
  'SaveWarmupScoreRequestVO': { data: { success: true, contentId: 0, overrideKind: '', time: 0, attemptList: [], work: '' }, className: 'com.lexialearning.lrs.api.SaveWarmupScoreResponseVO' },
  'LoggingRequestVO': { data: { success: true }, className: 'com.lexialearning.lrs.api.LoggingResponseVO' },
  'SaveUnitDataRequestVO': { data: { success: true }, className: null },
  'default': { data: { success: true }, className: null }
};

const CROSSDOMAIN_XML = `<?xml version="1.0"?>
<cross-domain-policy>
  <allow-access-from domain="*" secure="false"/>
  <allow-http-request-headers-from domain="*" headers="*"/>
</cross-domain-policy>`;

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercept crossdomain.xml from ANY domain
  if (url.pathname.endsWith('crossdomain.xml')) {
    console.log('[Bypass] crossdomain.xml:', url.href);
    notifyClients({ op: 'crossdomain.xml', format: 'xml' });
    event.respondWith(new Response(CROSSDOMAIN_XML, {
      status: 200,
      headers: { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' }
    }));
    return;
  }

  const isAMF = AMF_PATTERNS.some(p => p.test(url.pathname) || p.test(url.href));

  if (isAMF) {
    if (event.request.method === 'OPTIONS') {
      console.log('[Bypass] OPTIONS:', url.href);
      notifyClients({ op: 'OPTIONS preflight', format: 'cors' });
      event.respondWith(new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' }
      }));
      return;
    }

    if (event.request.method === 'POST') {
      console.log('[Bypass] AMF POST:', url.href);
      event.respondWith(
        event.request.arrayBuffer().then(body => {
          const bodyStr = new TextDecoder('utf-8', { fatal: false }).decode(body);
          let op = 'default';
          for (const key of Object.keys(mockResponses)) {
            if (key !== 'default' && bodyStr.includes(key)) { op = key; break; }
          }
          console.log('[Bypass] Op:', op, 'Body:', body.length, 'bytes');
          notifyClients({ op: op, format: 'AMF0', size: body.length });

          const mock = mockResponses[op] || mockResponses.default;
          const amf = buildAMF0Response('1', mock.data, mock.className);
          console.log('[Bypass] Response:', amf.length, 'bytes');
          return new Response(amf, {
            status: 200,
            headers: { 'Content-Type': 'application/x-amf', 'Access-Control-Allow-Origin': '*' }
          });
        }).catch(err => {
          console.error('[Bypass] Error:', err);
          notifyClients({ op: 'ERROR: ' + err.message, format: 'error' });
          const amf = buildAMF0Response('1', { success: true }, '');
          return new Response(amf, { status: 200, headers: { 'Content-Type': 'application/x-amf', 'Access-Control-Allow-Origin': '*' } });
        })
      );
      return;
    }

    // GET requests to AMF endpoints
    if (event.request.method === 'GET') {
      console.log('[Bypass] GET:', url.href);
      notifyClients({ op: 'GET ' + url.pathname, format: 'amf' });
      const amf = buildAMF0Response('1', { success: true }, '');
      event.respondWith(new Response(amf, {
        status: 200,
        headers: { 'Content-Type': 'application/x-amf', 'Access-Control-Allow-Origin': '*' }
      }));
      return;
    }
  }

  event.respondWith(fetch(event.request));
});
