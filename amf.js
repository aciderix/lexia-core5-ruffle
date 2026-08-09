// AMF0 encoder/decoder for Flash Remoting mock responses

// AMF0 type markers
const AMF0_NUMBER = 0x00;
const AMF0_BOOLEAN = 0x01;
const AMF0_STRING = 0x02;
const AMF0_OBJECT = 0x03;
const AMF0_NULL = 0x05;
const AMF0_UNDEFINED = 0x06;
const AMF0_REFERENCE = 0x07;
const AMF0_MIXED_ARRAY = 0x08;
const AMF0_ARRAY = 0x0A;
const AMF0_OBJECT_END = 0x09;
const AMF0_DATE = 0x0B;
const AMF0_LONG_STRING = 0x0C;
const AMF0_TYPED_OBJECT = 0x10;
const AMF0_XML = 0x0F;

class AMFWriter {
    constructor() {
        this.buf = [];
    }

    writeByte(b) { this.buf.push(b & 0xFF); }
    writeShort(s) { this.buf.push((s >> 8) & 0xFF, s & 0xFF); }
    writeInt(i) { this.buf.push((i >> 24) & 0xFF, (i >> 16) & 0xFF, (i >> 8) & 0xFF, i & 0xFF); }
    writeDouble(d) {
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, d);
        for (const b of new Uint8Array(buf)) this.buf.push(b);
    }
    writeUTF(s) {
        const enc = new TextEncoder().encode(s);
        this.writeShort(enc.length);
        for (const b of enc) this.buf.push(b);
    }
    writeLongUTF(s) {
        const enc = new TextEncoder().encode(s);
        this.writeInt(enc.length);
        for (const b of enc) this.buf.push(b);
    }

    writeString(s) {
        const enc = new TextEncoder().encode(s);
        if (enc.length > 65535) {
            this.writeByte(AMF0_LONG_STRING);
            this.writeLongUTF(s);
        } else {
            this.writeByte(AMF0_STRING);
            this.writeUTF(s);
        }
    }

    writeNull() { this.writeByte(AMF0_NULL); }
    writeUndefined() { this.writeByte(AMF0_UNDEFINED); }

    writeBoolean(b) {
        this.writeByte(AMF0_BOOLEAN);
        this.writeByte(b ? 1 : 0);
    }

    writeNumber(n) {
        this.writeByte(AMF0_NUMBER);
        this.writeDouble(n);
    }

    writeDate(d) {
        this.writeByte(AMF0_DATE);
        this.writeDouble(d.getTime());
        this.writeShort(0); // timezone
    }

    writeTypedObject(className, props) {
        this.writeByte(AMF0_TYPED_OBJECT);
        this.writeUTF(className);
        for (const [key, value] of Object.entries(props)) {
            this.writeUTF(key);
            this.writeValue(value);
        }
        this.writeUTF(''); // empty string = end of properties
        this.writeByte(AMF0_OBJECT_END);
    }

    writeObject(props) {
        this.writeByte(AMF0_OBJECT);
        for (const [key, value] of Object.entries(props)) {
            this.writeUTF(key);
            this.writeValue(value);
        }
        this.writeUTF('');
        this.writeByte(AMF0_OBJECT_END);
    }

    writeArray(arr) {
        this.writeByte(AMF0_ARRAY);
        this.writeInt(arr.length);
        for (const item of arr) {
            this.writeValue(item);
        }
    }

    writeMixedArray(props) {
        this.writeByte(AMF0_MIXED_ARRAY);
        this.writeInt(0); // associative count (0 for pure indexed)
        for (const [key, value] of Object.entries(props)) {
            this.writeUTF(key);
            this.writeValue(value);
        }
        this.writeUTF('');
        this.writeByte(AMF0_OBJECT_END);
    }

    writeValue(v) {
        if (v === null) { this.writeNull(); return; }
        if (v === undefined) { this.writeUndefined(); return; }
        if (typeof v === 'boolean') { this.writeBoolean(v); return; }
        if (typeof v === 'number') { this.writeNumber(v); return; }
        if (typeof v === 'string') { this.writeString(v); return; }
        if (v instanceof Date) { this.writeDate(v); return; }
        if (Array.isArray(v)) { this.writeArray(v); return; }
        if (v.__className) { this.writeTypedObject(v.__className, v); return; }
        if (typeof v === 'object') { this.writeObject(v); return; }
        this.writeNull();
    }

    toBuffer() {
        return new Uint8Array(this.buf).buffer;
    }
}

class AMFReader {
    constructor(data) {
        this.data = new Uint8Array(data);
        this.pos = 0;
    }

    readByte() { return this.data[this.pos++]; }
    readShort() { return (this.data[this.pos++] << 8) | this.data[this.pos++]; }
    readInt() { return (this.data[this.pos++] << 24) | (this.data[this.pos++] << 16) | (this.data[this.pos++] << 8) | this.data[this.pos++]; }
    readDouble() {
        const buf = new ArrayBuffer(8);
        const view = new Uint8Array(buf);
        for (let i = 0; i < 8; i++) view[i] = this.data[this.pos++];
        return new DataView(buf).getFloat64(0);
    }
    readUTF() {
        const len = this.readShort();
        const s = new TextDecoder().decode(this.data.slice(this.pos, this.pos + len));
        this.pos += len;
        return s;
    }
    readLongUTF() {
        const len = this.readInt();
        const s = new TextDecoder().decode(this.data.slice(this.pos, this.pos + len));
        this.pos += len;
        return s;
    }

    readValue() {
        const type = this.readByte();
        switch (type) {
            case AMF0_NUMBER: return this.readDouble();
            case AMF0_BOOLEAN: return this.readByte() !== 0;
            case AMF0_STRING: return this.readUTF();
            case AMF0_OBJECT: return this.readObject();
            case AMF0_NULL: return null;
            case AMF0_UNDEFINED: return undefined;
            case AMF0_REFERENCE: { const idx = this.readShort(); return { __ref: idx }; }
            case AMF0_MIXED_ARRAY: { this.readInt(); return this.readObject(); }
            case AMF0_ARRAY: return this.readArray();
            case AMF0_DATE: { const ts = this.readDouble(); this.readShort(); return new Date(ts); }
            case AMF0_LONG_STRING: return this.readLongUTF();
            case AMF0_TYPED_OBJECT: return this.readTypedObject();
            case AMF0_XML: return this.readLongUTF();
            default: return { __unknown_type: type, __pos: this.pos - 1 };
        }
    }

    readObject() {
        const obj = {};
        while (true) {
            const key = this.readUTF();
            if (key === '' && this.data[this.pos] === AMF0_OBJECT_END) {
                this.pos++; // consume end marker
                break;
            }
            obj[key] = this.readValue();
        }
        return obj;
    }

    readTypedObject() {
        const className = this.readUTF();
        const obj = this.readObject();
        obj.__className = className;
        return obj;
    }

    readArray() {
        const len = this.readInt();
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(this.readValue());
        return arr;
    }

    // Parse a complete AMF0 Flash Remoting request
    readRemotingMessage() {
        const version = this.readShort(); // 0x0000 for AMF0
        const headerCount = this.readShort();
        const headers = [];
        for (let i = 0; i < headerCount; i++) {
            const name = this.readUTF();
            const mustUnderstand = this.readByte() !== 0;
            const dataLen = this.readInt();
            const value = this.readValue();
            headers.push({ name, mustUnderstand, value });
        }
        const bodyCount = this.readShort();
        const bodies = [];
        for (let i = 0; i < bodyCount; i++) {
            const targetURI = this.readUTF();
            const responseURI = this.readUTF();
            const dataLen = this.readInt();
            const value = this.readValue();
            bodies.push({ targetURI, responseURI, value });
        }
        return { version, headers, bodies };
    }
}

// Build a Flash Remoting response message
function buildRemotingResponse(targetURI, responseURI, data) {
    const w = new AMFWriter();
    // AMF0 version
    w.writeShort(0);
    // Header count
    w.writeShort(0);
    // Body count
    w.writeShort(1);
    // Response URI (typically "/1/onResult")
    w.writeUTF(responseURI || '/1/onResult');
    // Target URI (echoes back null)
    w.writeUTF(targetURI || '');
    // Data length (not used by AMF0, but some implementations read it)
    w.writeInt(-1);
    // Data value
    w.writeValue(data);
    return w.toBuffer();
}

// Create mock response objects
function createHandshakeResponse() {
    return {
        __className: 'com.lexialearning.lrs.api:HandshakeResponseVO',
        success: true,
        handshakeDetail: 'Offline mode',
        language: 'en',
        locale: 'en_US',
        ssoAuthToken: '',
        ssoAuthTokenInvalid: false,
        serverVersion: '1.1.5.131',
        minClientVersion: '1.1.0.0',
        maxClientVersion: '99.99.99.99'
    };
}

function createLoginResponse() {
    return {
        __className: 'com.lexialearning.lrs.api:LoginResponseVO',
        success: true,
        authToken: 'offline-auth-token-001',
        studentId: 1,
        loginResponse: null,
        secondsSinceLastLogin: 0,
        hoursSinceLastLogin: 0,
        daysSinceLastLogin: 0,
        language: 'en',
        level: 1,
        unit: 1,
        program: 'Core5',
        currentUnitIdList: [1],
        startUnit: 1,
        unitIdList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
        programStatus: null
    };
}

function createDefaultResponse() {
    return { success: true, data: null, error: null };
}

module.exports = {
    AMFReader, AMFWriter, buildRemotingResponse,
    createHandshakeResponse, createLoginResponse, createDefaultResponse,
    AMF0_TYPED_OBJECT, AMF0_OBJECT, AMF0_OBJECT_END
};
