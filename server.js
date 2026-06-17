const express = require('express');
const http = require('http');
const cors = require('cors');
const admin = require('firebase-admin');
const { Server } = require('socket.io');
const { TikTokLiveConnection, SignConfig } = require('tiktok-live-connector'); // إضافة مكتبة تيك توك
const WebSocket = global.WebSocket; // الويب سوكت المدمج بنود 22+ لدعم تويتش وكيك بدون إضافات خارجية

// تهيئة Long لدعم الأرقام الكبيرة من تيك توك 2.x بشكل آمن ومتوافق
let Long = null;
try {
    Long = require('long');
} catch (e) {
    console.warn("⚠️ Warning: 'long' package not found in node_modules. Using custom fallback parser.");
}

function ensureStringId(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'number') return String(val);
    if (Long && Long.isLong(val)) return val.toString();
    if (typeof val === 'object') {
        if (val.low !== undefined && val.high !== undefined) {
            if (Long) {
                return new Long(val.low, val.high, val.unsigned).toString();
            } else {
                const high = val.high;
                const low = val.low;
                if (val.unsigned) {
                    return ((high >>> 0) * 4294967296 + (low >>> 0)).toString();
                } else {
                    return (high * 4294967296 + (low >>> 0)).toString();
                }
            }
        }
        if (typeof val.toString === 'function') {
            return val.toString();
        }
    }
    return String(val);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);

// كلمة السر للوحة التحكم لألعاب التيك توك (القديمة)
const ADMIN_PASSWORD = 'admin';
// كلمة السر لإدارة الأكواد ولوحة التحكم الخاصة بالأكواد (qghazy66admin)
const CODES_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123';

// تهيئة Firebase Admin SDK
let serviceAccount = null;

if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY.trim();
    // إزالة علامات الاقتباس المزدوجة أو الفردية الزائدة إن وجدت بالخطأ في البيئة
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
        privateKey = privateKey.substring(1, privateKey.length - 1);
    }
    if (privateKey.startsWith("'") && privateKey.endsWith("'")) {
        privateKey = privateKey.substring(1, privateKey.length - 1);
    }
    privateKey = privateKey.replace(/\\n/g, '\n');

    serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
    };
} else {
    try {
        serviceAccount = require('./serviceAccountKey.json');
    } catch (e) {
        console.warn("⚠️ Warning: serviceAccountKey.json not found and environment variables not set. Firebase Admin SDK will not work.");
    }
}

if (serviceAccount) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("🔥 Firebase Admin SDK initialized successfully.");
    } catch (error) {
        console.error("❌ Firebase Admin SDK initialization error:", error.message);
    }
} else {
    console.error("❌ Firebase Admin SDK cannot be initialized (no credentials found).");
}

const db = serviceAccount ? admin.firestore() : null;

// تهيئة خادم توقيع اتصال التيك توك بشكل عام
try {
    if (process.env.TIKTOK_SIGN_API_KEY) {
        SignConfig.apiKey = process.env.TIKTOK_SIGN_API_KEY.trim();
    }
    // لا نضع رابط افتراضي للسيرفر حتى تستخدم المكتبة الإعدادات الداخلية المحدثة الخاصة بها
    // نضع الرابط فقط إذا كان محدد في البيئة
    if (process.env.TIKTOK_SIGN_HOST) {
        SignConfig.basePath = process.env.TIKTOK_SIGN_HOST.trim().replace(/\/+$/, '');
        console.log(`[TikTok SignConfig] Configured custom BasePath: ${SignConfig.basePath}`);
    }
} catch (e) {
    console.error(`[TikTok SignConfig] Error setting SignConfig:`, e.message);
}

// ===== [SECURITY] التوقيع الرقمي وإدارة الجلسات الآمنة =====
const crypto = require('crypto');
const SIGNING_SECRET = process.env.SIGNING_SECRET || 'kio_super_secret_signing_key_2026';

function generateSecureToken(payload) {
    const dataString = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', SIGNING_SECRET).update(dataString).digest('hex');
    return `${Buffer.from(dataString).toString('base64')}.${signature}`;
}

function verifySecureToken(token) {
    try {
        if (!token) return null;
        const parts = token.split('.');
        if (parts.length !== 2) return null;

        const payloadStr = Buffer.from(parts[0], 'base64').toString('utf8');
        const signature = parts[1];
        const expectedSignature = crypto.createHmac('sha256', SIGNING_SECRET).update(payloadStr).digest('hex');

        if (signature !== expectedSignature) return null;
        return JSON.parse(payloadStr);
    } catch (e) {
        return null;
    }
}

// Removed verifySocketAuth definition as requested.

// --- Image Proxy لصور التيك توك (تجاوز قيود CORS) ---
app.get('/api/proxy-image', (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('Missing url');

    const allowedDomains = [
        'tiktokcdn.com', 'tiktok.com', 'muscdn.com',
        'byteoversea.com', 'ibytedtos.com', 'akamaized.net',
        'ibyteimg.com', 'byteimg.com', 'ipstatp.com'
    ];

    let hostname;
    try { hostname = new URL(url).hostname; }
    catch(e) { return res.status(400).send('Invalid URL'); }

    if (!allowedDomains.some(d => hostname.endsWith(d))) {
        return res.status(403).send('Domain not allowed');
    }

    const https = require('https');
    const fallback = `https://ui-avatars.com/api/?name=U&background=random&color=fff`;

    const request = https.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.tiktok.com/',
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        timeout: 8000
    }, (imgRes) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
        imgRes.pipe(res);
    });

    request.on('error', () => {
        if (!res.headersSent) res.redirect(fallback);
    });
    request.on('timeout', () => {
        request.destroy();
        if (!res.headersSent) res.redirect(fallback);
    });
});

// --- APIs للتحكم بالأكواد وإدارة الجلسات ---


// 1. جلب الأكواد للمدير
app.get('/api/admin/codes', (req, res, next) => {
    const pass = req.headers['x-admin-password'] || req.query.pass;
    if (pass !== CODES_ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'رمز التحقق خاطئ' });
    next();
}, async (req, res) => {
    const { collection } = req.query;
    if (!['codes', 'encyclopedia_codes', 'tiktok_codes'].includes(collection)) {
        return res.status(400).json({ success: false, message: 'اسم المجموعة غير صحيح' });
    }
    if (!db) return res.status(500).json({ success: false, message: 'قاعدة البيانات غير مهيأة' });

    try {
        const snapshot = await db.collection(collection).orderBy('createdAt', 'desc').get();
        const codes = [];
        snapshot.forEach(doc => {
            codes.push({ id: doc.id, ...doc.data() });
        });
        res.json({ success: true, codes });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. إنشاء كود جديد
app.post('/api/admin/create-code', (req, res, next) => {
    const pass = req.headers['x-admin-password'] || req.body.pass;
    if (pass !== CODES_ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'رمز التحقق خاطئ' });
    next();
}, async (req, res) => {
    const { collection, docId, data } = req.body;
    if (!['codes', 'encyclopedia_codes', 'tiktok_codes'].includes(collection)) {
        return res.status(400).json({ success: false, message: 'اسم المجموعة غير صحيح' });
    }
    if (!db) return res.status(500).json({ success: false, message: 'قاعدة البيانات غير مهيأة' });

    try {
        if (docId) {
            const docRef = db.collection(collection).doc(docId);
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                return res.status(400).json({ success: false, message: 'هذا الكود مستخدم بالفعل!' });
            }
            await docRef.set(data);
            res.json({ success: true, id: docId });
        } else {
            const docRef = await db.collection(collection).add(data);
            res.json({ success: true, id: docRef.id });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. تحديث كود
app.post('/api/admin/update-code', (req, res, next) => {
    const pass = req.headers['x-admin-password'] || req.body.pass;
    if (pass !== CODES_ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'رمز التحقق خاطئ' });
    next();
}, async (req, res) => {
    const { collection, id, data } = req.body;
    if (!['codes', 'encyclopedia_codes', 'tiktok_codes'].includes(collection)) {
        return res.status(400).json({ success: false, message: 'اسم المجموعة غير صحيح' });
    }
    if (!db) return res.status(500).json({ success: false, message: 'قاعدة البيانات غير مهيأة' });

    try {
        await db.collection(collection).doc(id).update(data);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. تغيير نص الكود (تخصيص الكود)
app.post('/api/admin/change-code-string', (req, res, next) => {
    const pass = req.headers['x-admin-password'] || req.body.pass;
    if (pass !== CODES_ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'رمز التحقق خاطئ' });
    next();
}, async (req, res) => {
    const { collection, id, newCode } = req.body;
    if (!['codes', 'encyclopedia_codes', 'tiktok_codes'].includes(collection)) {
        return res.status(400).json({ success: false, message: 'اسم المجموعة غير صحيح' });
    }
    if (!db) return res.status(500).json({ success: false, message: 'قاعدة البيانات غير مهيأة' });

    try {
        if (collection === 'codes') {
            const q = await db.collection('codes').where('code', '==', newCode).get();
            if (!q.empty) {
                return res.status(400).json({ success: false, message: 'هذا الكود مستخدم بالفعل! اختر كوداً آخر.' });
            }
            await db.collection('codes').doc(id).update({ code: newCode });
            res.json({ success: true });
        } else {
            const newDocRef = db.collection(collection).doc(newCode);
            const newDocSnap = await newDocRef.get();
            if (newDocSnap.exists) {
                return res.status(400).json({ success: false, message: 'هذا الكود مستخدم بالفعل! اختر كوداً آخر.' });
            }

            const oldDocRef = db.collection(collection).doc(id);
            const oldDocSnap = await oldDocRef.get();
            if (oldDocSnap.exists) {
                const data = oldDocSnap.data();
                data.code = newCode;
                await newDocRef.set(data);
                await oldDocRef.delete();
                res.json({ success: true });
            } else {
                res.status(404).json({ success: false, message: 'الكود القديم غير موجود' });
            }
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 5. حذف كود
app.post('/api/admin/delete-code', (req, res, next) => {
    const pass = req.headers['x-admin-password'] || req.body.pass;
    if (pass !== CODES_ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'رمز التحقق خاطئ' });
    next();
}, async (req, res) => {
    const { collection, id } = req.body;
    if (!['codes', 'encyclopedia_codes', 'tiktok_codes'].includes(collection)) {
        return res.status(400).json({ success: false, message: 'اسم المجموعة غير صحيح' });
    }
    if (!db) return res.status(500).json({ success: false, message: 'قاعدة البيانات غير مهيأة' });

    try {
        await db.collection(collection).doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 6. واجهة تحقق المستخدمين من كود الألعاب المميزة
const validateGameCodeHandler = async (req, res) => {
    const { code, deviceId } = req.body;
    if (!code || !deviceId) {
        return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
    }
    if (!db) return res.status(500).json({ success: false, message: 'قاعدة البيانات غير مهيأة' });

    try {
        const q = await db.collection('codes').where('code', '==', code).get();
        if (q.empty) {
            return res.status(404).json({ success: false, message: 'الكود الذي أدخلته غير موجود!' });
        }

        let docRef = null;
        let data = null;
        q.forEach(doc => {
            docRef = doc.ref;
            data = doc.data();
        });

        const now = new Date();
        const expiry = new Date(data.end);
        if (now > expiry) {
            return res.status(400).json({ success: false, message: 'عذراً، انتهت صلاحية هذا الكود.', isExpired: true });
        }

        const usedDevices = data.usedDevices || [];
        const maxDevices = Number(data.maxDevices) || 1;
        const isRegistered = usedDevices.includes(deviceId);

        // توليد توكن الجلسة الآمن
        const token = generateSecureToken({
            type: 'vip',
            code: code,
            client: data.client,
            games: data.games,
            deviceId: deviceId,
            expiry: Math.min(Date.now() + 12 * 60 * 60 * 1000, new Date(data.end).getTime())
        });

        if (isRegistered) {
            await docRef.update({ lastLogin: new Date().toISOString() });
            return res.json({ success: true, client: data.client, games: data.games, token: token });
        } else {
            if (usedDevices.length >= maxDevices) {
                return res.status(400).json({ success: false, message: `تم استخدام الحد الأقصى من الأجهزة (${usedDevices.length} من ${maxDevices}).` });
            } else {
                usedDevices.push(deviceId);
                await docRef.update({
                    usedDevices: usedDevices,
                    lastLogin: new Date().toISOString()
                });
                return res.json({ success: true, client: data.client, games: data.games, token: token });
            }
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

app.post('/api/user/validate-game-code', validateGameCodeHandler);
app.post('/api/user/validate-code', validateGameCodeHandler);

// 7. واجهة تحقق المستخدمين من كود الموسوعة
app.post('/api/user/validate-encyclopedia-code', async (req, res) => {
    const { code, deviceId } = req.body;
    if (!code || !deviceId) {
        return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
    }
    if (!db) return res.status(500).json({ success: false, message: 'قاعدة البيانات غير مهيأة' });

    try {
        const docRef = db.collection('encyclopedia_codes').doc(code);
        const docSnap = await docRef.get();
        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'تأكد من الكود.' });
        }

        const data = docSnap.data();
        const now = new Date();
        const expiry = new Date(data.expiryDate);
        if (now > expiry) {
            return res.status(400).json({ success: false, message: 'انتهت صلاحية الكود.', isExpired: true });
        }

        const usedDevices = data.usedDevices || [];
        if (data.device && !usedDevices.includes(data.device)) {
            usedDevices.push(data.device);
        }
        const maxDevices = Number(data.maxDevices) || 1;
        const isRegistered = usedDevices.includes(deviceId);

        // توليد توكن الجلسة الآمن
        const token = generateSecureToken({
            type: 'encyclopedia',
            code: code,
            client: data.client,
            deviceId: deviceId,
            expiry: new Date(data.expiryDate).getTime()
        });

        if (isRegistered) {
            await docRef.update({ lastLogin: new Date().toISOString() });
            return res.json({ success: true, client: data.client, expiryDate: data.expiryDate, maxDevices: data.maxDevices, token: token });
        } else {
            if (usedDevices.length >= maxDevices) {
                return res.status(400).json({ success: false, message: `هذا الكود مستخدم بالفعل على ${usedDevices.length} من ${maxDevices} أجهزة مسموحة.` });
            } else {
                usedDevices.push(deviceId);
                await docRef.update({
                    usedDevices: usedDevices,
                    lastLogin: new Date().toISOString()
                });
                return res.json({ success: true, client: data.client, expiryDate: data.expiryDate, maxDevices: data.maxDevices, token: token });
            }
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 8. واجهة تحقق المستخدمين من كود ألعاب تيك توك
app.post('/api/user/validate-tiktok-code', async (req, res) => {
    const { code, deviceId, platform } = req.body;
    if (!code || !deviceId) {
        return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
    }
    if (code === '6565799') {
        const token = generateSecureToken({
            type: 'tiktok',
            code: code,
            client: 'Maintenance Mode',
            deviceId: deviceId,
            platform: platform || 'tiktok',
            expiry: Date.now() + 30 * 24 * 60 * 60 * 1000
        });
        return res.json({
            success: true,
            client: 'Maintenance Mode',
            expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            maxDevices: 5,
            token: token
        });
    }
    if (!db) return res.status(500).json({ success: false, message: 'قاعدة البيانات غير مهيأة' });

    try {
        const docRef = db.collection('tiktok_codes').doc(code);
        const docSnap = await docRef.get();
        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: 'تأكد من الكود.' });
        }

        const data = docSnap.data();
        const now = new Date();
        const expiry = new Date(data.expiryDate);
        if (now > expiry) {
            return res.status(400).json({ success: false, message: 'انتهت صلاحية الكود.', isExpired: true });
        }

        if (data.platforms && data.platforms.length > 0) {
            const requestedPlatform = platform || 'tiktok';
            if (!data.platforms.includes('all') && !data.platforms.includes(requestedPlatform)) {
                const platformNames = { tiktok: 'تيك توك', twitch: 'تويتش', kick: 'كيك' };
                const pName = platformNames[requestedPlatform] || requestedPlatform;
                return res.status(400).json({ success: false, message: `عذراً، هذا الكود غير مفعل لمنصة ${pName}.` });
            }
        }

        const usedDevices = data.usedDevices || [];
        if (data.device && !usedDevices.includes(data.device)) {
            usedDevices.push(data.device);
        }
        const maxDevices = Number(data.maxDevices) || 1;
        const isRegistered = usedDevices.includes(deviceId);

        // توليد توكن الجلسة الآمن (يتضمن الألعاب المسموح بها)
        const token = generateSecureToken({
            type: 'tiktok',
            code: code,
            client: data.client,
            games: data.games || [],
            deviceId: deviceId,
            platform: platform || 'tiktok',
            expiry: new Date(data.expiryDate).getTime()
        });

        if (isRegistered) {
            await docRef.update({ lastLogin: new Date().toISOString() });
            return res.json({ success: true, client: data.client, games: data.games || [], expiryDate: data.expiryDate, maxDevices: data.maxDevices, token: token });
        } else {
            if (usedDevices.length >= maxDevices) {
                return res.status(400).json({ success: false, message: `هذا الكود مستخدم بالفعل على ${usedDevices.length} من ${maxDevices} أجهزة مسموحة.` });
            } else {
                usedDevices.push(deviceId);
                await docRef.update({
                    usedDevices: usedDevices,
                    lastLogin: new Date().toISOString()
                });
                return res.json({ success: true, client: data.client, games: data.games || [], expiryDate: data.expiryDate, maxDevices: data.maxDevices, token: token });
            }
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- دالة جلب معرف غرفة دردشة كيك (Kick Chatroom ID) ---
const https = require('https');
function fetchKickChatroom(channelName) {
    return new Promise((resolve, reject) => {
        const url = `https://kick.com/api/v1/channels/${encodeURIComponent(channelName)}`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        };

        const proxyUrl = process.env.TIKTOK_PROXY_URL;
        if (proxyUrl) {
            try {
                const { HttpsProxyAgent } = require('https-proxy-agent');
                options.agent = new HttpsProxyAgent(proxyUrl);
                console.log(`[Kick Resolve Proxy] Using HttpsProxyAgent to resolve chatroom ID for @${channelName}`);
            } catch (proxyErr) {
                console.error(`[Kick Resolve Proxy Error] failed to init agent:`, proxyErr.message);
            }
        }

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        if (json && json.chatroom && json.chatroom.id) {
                            resolve(json.chatroom.id);
                        } else {
                            reject(new Error('Chatroom ID not found in response'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Kick API returned status code ${res.statusCode}`));
                }
            });
        }).on('error', reject);
    });
}

// --- اتصال شات تويتش عبر الويب سوكت (Twitch Chat IRC Client) ---
function connectTwitchChat(username, onChat, onConnected, onDisconnected, onError) {
    const channel = username.toLowerCase().replace('#', '').trim();
    const wsUrl = 'wss://irc-ws.chat.twitch.tv:443';
    let ws;
    let isClosed = false;

    function connect() {
        if (isClosed) return;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log(`[Twitch Socket] Connected for channel #${channel}`);
            ws.send('PASS oauth:dummy');
            const nickNumber = Math.floor(10000 + Math.random() * 90000);
            ws.send(`NICK justinfan${nickNumber}`);
            ws.send(`JOIN #${channel}`);
            if (onConnected) onConnected();
        };

        ws.onmessage = (event) => {
            const raw = event.data.toString();
            const lines = raw.split('\r\n');
            for (const line of lines) {
                if (line.startsWith('PING ')) {
                    ws.send('PONG :tmi.twitch.tv');
                } else {
                    const match = line.match(/^:([^!]+)![^@]+@[^ ]+ PRIVMSG #[^ ]+ :(.+)$/);
                    if (match) {
                        const sender = match[1];
                        const text = match[2];
                        onChat({
                            uniqueId: sender,
                            nickname: sender,
                            comment: text,
                            profilePictureUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(sender)}&background=6441a5&color=fff`
                        });
                    }
                }
            }
        };

        ws.onclose = () => {
            console.log(`[Twitch Socket] Closed for channel #${channel}`);
            if (!isClosed) {
                setTimeout(connect, 5000); // إعادة اتصال تلقائي
            } else if (onDisconnected) {
                onDisconnected();
            }
        };

        ws.onerror = (err) => {
            console.error(`[Twitch Socket Error] #${channel}:`, err.message || err);
            if (onError) onError(err);
        };
    }

    connect();

    return {
        disconnect: () => {
            isClosed = true;
            if (ws) {
                try { ws.close(); } catch(e){}
            }
        }
    };
}

// --- اتصال شات كيك عبر الويب سوكت (Kick Chat Pusher Client) ---
function connectKickChat(username, onChat, onConnected, onDisconnected, onError) {
    const channel = username.toLowerCase().trim();
    let ws;
    let isClosed = false;

    async function getChatroomId() {
        return await fetchKickChatroom(channel);
    }

    async function connect() {
        if (isClosed) return;
        
        let chatroomId;
        try {
            chatroomId = await getChatroomId();
        } catch (e) {
            console.log(`[Kick Connect] Retrying room resolution for @${channel} in 10s...`);
            if (!isClosed) setTimeout(connect, 10000);
            if (onError) onError(new Error(`فشل تحديد معرف القناة لـ @${channel}. ربما الاسم غير موجود أو الحماية تحجب السيرفر.`));
            return;
        }

        const wsUrl = `wss://ws-us2.pusher.com/app/eb1d5f28b2d40d25514f?protocol=7&client=js&version=7.0.6&flash=false`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log(`[Kick Pusher Socket] Connected for channel @${channel} (Chatroom: ${chatroomId})`);
            const subscribeMsg = JSON.stringify({
                event: 'pusher:subscribe',
                data: {
                    auth: '',
                    channel: `chatrooms.${chatroomId}.v2`
                }
            });
            ws.send(subscribeMsg);
            if (onConnected) onConnected();
        };

        ws.onmessage = (event) => {
            const raw = event.data.toString();
            try {
                const packet = JSON.parse(raw);
                if (packet.event === 'App\\Events\\ChatMessageEvent') {
                    const messageData = JSON.parse(packet.data);
                    if (messageData && messageData.sender) {
                        const sender = messageData.sender.username;
                        const text = messageData.content;
                        onChat({
                            uniqueId: sender,
                            nickname: sender,
                            comment: text,
                            profilePictureUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(sender)}&background=53fc18&color=000`
                        });
                    }
                }
            } catch (e) {}
        };

        ws.onclose = () => {
            console.log(`[Kick Socket] Closed for channel @${channel}`);
            if (!isClosed) {
                setTimeout(connect, 5000); // إعادة اتصال تلقائي
            } else if (onDisconnected) {
                onDisconnected();
            }
        };

        ws.onerror = (err) => {
            console.error(`[Kick Socket Error] @${channel}:`, err.message || err);
            if (onError) onError(err);
        };
    }

    connect();

    return {
        disconnect: () => {
            isClosed = true;
            if (ws) {
                try { ws.close(); } catch(e){}
            }
        }
    };
}

// --- معالج شات البث المركزي للألعاب ---
function handleStreamChat(roomId, roomName, data) {
    const room = roomsData[roomId];
    if (!room) return;

    if (room.gameState && room.gameState.gameType === 'tiktok_marathon') {
        handleMarathonChat(roomId, data);
        return;
    }
    if (!room.chatFilter) return; // تجاهل الشات إذا لم يكن هناك فلتر نشط

    const commentRaw = data.comment.trim();
    const commentNorm = normalizeArabicForServer(commentRaw);

    if (room.chatFilter.type === 'exact') {
        const targets = (room.chatFilter.targets || []).map(t => normalizeArabicForServer(t));
        if (targets.includes(commentNorm)) {
            io.to(roomName).emit('tiktok_chat', data);
            room.chatFilter = null; // بمجرد إيجاد فائز، يتم مسح الفلتر
        }
    } else if (room.chatFilter.type === 'contains_any') {
        const targets = (room.chatFilter.targets || []).map(t => normalizeArabicForServer(t));
        const matched = targets.find(t => commentNorm.includes(t));
        if (matched) {
            io.to(roomName).emit('tiktok_chat', { ...data, matchedTarget: matched });
        }
    } else if (room.chatFilter.type === 'active_players') {
        const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
        const playersList = (room.chatFilter.players || []).map(p => p.toLowerCase());
        
        if (playersList.includes(uniqueId)) {
            if (room.chatFilter.regex) {
                try {
                    const regex = new RegExp(room.chatFilter.regex, room.chatFilter.regexFlags || '');
                    if (regex.test(commentRaw) || regex.test(commentNorm)) {
                        io.to(roomName).emit('tiktok_chat', data);
                    }
                } catch (regexErr) {
                    io.to(roomName).emit('tiktok_chat', data);
                }
            } else {
                io.to(roomName).emit('tiktok_chat', data);
            }
        }
    } else if (room.chatFilter.type === 'regex') {
        if (room.chatFilter.regex) {
            try {
                const regex = new RegExp(room.chatFilter.regex, room.chatFilter.regexFlags || 'i');
                if (regex.test(commentRaw) || regex.test(commentNorm)) {
                    io.to(roomName).emit('tiktok_chat', data);
                }
            } catch (regexErr) {}
        }
    } else if (room.chatFilter.type === 'all') {
        io.to(roomName).emit('tiktok_chat', data);
    }
}

// 9. واجهة التحقق الآمن من التوكن والجلسة
app.post('/api/user/verify-session', async (req, res) => {
    const { token, deviceId, type } = req.body;

    console.log(`[Verify Session] request received - type: ${type}, deviceId: ${deviceId}`);

    if (!token) {
        console.warn(`[Verify Session] Rejected - Missing token`);
        return res.status(400).json({ success: false, message: 'توكن مفقود' });
    }

    const payload = verifySecureToken(token);
    if (!payload) {
        console.warn(`[Verify Session] Rejected - Invalid token or signature failed`);
        return res.status(401).json({ success: false, message: 'توكن غير صالح أو منتهي الصلاحية' });
    }

    console.log(`[Verify Session] Token payload:`, payload);

    if (type && payload.type !== type) {
        console.warn(`[Verify Session] Rejected - Session type mismatch: expected ${type}, got ${payload.type}`);
        return res.status(403).json({ success: false, message: 'نوع جلسة غير متطابق' });
    }
    if (deviceId && payload.deviceId !== deviceId) {
        console.warn(`[Verify Session] Rejected - Device ID mismatch: payload has ${payload.deviceId}, request has ${deviceId}`);
        return res.status(403).json({ success: false, message: 'جلسة مسجلة لجهاز آخر' });
    }
    if (Date.now() > payload.expiry) {
        console.warn(`[Verify Session] Rejected - Session expired: current time ${Date.now()}, expiry ${payload.expiry}`);
        return res.status(401).json({ success: false, message: 'انتهت صلاحية الجلسة' });
    }

    console.log(`[Verify Session] Approved - client: ${payload.client}`);
    res.json({ success: true, client: payload.client, games: payload.games });
});

// الخزنة الرئيسية اللي هتشيل كل بيانات الرومات المفتوحة في الرامات
const roomsData = {};
// سجل أوقات عمليات الربط لمنع السبام والكول داون بين الألعاب
const connectionCooldowns = {};

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware للتحقق من هوية الهوست في اتصال السوكت
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const isHost = socket.handshake.auth?.isHost;

    if (token) {
        const payload = verifySecureToken(token);
        if (!payload) {
            console.warn(`[Socket Auth] Rejected - Host socket invalid token signature (Socket ID: ${socket.id})`);
            if (isHost) return next(new Error('Authentication error: Invalid token signature'));
        } else if (Date.now() > payload.expiry) {
            console.warn(`[Socket Auth] Rejected - Host socket token expired (Socket ID: ${socket.id})`);
            if (isHost) return next(new Error('Authentication error: Token expired'));
        } else {
            // حفظ بيانات الجلسة المصدقة في السوكت
            socket.decodedToken = payload;
            console.log(`[Socket Auth] Approved connection with token - Client: ${payload.client}, Type: ${payload.type} (Socket ID: ${socket.id})`);
        }
    } else if (isHost) {
        console.warn(`[Socket Auth] Rejected - Host socket missing token (Socket ID: ${socket.id})`);
        return next(new Error('Authentication error: Missing token for Host connection'));
    }
    next();
});


// --- دالة تحديث الداشبورد ---
function broadcastDashboardUpdate() {
    const activeRooms = {};
    for (const id in roomsData) {
        const state = roomsData[id].gameState || {};
        const gType = state.gameType || state.type || "غير معروف";

        activeRooms[id] = {
            playerCount: io.sockets.adapter.rooms.get(id)?.size || 0,
            createdAt: roomsData[id].createdAt,
            gameType: gType,
            isTikTok: roomsData[id].isTikTok || false,
            tiktokUser: roomsData[id].tiktokUser || null
        };
    }
    io.to('admin_room').emit('roomsUpdate', activeRooms);
}

function resetRoomTimer(roomId) {
    if (roomsData[roomId]) {
        if (roomsData[roomId].timer) {
            clearTimeout(roomsData[roomId].timer);
            roomsData[roomId].timer = null;
        }
        // تم إلغاء تنظيف الغرفة التلقائي بسبب الخمول لمنع حذف الرومات أثناء البث
    }
}

app.get('/', (req, res) => {
    res.send('Welcome to Q-Kio Server! السيرفر شغال وجاهز لاستقبال اللاعبين 🎮');
});

// --- لوحة التحكم ---
app.get('/dashboard', (req, res) => {
    if (req.query.pass !== ADMIN_PASSWORD) {
        return res.status(401).send('<h2 style="color:red; text-align:center;">عفواً، غير مصرح لك بالدخول</h2>');
    }

    res.send(`
        <html dir="rtl">
        <head>
            <title>لوحة تحكم Q-Kio اللحظية</title>
            <script src="/socket.io/socket.io.js"></script>
            <style>
                body { font-family: Arial; padding: 20px; background: #f4f4f9; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; background: white; box-shadow: 0 4px 8px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden;}
                th, td { padding: 15px; border-bottom: 1px solid #ddd; text-align: center; }
                th { background-color: #1e2a38; color: white; }
                tr:hover { background-color: #f1f1f1; }
                .btn-delete { background: #e74c3c; color: white; border: none; padding: 8px 15px; cursor: pointer; border-radius: 4px; font-weight: bold;}
                .btn-delete:hover { background: #c0392b; }
                .live-badge { background: #2ecc71; color: white; padding: 3px 8px; border-radius: 12px; font-size: 12px; animation: pulse 2s infinite; }
                .game-badge { background: rgba(0, 198, 255, 0.1); color: #0072ff; padding: 6px 12px; border-radius: 20px; font-weight: bold; border: 1px solid rgba(0, 198, 255, 0.3); display: inline-block; }
                .tiktok-badge { background: rgba(255, 0, 80, 0.1); color: #EE1D52; border-color: rgba(255, 0, 80, 0.3); }
                @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
            </style>
        </head>
        <body>
            <h2>رومات Q-Kio النشطة <span class="live-badge">Live 🔴</span></h2>
            <table>
                <thead>
                    <tr>
                        <th>رقم الروم (الكود / يوزر التيك توك)</th>
                        <th>اللعبة</th>
                        <th>عدد الأجهزة المتصلة</th>
                        <th>تاريخ الإنشاء</th>
                        <th>إجراءات</th>
                    </tr>
                </thead>
                <tbody id="roomsTable">
                    <tr><td colspan="5">جاري التحميل...</td></tr>
                </tbody>
            </table>

            <script>
                const socket = io();
                
                const gameNamesMap = {
                    'bathara': 'بعثرة 🧩',
                    'bingo': 'بينجو 🔢',
                    'risk_game': 'المجازفة 🃏',
                    'tarkiba': 'تركيبة 🔠',
                    'decode': 'فك الشفرة 🕵️',
                    'coordinates': 'إحداثيات 🎯',
                    'tiktok_bomb': 'تيك توك: القنبلة 💣',
                    'tiktok_roulette': 'تيك توك: الروليت والإقصاء 🎡',
                    'tiktok_russian_roulette': 'تيك توك: الروليت الروسي 🔫',
                    'tiktok_marathon': 'تيك توك: الماراثون الجماعي 🏃‍♂️',
                    'tiktok_rockets': 'تيك توك: حرب الصواريخ 🚀',
                    'tiktok_sniper': 'تيك توك: القناص 🎯',
                    'trivia_survival': 'تيك توك: شطب ❌',
                    'tiktok-trivia-survival': 'تيك توك: شطب ❌',
                    'tiktok_trivia_survival': 'تيك توك: شطب ❌',
                    'kharabisha': 'تيك توك: خربيشة ✏️',
                    'numble': 'تيك توك: نمبل 🔢',
                    'hexagon-maze': 'تيك توك: المتاهة السداسية 🌀',
                    'salata': 'تيك توك: سلطة 🥗',
                    'zehniat': 'تيك توك: ذهنيات 🧠',
                    'million_decision': 'قرار بمليون 💰',
                    'غير معروف': 'في الانتظار ⏳'
                };
                
                socket.emit('adminLogin', '${ADMIN_PASSWORD}');

                socket.on('roomsUpdate', (rooms) => {
                    const tbody = document.getElementById('roomsTable');
                    const roomIds = Object.keys(rooms);

                    if (roomIds.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="5">لا توجد أي رومات مفتوحة حالياً.</td></tr>';
                        return;
                    }

                    let html = '';
                    roomIds.forEach(id => {
                        const room = rooms[id];
                        const time = new Date(room.createdAt).toLocaleTimeString('ar-EG');
                        const count = room.playerCount;
                        const gType = room.gameType;
                        const gameDisplayName = gameNamesMap[gType] || gType;
                        
                        let displayId = id;
                        let badgeClass = 'game-badge';
                        if(room.isTikTok) {
                            displayId = '@' + room.tiktokUser;
                            badgeClass += ' tiktok-badge';
                        }

                        html += \`
                            <tr>
                                <td><strong style="font-size:1.1rem;">\${displayId}</strong></td>
                                <td><span class="\${badgeClass}">\${gameDisplayName}</span></td>
                                <td><strong>\${count}</strong> جهاز</td>
                                <td>\${time}</td>
                                <td>
                                    <button class="btn-delete" onclick="deleteRoom('\${id}')">إغلاق وحذف</button>
                                </td>
                            </tr>
                        \`;
                    });
                    tbody.innerHTML = html;
                });

                function deleteRoom(id) {
                    if(confirm('متأكد من إغلاق وحذف روم ' + id + ' نهائياً؟')) {
                        fetch('/delete-room?id=' + id + '&pass=${ADMIN_PASSWORD}');
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/delete-room', (req, res) => {
    if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('غير مصرح لك');
    const roomId = req.query.id;

    if (roomsData[roomId]) {
        clearTimeout(roomsData[roomId].timer);
        if (roomsData[roomId].tiktokConn) {
            roomsData[roomId].tiktokConn.disconnect();
        }
        if (marathonLoops[roomId]) {
            clearInterval(marathonLoops[roomId]);
            delete marathonLoops[roomId];
        }
        // تنظيف queue الأحداث عند حذف الغرفة
        delete marathonQueues[roomId];
        io.to(roomId).emit('roomClosed', 'تم إغلاق الغرفة من قبل الإدارة');
        io.in(roomId).socketsLeave(roomId);
        delete roomsData[roomId];
        broadcastDashboardUpdate();
    }
    res.send('تم الحذف بنجاح');
});


// ==========================================
//   منطق الماراثون الجماعي (Marathon Game Backend)
// ==========================================
const marathonLoops = {};

// ==========================================
//   نظام قائمة الأحداث (Event Queue System)
//   بدلاً من معالجة كل حدث فورياً (تُعيق الـ event loop)،
//   تُخزَّن الأحداث في قائمة انتظار خفيفة وتُعالَج
//   دفعةً واحدة كل 200ms داخل tick loop.
//   هذا يبقي الـ thread حراً لاستقبال أحداث جديدة دون انقطاع.
// ==========================================
const marathonQueues = {}; // { roomId: { likes: [], chats: [], shares: [], gifts: [] } }

function getMarathonQueue(roomId) {
    if (!marathonQueues[roomId]) {
        marathonQueues[roomId] = { likes: [], chats: [], shares: [], gifts: [] };
    }
    return marathonQueues[roomId];
}

const MARATHON_WORDS = [
    "مسرع", "متحمس", "بطل", "سباق", "نصر", "تحدي", "قوة", "سرعة", "ماراثون", "وقود",
    "فوز", "نجم", "اسطورة", "عزيمة", "طاقة", "حماس", "قمة", "كاسر", "شجاع", "ذكي"
];

// --- دوال الإضافة للقائمة (خفيفة جداً - O(1) فقط) ---
// هذه الدوال لا تعالج الأحداث — تضيفها فقط للقائمة لتُعالَج في الـ tick

function checkMarathonJoinPermission(state, data) {
    if (state.joinPermission !== 'followers') return true;
    const isFollower = data.followRole == 1 || data.followRole == 2 || (data.followInfo && (data.followInfo.followStatus == 1 || data.followInfo.followStatus == 2));
    return !!isFollower;
}

// تحويل رابط صورة التيك توك إلى proxy URL لتجاوز قيود CORS في المتصفح
function proxyAvatarUrl(url) {
    if (!url || url.includes('ui-avatars.com')) return url;
    return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

function handleMarathonChat(roomId, data) {
    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;
    // في مرحلة الانتظار (Lobby): معالجة فورية لأن الأحداث نادرة والتسجيل لا يتأخر
    if (!room.marathonState.isActive) {
        const state = room.marathonState;
        const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
        const comment = (data.comment || '').trim();
        const nickname = data.nickname || data.uniqueId;
        const avatar = data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}`;
        if (state.entryType === 'word') {
            const commentNorm = normalizeArabicForServer(comment);
            const entryNorm = normalizeArabicForServer(state.entryValue);
            if (commentNorm.includes(entryNorm) || comment.toLowerCase().includes(state.entryValue.toLowerCase())) {
                if (!checkMarathonJoinPermission(state, data)) return;
                joinMarathonPlayer(state, uniqueId, nickname, avatar);
            }
        }
        return;
    }
    // في مرحلة السباق: إضافة للقائمة فقط
    getMarathonQueue(roomId).chats.push({
        uniqueId: data.uniqueId ? data.uniqueId.toLowerCase() : '',
        comment: (data.comment || '').trim(),
        nickname: data.nickname || data.uniqueId,
        avatar: data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(data.nickname || data.uniqueId)}`
    });
}

function handleMarathonLike(roomId, data) {
    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;
    // في مرحلة الانتظار: معالجة فورية للتسجيل
    if (!room.marathonState.isActive) {
        const state = room.marathonState;
        if (state.entryType === 'likes' || state.entryType === 'all') {
            const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
            const nickname = data.nickname || data.uniqueId;
            const avatar = data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}`;
            if (!checkMarathonJoinPermission(state, data)) return;
            joinMarathonPlayer(state, uniqueId, nickname, avatar);
        }
        return;
    }
    // في مرحلة السباق: إضافة للقائمة فقط (عملية O(1) لا تعيق الـ event loop)
    getMarathonQueue(roomId).likes.push({
        uniqueId: data.uniqueId ? data.uniqueId.toLowerCase() : '',
        nickname: data.nickname || data.uniqueId,
        avatar: data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(data.nickname || data.uniqueId)}`,
        likeCount: data.likeCount || 1,
        followRole: data.followRole,
        followInfo: data.followInfo
    });
}

function handleMarathonShare(roomId, data) {
    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;
    // في مرحلة الانتظار: معالجة فورية للتسجيل
    if (!room.marathonState.isActive) {
        const state = room.marathonState;
        if (state.entryType === 'all') {
            const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
            const nickname = data.nickname || data.uniqueId;
            const avatar = data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}`;
            if (!checkMarathonJoinPermission(state, data)) return;
            joinMarathonPlayer(state, uniqueId, nickname, avatar);
        }
        return;
    }
    // في مرحلة السباق: إضافة للقائمة فقط
    getMarathonQueue(roomId).shares.push({
        uniqueId: data.uniqueId ? data.uniqueId.toLowerCase() : '',
        nickname: data.nickname || data.uniqueId,
        avatar: data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(data.nickname || data.uniqueId)}`
    });
}

function handleMarathonGift(roomId, data) {
    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;

    // إلغاء تكرار الهدايا (Combo deduplication) باستخدام msgId
    const msgId = data.msgId;
    const state = room.marathonState;
    if (msgId) {
        if (!state.processedGifts) state.processedGifts = new Set();
        if (state.processedGifts.has(msgId)) return; // تكرار — تجاهل
        state.processedGifts.add(msgId);
        // تنظيف دوري للـ Set عند تجاوز 500 عنصر
        if (state.processedGifts.size > 500) {
            const iter = state.processedGifts.values();
            for (let i = 0; i < 100; i++) {
                const nextVal = iter.next().value;
                if (nextVal !== undefined) state.processedGifts.delete(nextVal);
            }
        }
    }

    // في مرحلة الانتظار: معالجة فورية للتسجيل
    if (!state.isActive) {
        if (state.entryType === 'gift') {
            const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
            const nickname = data.nickname || data.uniqueId;
            const avatar = data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}`;
            if (!checkMarathonJoinPermission(state, data)) return;
            joinMarathonPlayer(state, uniqueId, nickname, avatar);
        }
        return;
    }
    // في مرحلة السباق: إضافة للقائمة فقط
    getMarathonQueue(roomId).gifts.push({
        uniqueId: data.uniqueId ? data.uniqueId.toLowerCase() : '',
        nickname: data.nickname || data.uniqueId,
        avatar: data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(data.nickname || data.uniqueId)}`,
        giftName: data.giftName || ''
    });
}

// ==========================================
//   معالجة دفعية للأحداث المتراكمة في القائمة
//   تُستدعى مرة واحدة فقط في بداية كل tick (كل 200ms)
// ==========================================
function flushMarathonQueue(roomId, state) {
    const queue = marathonQueues[roomId];
    if (!queue) return;

    const now = Date.now();
    const milestones = [200, 400, 800, 1600];
    const pendingMilestones = []; // تجميع إشعارات الـ milestones لإرسالها دفعة واحدة بعد المعالجة

    // ── 1. معالجة أحداث اللايك دفعياً ──
    // المشكلة: تيك توك يُرسل اللايكات دفعات كبيرة متأخرة، فنوزعها على عدة ticks
    const likes = queue.likes;
    queue.likes = [];
    for (let i = 0; i < likes.length; i++) {
        const ev = likes[i];
        const player = state.players[ev.uniqueId];
        if (player) {
            player.likes += ev.likeCount;
            // لو الدفعة كبيرة جداً (>15)، نضع نصفها في carryLikes يُصرف تدريجياً
            // هذا يمنع ظاهرة burst-then-nothing الناتجة عن تأخر تيك توك
            const directLikes = ev.likeCount > 15 ? Math.ceil(ev.likeCount * 0.5) : ev.likeCount;
            const carryLikes  = ev.likeCount - directLikes;
            player.recentLikes += directLikes;
            if (carryLikes > 0) {
                player.carryLikes = (player.carryLikes || 0) + carryLikes;
            }
            player.lastActive = now;
            // فحص الـ milestone
            if (player.likes >= player.nextMilestone) {
                const idx = milestones.indexOf(player.nextMilestone);
                player.nextMilestone = milestones[idx + 1] || 999999;
                player.boostUntil = now + 6000;
                pendingMilestones.push({ playerName: ev.nickname, milestone: milestones[idx] || player.nextMilestone, duration: 6 });
            }
        } else if (state.entryType === 'likes' || state.entryType === 'all') {
            if (state.playerCount < state.maxPlayers) {
                if (checkMarathonJoinPermission(state, ev)) {
                    const newPlayer = joinMarathonPlayer(state, ev.uniqueId, ev.nickname, ev.avatar);
                    if (newPlayer) {
                        newPlayer.likes += ev.likeCount;
                        newPlayer.recentLikes += ev.likeCount;
                    }
                }
            }
        }
    }

    // ── 2. معالجة أحداث الشير دفعياً ──
    const shares = queue.shares;
    queue.shares = [];
    for (let i = 0; i < shares.length; i++) {
        const ev = shares[i];
        const player = state.players[ev.uniqueId];
        if (player) {
            player.shares = (player.shares || 0) + 1;
            player.lastActive = now;
            if (player.shares === 5 && !player.shareBoostUsed) {
                player.shareBoostUsed = true;
                player.boostUntil = now + 6000;
                pendingMilestones.push({ playerName: ev.nickname, milestone: '5 شير للبث', duration: 6, isShare: true });
            }
        }
    }

    // ── 3. معالجة أحداث الكومنت (تحدي الكلمة) دفعياً ──
    const chats = queue.chats;
    queue.chats = [];
    if (state.wordChallenge.active && state.wordChallenge.slots.length < 3) {
        const targetNorm = normalizeArabicForServer(state.wordChallenge.word);
        for (let i = 0; i < chats.length; i++) {
            const ev = chats[i];
            const player = state.players[ev.uniqueId];
            if (!player || player.isFrozen) continue;
            const commentNorm = normalizeArabicForServer(ev.comment);
            if (commentNorm !== targetNorm && ev.comment.toLowerCase() !== state.wordChallenge.word.toLowerCase()) continue;
            const alreadySolved = state.wordChallenge.slots.some(s => s.id === ev.uniqueId);
            if (alreadySolved || state.wordChallenge.slots.length >= 3) continue;
            const slotIndex = state.wordChallenge.slots.length;
            const boost = slotIndex === 0 ? 0.09 : slotIndex === 1 ? 0.06 : 0.035;
            state.wordChallenge.slots.push({ id: ev.uniqueId, name: ev.nickname, avatar: ev.avatar, boost });
            player.wordBoost = boost;
            player.comments++;
            if (state.wordChallenge.slots.length === 3) {
                state.wordChallenge.solvedAt = now;
                break; // اكتملت الفتحات — لا داعي لمعالجة باقي الكومنتات
            }
        }
    }

    // ── 4. معالجة الهدايا دفعياً ──
    const gifts = queue.gifts;
    queue.gifts = [];
    for (let i = 0; i < gifts.length; i++) {
        const ev = gifts[i];
        const player = state.players[ev.uniqueId];
        if (!player) continue;
        player.gifts = (player.gifts || 0) + 1;

        // بوست هدية التيك توك (كل 30 ثانية)
        if (ev.giftName.toLowerCase().includes('tiktok') && (now - (player.lastTiktokBoostTime || 0) >= 30000)) {
            player.lastTiktokBoostTime = now;
            player.tiktokBoostUntil = now + 6000;
            pendingMilestones.push({ playerName: ev.nickname, isTiktokBoost: true, boostDuration: 6 });
            console.log(`[Marathon TikTok Boost] Triggered for ${ev.nickname} (cooldown: 30s)`);
        }

        if (ev.giftName.toLowerCase().includes(state.smallGiftId.toLowerCase())) {
            const spillPos = (player.progress - 0.03 + 1) % 1;
            const spillId = 'oil_' + now + '_' + Math.floor(Math.random() * 1000);
            state.oilSpills.push({ id: spillId, progress: spillPos, expiresAt: now + 6000, spawnedBy: ev.nickname });
            player.disruptions = (player.disruptions || 0) + 1;
            console.log(`[Marathon Spill] Created by ${ev.nickname} at progress ${spillPos}`);
        } else if (ev.giftName.toLowerCase().includes(state.mediumGiftId.toLowerCase())) {
            const sorted = Object.values(state.players).sort((a, b) => {
                if (a.laps !== b.laps) return b.laps - a.laps;
                return b.progress - a.progress;
            });
            let candidates = sorted.filter(p => p.id !== ev.uniqueId && !p.isFrozen);
            if (candidates.length === 0) candidates = sorted.filter(p => p.id !== ev.uniqueId);
            const target = candidates[0] || sorted[0];
            if (target) {
                const rocketId = 'rocket_' + now + '_' + Math.floor(Math.random() * 1000);
                state.rockets.push({
                    id: rocketId,
                    progress: player.laps + player.progress,
                    targetId: target.id,
                    speed: 0.35,
                    spawnedBy: ev.nickname,
                    expires: false
                });
                player.disruptions = (player.disruptions || 0) + 1;
                console.log(`[Marathon Freeze] Fired by ${ev.nickname} targeting ${target.name}`);
            }
        }
    }

    // ── 5. إرسال إشعارات الـ milestones دفعة واحدة ──
    for (let i = 0; i < pendingMilestones.length; i++) {
        io.to(roomId).emit('marathon_milestone', pendingMilestones[i]);
    }
}

function joinMarathonPlayer(state, uniqueId, nickname, avatar) {
    if (state.players[uniqueId]) return state.players[uniqueId];
    
    if (!state.playerCount) state.playerCount = 0;
    if (state.playerCount >= state.maxPlayers) return null;

    const newPlayer = {
        id: uniqueId,
        name: nickname,
        avatar: avatar,
        progress: 0,
        laps: 0,
        speed: 0, // تبدأ السرعة من 0 ولا يتحرك اللاعب إلا بالتكبيس
        wordBoost: 0,
        likes: 0,
        nextMilestone: 200, // لتتبع علامة الإنجاز التالية بكفاءة
        comments: 0,
        gifts: 0,
        recentLikes: 0,
        carryLikes: 0, // لايكات الدفعات الكبيرة — تُصرف تدريجياً على عدة ticks
        isFrozen: false,
        freezeUntil: 0,
        reachedMilestones: [],
        boostUntil: 0,
        tiktokBoostUntil: 0,
        lastTiktokBoostTime: 0,
        shares: 0,
        shareBoostUsed: false,
        hitOilSpills: [], // تتبع بقع الزيت التي اصطدم بها لتجنب تكرار الإشعار
        lastActive: Date.now()
    };
    state.players[uniqueId] = newPlayer;
    state.playerCount++;
    
    // إرسال تحديث فوري للاعب المنضم في مرحلة اللوبي (مع فلترة البيانات وتقليص الحجم)
    const lobbyPlayers = Object.values(state.players).map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar
    }));
    io.to(state.roomId).emit('marathon_lobby_update', {
        players: lobbyPlayers
    });

    return newPlayer;
}

function normalizeArabicForServer(text) {
    if (!text) return '';
    if (typeof text !== 'string') text = String(text);
    return text.normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/[y|ي|ى]/g, 'ي')
        .replace(/[^\w\s\u0600-\u06FF]/gi, '')
        .trim();
}

// عداد للـ debug logging
let _debugLogCount = 0;

// استخراج كل الـ properties من object بما فيها prototype ones بشكل متداخل ودعم الـ getters في الـ ES6 classes
function deepExtractObject(obj, visited = new Set()) {
    if (!obj || typeof obj !== 'object') return obj;
    if (visited.has(obj)) return null;

    if (Array.isArray(obj)) {
        visited.add(obj);
        const res = obj.map(item => deepExtractObject(item, visited));
        visited.delete(obj);
        return res;
    }

    visited.add(obj);
    const result = {};
    let currentProto = obj;
    while (currentProto && currentProto !== Object.prototype) {
        const props = Object.getOwnPropertyNames(currentProto);
        for (const prop of props) {
            if (prop === 'constructor') continue;
            if (Object.prototype.hasOwnProperty.call(result, prop)) continue;
            try {
                const val = obj[prop];
                if (typeof val !== 'function') {
                    result[prop] = deepExtractObject(val, visited);
                }
            } catch(e) {
                // تجاهل الخصائص التي تسبب خطأ عند الوصول إليها
            }
        }
        currentProto = Object.getPrototypeOf(currentProto);
    }
    visited.delete(obj);
    return result;
}


// استخراج URL الصورة من أي شكل ممكن
function extractAvatarUrl(avatarField) {
    if (!avatarField) return null;
    if (typeof avatarField === 'string' && avatarField.startsWith('http')) return avatarField;
    if (typeof avatarField === 'object') {
        // v2.x protobuf: Image.url is an Array of strings (e.g. ["https://...100x100.webp", "https://...jpeg"])
        if (Array.isArray(avatarField.url) && avatarField.url.length > 0) return avatarField.url[0];
        // Legacy formats
        const urls = avatarField.urlList || avatarField.url_list || avatarField.urls;
        if (Array.isArray(urls) && urls.length > 0) return urls[0];
        if (typeof avatarField.url === 'string' && avatarField.url.startsWith('http')) return avatarField.url;
    }
    return null;
}

function flattenTikTokData(data, availableGifts) {
    if (!data) return data;

    // DEBUG: طباعة هيكل البيانات الأول 5 مرات لمعرفة الشكل الحقيقي
    if (_debugLogCount < 5) {
        _debugLogCount++;
        try {
            console.log(`[DEBUG flattenTikTokData #${_debugLogCount}] uniqueId=${data.uniqueId}, nickname=${data.nickname}`);
            if (data.user) {
                const pp = data.user.profilePicture;
                console.log(`[DEBUG] data.user.profilePicture type=${typeof pp}, isArray(url)=${pp && Array.isArray(pp.url)}, url[0]=${pp?.url?.[0]?.substring(0,80)}...`);
            }
        } catch(e) { console.log('[DEBUG] could not print debug info:', e.message); }
    }

    // تسطيح البيانات باستخدام deepExtractObject لالتقاط prototype properties أيضاً
    const plainData = deepExtractObject(data) || {};

    // استخراج معلومات المستخدم من الكائن الأصلي مباشرة أولاً، ثم كفالباك من الكائن المفرود
    const rawUser = data.user || data.sender || data.userDetails || data.author || 
                    plainData.user || plainData.sender || plainData.userDetails || plainData.author || {};
    const userObj = rawUser;

    // استخلاص الحقول الأساسية
    const uniqueId = data.uniqueId || plainData.uniqueId || userObj.uniqueId || '';
    const nickname = data.nickname || plainData.nickname || userObj.nickname || uniqueId || 'مستخدم';
    
    let followRole = data.followRole !== undefined ? data.followRole : (plainData.followRole !== undefined ? plainData.followRole : userObj.followRole);
    let followInfo = data.followInfo || plainData.followInfo || userObj.followInfo;

    // استخراج صورة الملف الشخصي من كل الأماكن الممكنة
    let profilePictureUrl = data.profilePictureUrl || plainData.profilePictureUrl || userObj.profilePictureUrl || null;

    if (!profilePictureUrl) {
        // فحص مباشر وصريح داخل كائنات التيك توك الرسمية المتداخلة
        const rawUserPic = data.user?.profilePicture || data.sender?.profilePicture || 
                           data.user?.avatar || data.sender?.avatar ||
                           plainData.user?.profilePicture || plainData.sender?.profilePicture;
        
        profilePictureUrl = extractAvatarUrl(rawUserPic);
    }

    if (!profilePictureUrl) {
        // البحث في كائن المستخدم بناء على حقول اللوج الحقيقية
        profilePictureUrl =
            extractAvatarUrl(userObj.profilePicture) ||
            extractAvatarUrl(userObj.profilePictureMedium) ||
            extractAvatarUrl(userObj.profilePictureLarge) ||
            extractAvatarUrl(userObj.profilePic) ||
            extractAvatarUrl(userObj.avatar) ||
            extractAvatarUrl(userObj.avatarThumb) ||
            extractAvatarUrl(userObj.avatar_thumb) ||
            extractAvatarUrl(userObj.avatarMedium) ||
            extractAvatarUrl(userObj.avatar_medium) ||
            extractAvatarUrl(userObj.avatarLarge) ||
            extractAvatarUrl(userObj.avatar_large) ||
            extractAvatarUrl(userObj.avatarUrl);
    }

    if (!profilePictureUrl) {
        // البحث في الكائن الرئيسي (الأصلي والمفرود)
        profilePictureUrl =
            extractAvatarUrl(data.profilePicture) ||
            extractAvatarUrl(plainData.profilePicture) ||
            extractAvatarUrl(data.profilePic) ||
            extractAvatarUrl(plainData.profilePic) ||
            extractAvatarUrl(data.avatar) ||
            extractAvatarUrl(plainData.avatar) ||
            extractAvatarUrl(data.avatarUrl) ||
            extractAvatarUrl(plainData.avatarUrl) ||
            extractAvatarUrl(data.picture) ||
            extractAvatarUrl(plainData.picture) ||
            extractAvatarUrl(data.avatarThumb) ||
            extractAvatarUrl(plainData.avatarThumb) ||
            extractAvatarUrl(data.avatar_thumb) ||
            extractAvatarUrl(plainData.avatar_thumb) ||
            extractAvatarUrl(data.avatarMedium) ||
            extractAvatarUrl(plainData.avatarMedium);
    }

    // استخراج بيانات الهدية الممكنة لتجنب الاختلافات في البنية
    let giftId = data.giftId || plainData.giftId || null;
    let giftName = data.giftName || plainData.giftName || null;
    let repeatCount = data.repeatCount || plainData.repeatCount || 1;
    let repeatEnd = data.repeatEnd !== undefined ? data.repeatEnd : plainData.repeatEnd;
    let msgId = data.msgId || plainData.msgId || null;

    const rawGift = data.gift || plainData.gift;
    if (rawGift && typeof rawGift === 'object') {
        if (!giftId) giftId = rawGift.giftId || rawGift.gift_id || rawGift.id;
        if (!giftName) giftName = rawGift.giftName || rawGift.gift_name || rawGift.name;
        if (rawGift.repeatCount !== undefined) repeatCount = rawGift.repeatCount;
        if (rawGift.repeatEnd !== undefined) repeatEnd = rawGift.repeatEnd;
    }

    // توحيد المعرفات الكبيرة (Long objects) إلى نصوص عادية لمنع مشاكل النقل والمطابقة
    if (giftId) giftId = ensureStringId(giftId);
    if (msgId) msgId = ensureStringId(msgId);

    // محاولة جلب اسم الهدية من القائمة المتاحة في السيرفر بناءً على المعرف الموحد
    if (!giftName && giftId && availableGifts && Array.isArray(availableGifts)) {
        const foundGift = availableGifts.find(x => x && x.id && ensureStringId(x.id) === giftId);
        if (foundGift) {
            giftName = foundGift.name || foundGift.describe;
        }
    }

    // خريطة احتياطية لأسماء الهدايا الشائعة في حال عدم جلب البيانات الكاملة من التيك توك (تجنباً لقيم null)
    if (!giftName && giftId) {
        const giftIdStr = String(giftId);
        const commonGifts = {
            // هدايا الألعاب (Marathon & Rocket War) الأساسية
            '5655': 'Rose',
            '5820': 'TikTok',
            '5269': 'Finger Heart',
            '5585': 'Ice Cream',
            '6059': 'Doughnut',
            '5487': 'Paper Crane',
            '5844': 'Crown',
            '5617': 'Cap',
            '5765': 'Hearts',
            '6093': 'Diamond',
            '6427': 'Gamepad',
            '5660': 'Lollipop',
            '6064': 'GG',
            '5355': 'Chili',
            '7934': 'Rocket'
        };
        if (commonGifts[giftIdStr]) {
            giftName = commonGifts[giftIdStr];
        }
    }

    // بناء الكائن النهائي المفرود مع الحفاظ على باقي الخصائص الأصلية
    const result = {
        ...plainData,
        uniqueId: uniqueId,
        nickname: nickname,
        followRole: followRole,
        followInfo: followInfo,
        profilePictureUrl: profilePictureUrl
            ? proxyAvatarUrl(profilePictureUrl)
            : `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}&background=random&color=fff&bold=true`,
        giftId: giftId,
        giftName: giftName,
        repeatCount: repeatCount,
        repeatEnd: repeatEnd,
        msgId: msgId
    };

    // توحيد معرفات المستخدم إلى نصوص
    if (result.userId) result.userId = ensureStringId(result.userId);
    if (result.user && result.user.userId) result.user.userId = ensureStringId(result.user.userId);
    if (result.sender && result.sender.userId) result.sender.userId = ensureStringId(result.sender.userId);
    if (result.createTime) result.createTime = ensureStringId(result.createTime);

    // نقل الخصائص الأخرى من الكائن الأصلي التي قد لا تكون مفرودة بشرط ألا تمسح الحقول الأساسية المستخرجة بنجاح
    const protectedKeys = ['profilePictureUrl', 'uniqueId', 'nickname', 'followRole', 'followInfo', 'giftId', 'giftName', 'repeatCount', 'repeatEnd', 'msgId'];
    for (const key of Object.keys(data)) {
        if (!protectedKeys.includes(key) && !(key in result) && typeof data[key] !== 'function') {
            result[key] = data[key];
        }
    }

    return result;
}

function startMarathonLoop(roomId, socket) {
    if (marathonLoops[roomId]) {
        clearInterval(marathonLoops[roomId]);
    }

    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;
    const state = room.marathonState;
    state.startTime = Date.now();
    state.isActive = true;
    state.lastWordSpawn = Date.now();

    const TICK_MS = 200; // تحديث كل 200 مللي ثانية (5 مرات بالثانية) بدلاً من ثانية كاملة لسرعة الاستجابة
    const dt = TICK_MS / 1000.0; // 0.2 ثانية

    // تنظيف أي queue سابقة قبل بدء الـ tick loop
    if (!marathonQueues[roomId]) marathonQueues[roomId] = { likes: [], chats: [], shares: [], gifts: [] };
    else { marathonQueues[roomId].likes = []; marathonQueues[roomId].chats = []; marathonQueues[roomId].shares = []; marathonQueues[roomId].gifts = []; }

    const interval = setInterval(() => {
        const currentRoom = Object.values(roomsData).find(r => r === room);
        if (!currentRoom || !currentRoom.marathonState || !currentRoom.marathonState.isActive) {
            clearInterval(interval);
            const activeKey = Object.keys(marathonLoops).find(k => marathonLoops[k] === interval);
            if (activeKey) delete marathonLoops[activeKey];
            return;
        }

        const mState = currentRoom.marathonState;
        const elapsed = Math.floor((Date.now() - mState.startTime) / 1000);
        const timeLeft = Math.max(0, mState.duration - elapsed);

        if (timeLeft <= 0) {
            mState.isActive = false;
            clearInterval(interval);
            delete marathonLoops[roomId];

            const playersArr = Object.values(mState.players);
            
            const sortedByDistance = [...playersArr].sort((a, b) => {
                if (a.laps !== b.laps) return b.laps - a.laps;
                return b.progress - a.progress;
            });
            const champion = sortedByDistance[0] || null;

            const sortedByDisruptions = [...playersArr].sort((a, b) => (b.disruptions || 0) - (a.disruptions || 0));
            const tank = sortedByDisruptions[0] && (sortedByDisruptions[0].disruptions || 0) > 0 ? sortedByDisruptions[0] : null;

            const sortedByEngagement = [...playersArr].sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments));
            const goldenRunner = sortedByEngagement[0] && (sortedByEngagement[0].likes + sortedByEngagement[0].comments > 0) ? sortedByEngagement[0] : null;

            const finalPlayers = playersArr.map(p => ({
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                progress: p.progress,
                laps: p.laps,
                isFrozen: p.isFrozen,
                isBoosted: p.isBoosted || (Date.now() < p.boostUntil) || (Date.now() < p.tiktokBoostUntil),
                wordBoost: p.wordBoost,
                speed: p.speed
            }));

            io.to('tiktok_' + room.tiktokUser).emit('marathon_tick', {
                players: finalPlayers,
                oilSpills: mState.oilSpills,
                rockets: mState.rockets,
                wordChallenge: mState.wordChallenge,
                timeLeft: 0,
                status: "finished",
                winners: {
                    champion: champion ? { name: champion.name, avatar: champion.avatar, laps: champion.laps } : null,
                    tank: tank ? { name: tank.name, avatar: tank.avatar, score: tank.disruptions || 0 } : null,
                    goldenRunner: goldenRunner ? { name: goldenRunner.name, avatar: goldenRunner.avatar, score: goldenRunner.likes + goldenRunner.comments } : null
                }
            });
            return;
        }

        const now = Date.now();

        // 1. تحديث بقع الزيت
        mState.oilSpills = mState.oilSpills.filter(spill => now < spill.expiresAt);

        // 1.5 معالجة الأحداث المتراكمة في القائمة (like/share/chat/gift) — دفعة واحدة لكل tick
        flushMarathonQueue(roomId, mState);

        // 2. تحديث اللاعبين وحركاتهم
        Object.values(mState.players).forEach(p => {
            // ── حالة التجميد ──
            if (p.isFrozen) {
                if (now >= p.freezeUntil) {
                    p.isFrozen = false;
                    // لا نصفّر recentLikes عند انتهاء التجميد — اللايكات المتراكمة أثناء التجميد تخدم اللاعب فور انتهائه
                } else {
                    p.speed = 0;
                    p.wordBoost = 0;
                    // لا نمسح recentLikes! يكتسب اللاعب جاهزية للانطلاق فور انتهاء التجميد
                    return;
                }
            }

            // ── معادلة السرعة ──
            let speed = p.speed || 0;

            // تباطؤ تدريجي للسرعة (0.975 كل 200ms) - احتكاك لطيف بدلاً من الانهيار السريع
            speed *= 0.975;

            // ── صرف carryLikes تدريجياً (لايكات الدفعات الكبيرة المؤجلة) ──
            if (p.carryLikes > 0) {
                // نصرف 65% من carryLikes كل tick لضمان توزيع سلس
                const drip = Math.ceil(p.carryLikes * 0.65);
                p.recentLikes += drip;
                p.carryLikes = Math.floor(p.carryLikes * 0.35);
                if (p.carryLikes < 1) p.carryLikes = 0;
            }

            // ── قوة التكبيسات (recentLikes) ──
            if (p.recentLikes > 0) {
                const startBoost = speed < 0.003 ? 0.012 : 0; // دفعة بداية أقوى عند السكون
                const likesBoost = Math.min(0.035, p.recentLikes * 0.006);
                speed += likesBoost + startBoost;
                p.recentLikes = Math.floor(p.recentLikes * 0.7);
            }

            // ── حد أقصى للتكبيس (مُرفوع ليتناسب مع السقف الجديد) ──
            if (speed > 0.038) speed = 0.038;

            // إذا أصبحت السرعة متناهية الصغر يتم إيقاف المتسابق تماماً
            if (speed < 0.0001) speed = 0;

            // ── دفعة تحدي الكلمة ──
            if (p.wordBoost > 0) {
                speed += p.wordBoost;
                p.wordBoost *= 0.917;
                if (p.wordBoost < 0.0008) p.wordBoost = 0;
            }

            // ── فحص بقعة الزيت (تأثير مؤقت لثانيتين بنسبة ثابتة دون تراكم هندسي) ──
            for (let si = 0; si < mState.oilSpills.length; si++) {
                const spill = mState.oilSpills[si];
                const diff = Math.abs((p.progress % 1) - spill.progress);
                const circularDiff = Math.min(diff, 1 - diff);
                if (circularDiff < 0.025) {
                    if (!p.hitOilSpills || p.hitOilSpills instanceof Array) {
                        p.hitOilSpills = new Set(Array.isArray(p.hitOilSpills) ? p.hitOilSpills : []);
                    }
                    if (!p.hitOilSpills.has(spill.id)) {
                        p.hitOilSpills.add(spill.id);
                        p.oilSlowdownUntil = now + 2000; // تباطؤ لثانيتين
                        io.to(roomId).emit('marathon_disruption', {
                            type: 'oil',
                            attacker: spill.spawnedBy,
                            victim: p.name
                        });
                    }
                }
            }

            // ── مضاعفات السرعة ──
            p.isTiktokBoosted = now < (p.tiktokBoostUntil || 0);
            p.isBoosted = now < p.boostUntil;
            if (p.isTiktokBoosted) {
                if (speed < 0.020) speed = 0.020;
                speed *= 4.5;
            } else if (p.isBoosted) {
                if (speed < 0.008) speed = 0.008; // سرعة بدء تشغيل دنيا للمسرعين حتى لا يضربوا في صفر
                speed *= 3.5;
            }

            // تطبيق تأثير تباطؤ الزيت المؤقت في نهاية الحساب
            const hasOilSlowdown = p.oilSlowdownUntil && now < p.oilSlowdownUntil;
            if (hasOilSlowdown) {
                speed *= 0.1; // تباطؤ بنسبة 90%
            }

            p.speed = speed;
            p.progress += speed * dt;
            if (p.progress >= 1) {
                p.laps += Math.floor(p.progress);
                p.progress = p.progress % 1;
            }
        });

        // 3. تحديث الصواريخ
        mState.rockets.forEach(rocket => {
            const targetPlayer = mState.players[rocket.targetId];
            if (!targetPlayer) {
                rocket.expires = true;
                return;
            }
            const targetTotalProgress = targetPlayer.laps + targetPlayer.progress;
            const diff = targetTotalProgress - rocket.progress;
            if (diff <= 0) {
                rocket.expires = true;
                // منع تجميد اللاعب مجدداً أو إرسال إشعار مكرر إذا كان متجمداً بالفعل
                if (!targetPlayer.isFrozen) {
                    targetPlayer.isFrozen = true;
                    targetPlayer.freezeUntil = now + 4000;
                    io.to(roomId).emit('marathon_disruption', {
                        type: 'rocket',
                        attacker: rocket.spawnedBy,
                        victim: targetPlayer.name
                    });
                }
            } else {
                rocket.progress += rocket.speed * dt; // زيادة مسافة الصاروخ حسب dt
                if (rocket.progress >= targetTotalProgress || Math.abs(rocket.progress - targetTotalProgress) < 0.02) {
                    rocket.expires = true;
                    if (!targetPlayer.isFrozen) {
                        targetPlayer.isFrozen = true;
                        targetPlayer.freezeUntil = now + 4000; // تجميد 4 ثوانٍ
                        io.to(roomId).emit('marathon_disruption', {
                            type: 'rocket',
                            attacker: rocket.spawnedBy,
                            victim: targetPlayer.name
                        });
                    }
                }
            }
        });
        mState.rockets = mState.rockets.filter(r => !r.expires);

        // 4. تحديث تحدي الكلمات
        if (!mState.wordChallenge.active) {
            if (now - mState.lastWordSpawn > 25000) { // ظهور كلمة جديدة كل 25 ثانية
                const randomWord = MARATHON_WORDS[Math.floor(Math.random() * MARATHON_WORDS.length)];
                mState.wordChallenge = {
                    word: randomWord,
                    slots: [],
                    active: true,
                    spawnedAt: now,
                    solvedAt: 0
                };
                mState.lastWordSpawn = now;
            }
        } else {
            if (mState.wordChallenge.solvedAt > 0) {
                if (now - mState.wordChallenge.solvedAt > 5000) { // تختفي بعد 5 ثوانٍ من حلها
                    mState.wordChallenge = { word: "", slots: [], active: false, spawnedAt: 0, solvedAt: 0 };
                    mState.lastWordSpawn = now;
                }
            } else {
                if (now - mState.wordChallenge.spawnedAt > 15000) { // تختفي بعد 15 ثانية إن لم تُحل
                    mState.wordChallenge = { word: "", slots: [], active: false, spawnedAt: 0, solvedAt: 0 };
                    mState.lastWordSpawn = now;
                }
            }
        }

        io.to('tiktok_' + room.tiktokUser).emit('marathon_tick', {
            players: Object.values(mState.players).map(p => ({
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                progress: p.progress,
                laps: p.laps,
                isFrozen: p.isFrozen,
                isBoosted: p.isBoosted || (Date.now() < p.boostUntil) || (Date.now() < p.tiktokBoostUntil),
                wordBoost: p.wordBoost,
                speed: p.speed
            })),
            oilSpills: mState.oilSpills,
            rockets: mState.rockets.map(r => ({
                id: r.id,
                progress: r.progress % 1,
                targetId: r.targetId
            })),
            wordChallenge: mState.wordChallenge,
            timeLeft: timeLeft,
            status: "active"
        });

    }, TICK_MS);

}


io.on('connection', (socket) => {

    socket.on('adminLogin', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            socket.join('admin_room');
            broadcastDashboardUpdate();
        }
    });

    // إعداد فلتر مخصص من العميل لحماية السيرفر (Dynamic Filter) - مسجل مرة واحدة فقط لكل سوكت
    socket.on('set_tiktok_filter', (filterOptions) => {
        if (roomsData[socket.id]) {
            roomsData[socket.id].chatFilter = filterOptions;
        }
    });

    // --- استقبال أحداث لعبة الماراثون الجماعي ---
    socket.on('marathon_setup', (configOptions) => {
        if (roomsData[socket.id]) {
            roomsData[socket.id].gameState = { gameType: 'tiktok_marathon' };
            roomsData[socket.id].marathonState = {
                roomId: socket.id,
                players: {},
                playerCount: 0, // عدّاد اللاعبين النشطين كاش في الذاكرة
                wordChallenge: { word: "", slots: [], active: false, spawnedAt: 0, solvedAt: 0 },
                oilSpills: [],
                rockets: [],
                startTime: 0,
                duration: configOptions.duration || 180,
                maxPlayers: configOptions.maxPlayers || 100,
                isActive: false,
                smallGiftId: configOptions.smallGiftId || 'Heart',
                mediumGiftId: configOptions.mediumGiftId || 'Crown',
                entryType: configOptions.entryType || 'likes',
                entryValue: configOptions.entryValue || '',
                lastWordSpawn: 0,
                joinPermission: configOptions.joinPermission || 'all'
            };
            console.log(`[Marathon Setup] Completed for room ${socket.id}`);
            socket.emit('marathon_setup_success');
        }
    });

    socket.on('marathon_start', () => {
        if (roomsData[socket.id] && roomsData[socket.id].marathonState) {
            console.log(`[Marathon Start] Starting loop for room ${socket.id}`);
            startMarathonLoop(socket.id, socket);
        }
    });

    socket.on('marathon_reset', () => {
        const roomId = socket.id;
        if (marathonLoops[roomId]) {
            clearInterval(marathonLoops[roomId]);
            delete marathonLoops[roomId];
        }
        // تنظيف queue الأحداث المتراكمة عند الإعادة
        delete marathonQueues[roomId];
        if (roomsData[roomId] && roomsData[roomId].marathonState) {
            const state = roomsData[roomId].marathonState;
            state.isActive = false;
            state.players = {};
            state.playerCount = 0;
            state.oilSpills = [];
            state.rockets = [];
            state.wordChallenge = { word: "", slots: [], active: false, spawnedAt: 0, solvedAt: 0 };
            console.log(`[Marathon Reset] Race state cleared for room ${roomId}`);
            socket.emit('marathon_reset_success');
        }
    });

    socket.on('marathon_kick_player', (data) => {
        const roomId = socket.id;
        const targetId = data.playerId;
        if (roomsData[roomId] && roomsData[roomId].marathonState) {
            const state = roomsData[roomId].marathonState;
            if (state.players[targetId]) {
                delete state.players[targetId];
                if (state.playerCount) state.playerCount--;
                console.log(`[Marathon Kick] Kicked player ${targetId} from room ${roomId}`);
                
                const lobbyPlayers = Object.values(state.players).map(p => ({
                    id: p.id,
                    name: p.name,
                    avatar: p.avatar
                }));
                io.to(roomId).emit('marathon_lobby_update', {
                    players: lobbyPlayers
                });
            }
        }
    });

// دوال مساعدة لتحديد نوع اللعبة من الرابط أو المعرف لتسهيل إعادة التهيئة عند الانتقال بين الألعاب
function getGameTypeFromReferer(referer) {
    if (!referer) return 'غير معروف';
    const lower = referer.toLowerCase();
    if (lower.includes('marathon.html')) return 'tiktok_marathon';
    if (lower.includes('tiktok-russian-roulette.html')) return 'tiktok_russian_roulette';
    if (lower.includes('tiktok-roulette.html')) return 'tiktok_roulette';
    if (lower.includes('tiktok-bomb.html')) return 'tiktok_bomb';
    if (lower.includes('tiktok-missiles.html') || lower.includes('missiles.html') || lower.includes('rockets.html')) return 'tiktok_rockets';
    if (lower.includes('kharabisha.html')) return 'kharabisha';
    if (lower.includes('numble.html')) return 'numble';
    if (lower.includes('hexagon-maze.html')) return 'hexagon-maze';
    if (lower.includes('salata.html')) return 'salata';
    if (lower.includes('tiktok-sniper.html')) return 'tiktok_sniper';
    if (lower.includes('trivia-survival.html')) return 'trivia_survival';
    if (lower.includes('zehniat.html')) return 'zehniat';
    
    // محاولة استخراج اسم الملف تلقائياً لتجنب الرجوع للقنبلة كخيار افتراضي خاطئ
    const match = referer.match(/\/([^\/]+)\.html/i);
    if (match && match[1]) {
        return match[1];
    }
    
    return 'غير معروف';
}

function getGameTypeFromId(gameId) {
    if (!gameId) return 'غير معروف';
    const id = gameId.toLowerCase();
    if (id === 'marathon' || id === 'tiktok_marathon') return 'tiktok_marathon';
    if (id === 'tiktok-russian-roulette' || id === 'tiktok_russian_roulette') return 'tiktok_russian_roulette';
    if (id === 'tiktok-roulette' || id === 'tiktok_roulette') return 'tiktok_roulette';
    if (id === 'tiktok-bomb' || id === 'tiktok_bomb') return 'tiktok_bomb';
    if (id === 'rockets' || id === 'tiktok_rockets' || id === 'tiktok-missiles' || id === 'tiktok-rockets') return 'tiktok_rockets';
    if (id === 'kharabisha') return 'kharabisha';
    if (id === 'numble') return 'numble';
    if (id === 'hexagon-maze') return 'hexagon-maze';
    if (id === 'salata' || id === 'tiktok_salata') return 'salata';
    if (id === 'sniper' || id === 'tiktok_sniper') return 'tiktok_sniper';
    if (id === 'trivia-survival' || id === 'trivia_survival' || id === 'tiktok-trivia-survival') return 'trivia_survival';
    if (id === 'zehniat') return 'zehniat';
    return id;
}

    // --- منطق ألعاب تيك توك اللحظية ---
    socket.on('tiktok_connect', (data) => {
        // التحقق الأمني: يجب أن يكون السوكت مصدقاً كـ Host من نوع tiktok
        if (!socket.decodedToken || socket.decodedToken.type !== 'tiktok') {
            console.warn(`[Security Violation] tiktok_connect rejected for socket ${socket.id} - Not authorized`);
            socket.emit('tiktok_error', { message: 'غير مصرح لك بالاتصال. كود تفعيل غير صالح أو منتهي.' });
            return;
        }

        const username = data.username ? data.username.trim().toLowerCase() : null;
        if (!username) return;

        // تحديد اللعبة المستهدفة عند الربط
        const targetGameType = getGameTypeFromId(data.gameId || getGameTypeFromReferer(socket.handshake.headers.referer));
        console.log(`[TikTok Connect] Host @${username} wants game type: ${targetGameType}`);

        // join socket.io room for this tiktok username
        const roomName = 'tiktok_' + username;
        socket.join(roomName);

        // Check if there is an existing room for this user, and if so, clean it up completely before starting fresh
        const existingRoomId = Object.keys(roomsData).find(rId => {
            const room = roomsData[rId];
            return room && room.tiktokUser && room.tiktokUser.trim().toLowerCase() === username;
        });

        if (existingRoomId) {
            const oldRoom = roomsData[existingRoomId];
            console.log(`[TikTok Reset] Found existing room for @${username} (Old socket: ${existingRoomId}, New: ${socket.id}). Deleting old room and starting fresh...`);
            
            // Clear any active disconnect cleanup timer and inactivity timer
            if (oldRoom.cleanupTimer) {
                clearTimeout(oldRoom.cleanupTimer);
            }
            if (oldRoom.timer) {
                clearTimeout(oldRoom.timer);
            }

            // Disconnect old TikTok connection
            if (oldRoom.tiktokConn) {
                try {
                    oldRoom.tiktokConn.disconnect();
                } catch (e) {
                    console.error(`[TikTok Reset] Error disconnecting old connection:`, e.message);
                }
            }
            if (oldRoom.twitchConn) {
                try { oldRoom.twitchConn.disconnect(); } catch (e) {}
            }
            if (oldRoom.kickConn) {
                try { oldRoom.kickConn.disconnect(); } catch (e) {}
            }

            // Clean up marathon loops/queues
            if (marathonLoops[existingRoomId]) {
                clearInterval(marathonLoops[existingRoomId]);
                delete marathonLoops[existingRoomId];
            }
            delete marathonQueues[existingRoomId];

            // Delete old room data
            delete roomsData[existingRoomId];
        }

        // كول داون 15 ثانية بين محاولات الربط لنفس الحساب (تيك توك فقط لمنع البلوك)
        const now = Date.now();
        const platform = socket.decodedToken.platform || 'tiktok';

        if (platform === 'tiktok') {
            const lastConnect = connectionCooldowns[username];
            if (lastConnect && (now - lastConnect) < 15000) {
                const secondsLeft = Math.ceil((15000 - (now - lastConnect)) / 1000);
                socket.emit('tiktok_error', { message: `الرجاء الانتظار ${secondsLeft} ثانية قبل محاولة الربط مجدداً.` });
                return;
            }
            connectionCooldowns[username] = now;
        }

        if (platform === 'twitch') {
            console.log(`محاولة الاتصال ببث تويتش: #${username}`);
            if (socket.twitchConn) {
                try { socket.twitchConn.disconnect(); } catch(e){}
            }

            const conn = connectTwitchChat(username,
                (chatData) => {
                    handleStreamChat(socket.id, roomName, chatData);
                },
                () => {
                    console.log(`✅ تم الاتصال بنجاح ببث تويتش: #${username}`);
                    const profilePic = 'https://ui-avatars.com/api/?name=' + username + '&background=6441a5&color=fff';
                    const nickname = username;

                    if (roomsData[socket.id]) {
                        roomsData[socket.id].twitchConn = conn;
                        roomsData[socket.id].profilePic = profilePic;
                        roomsData[socket.id].nickname = nickname;
                    } else {
                        roomsData[socket.id] = {
                            createdAt: Date.now(),
                            gameState: { gameType: targetGameType },
                            isTwitch: true,
                            twitchUser: username,
                            twitchConn: conn,
                            timer: null,
                            chatFilter: null,
                            profilePic: profilePic,
                            nickname: nickname,
                            hostSocketId: socket.id
                        };
                    }
                    resetRoomTimer(socket.id);
                    broadcastDashboardUpdate();
                    io.to(roomName).emit('tiktok_connected', { profilePic, nickname });
                },
                () => {
                    io.to(roomName).emit('tiktok_disconnected', 'تم قطع الاتصال ببث تويتش.');
                },
                (err) => {
                    socket.emit('tiktok_error', { message: err.message || 'فشل الاتصال بقناة تويتش.' });
                }
            );
            socket.twitchConn = conn;

        } else if (platform === 'kick') {
            console.log(`محاولة الاتصال ببث كيك: @${username}`);
            if (socket.kickConn) {
                try { socket.kickConn.disconnect(); } catch(e){}
            }

            const conn = connectKickChat(username,
                (chatData) => {
                    handleStreamChat(socket.id, roomName, chatData);
                },
                () => {
                    console.log(`✅ تم الاتصال بنجاح ببث كيك: @${username}`);
                    const profilePic = 'https://ui-avatars.com/api/?name=' + username + '&background=53fc18&color=000';
                    const nickname = username;

                    if (roomsData[socket.id]) {
                        roomsData[socket.id].kickConn = conn;
                        roomsData[socket.id].profilePic = profilePic;
                        roomsData[socket.id].nickname = nickname;
                    } else {
                        roomsData[socket.id] = {
                            createdAt: Date.now(),
                            gameState: { gameType: targetGameType },
                            isKick: true,
                            kickUser: username,
                            kickConn: conn,
                            timer: null,
                            chatFilter: null,
                            profilePic: profilePic,
                            nickname: nickname,
                            hostSocketId: socket.id
                        };
                    }
                    resetRoomTimer(socket.id);
                    broadcastDashboardUpdate();
                    io.to(roomName).emit('tiktok_connected', { profilePic, nickname });
                },
                () => {
                    io.to(roomName).emit('tiktok_disconnected', 'تم قطع الاتصال ببث كيك.');
                },
                (err) => {
                    socket.emit('tiktok_error', { message: err.message || 'فشل الاتصال بقناة كيك.' });
                }
            );
            socket.kickConn = conn;

        } else {
            console.log(`محاولة الاتصال ببث تيك توك: @${username}`);

            const connectionOptions = {
                processInitialData: false,      // لا نعالج البيانات الأولية لتوفير الموارد
                enableExtendedGiftInfo: false,  // إيقاف لتحسين استهلاك البيانات (تعتمد على commonGifts)
                requestPollingIntervalMs: 2000, // تقليل فترة polling الاحتياطي إلى 2 ثانية
                signApiKey: process.env.TIKTOK_SIGN_API_KEY ? process.env.TIKTOK_SIGN_API_KEY.trim() : undefined
            };

            // إضافة إعدادات السيرفر المخصص فقط إذا تم تحديدها في البيئة (لتجنب فرض سيرفر قديم معطل)
            if (process.env.TIKTOK_SIGN_HOST) {
                connectionOptions.signProviderOptions = {
                    host: process.env.TIKTOK_SIGN_HOST.trim().replace(/\/+$/, ''),
                    params: process.env.TIKTOK_SIGN_API_KEY ? { apiKey: process.env.TIKTOK_SIGN_API_KEY.trim() } : {}
                };
            }

            // إذا كان هناك SESSIONID ممرر من البيئة (لتجنب حظر الـ IP) نقوم بإضافته
            if (process.env.TIKTOK_SESSION_ID && process.env.TIKTOK_SESSION_ID !== 'default') {
                connectionOptions.sessionId = process.env.TIKTOK_SESSION_ID.trim();
                if (process.env.TIKTOK_TARGET_IDC) {
                    connectionOptions.ttTargetIdc = process.env.TIKTOK_TARGET_IDC.trim();
                }
            }

            // دعم البروكسي لتخطي حظر الـ IP من خوادم Render
            const proxyUrl = process.env.TIKTOK_PROXY_URL;
            if (proxyUrl) {
                console.log(`[Proxy] توجيه اتصال التيك توك عبر البروكسي: ${proxyUrl.replace(/:[^:]*@/, ':****@')}`);
                try {
                    const { HttpsProxyAgent } = require('https-proxy-agent');
                    const agent = new HttpsProxyAgent(proxyUrl);
                    
                    connectionOptions.webClientOptions = {
                        httpsAgent: agent,
                        headers: { 'Accept-Encoding': 'gzip, deflate' }
                    };
                    connectionOptions.wsClientOptions = {
                        agent: agent,
                        headers: { 'Accept-Encoding': 'gzip, deflate' }
                    };
                    connectionOptions.requestOptions = {
                        httpsAgent: agent,
                        headers: { 'Accept-Encoding': 'gzip, deflate' }
                    };
                } catch (proxyErr) {
                    console.error(`❌ فشل تهيئة البروكسي:`, proxyErr.message);
                }
            }

            const startTikTokConnection = (attempt = 1, isReconnect = false) => {
                if (isReconnect) {
                    console.log(`[TikTok Reconnect] Attempt ${attempt} for @${username} (Socket: ${socket.id})`);
                    io.to(roomName).emit('tiktok_reconnecting', { attempt, maxAttempts: 5 });
                }

                let tiktokLiveConnection = new TikTokLiveConnection(username, connectionOptions);

                tiktokLiveConnection.connect().then(state => {
                    console.log(`✅ تم الاتصال بنجاح ببث: @${username} (RoomID: ${state.roomId}) (Reconnect: ${isReconnect})`);

                    const owner = state.roomInfo?.data?.owner || state.roomInfo?.owner;
                    const profilePic = owner?.avatar_large?.url_list?.[0] ||
                        owner?.avatar_medium?.url_list?.[0] ||
                        owner?.avatar_thumb?.url_list?.[0] ||
                        'https://ui-avatars.com/api/?name=' + username;
                    const nickname = owner?.nickname || username;

                    if (roomsData[socket.id]) {
                        roomsData[socket.id].tiktokConn = tiktokLiveConnection;
                        roomsData[socket.id].profilePic = profilePic;
                        roomsData[socket.id].nickname = nickname;
                        roomsData[socket.id].hostSocketId = socket.id; // تعيين معرف سوكت الهوست لتجنب التحذيرات الأمنية
                    } else {
                        roomsData[socket.id] = {
                            createdAt: Date.now(),
                            gameState: { gameType: targetGameType },
                            isTikTok: true,
                            tiktokUser: username,
                            tiktokConn: tiktokLiveConnection,
                            timer: null,
                            chatFilter: null,
                            profilePic: profilePic,
                            nickname: nickname,
                            hostSocketId: socket.id // تعيين معرف سوكت الهوست لتجنب التحذيرات الأمنية
                        };
                    }
                    resetRoomTimer(socket.id); // بدء عداد الحذف التلقائي (30 دقيقة)
                    broadcastDashboardUpdate();
                    
                    io.to(roomName).emit('tiktok_connected', { profilePic, nickname });

                    // تمرير أحداث تيك توك للعميل عبر الغرفة
                    tiktokLiveConnection.on('chat', data => {
                        data = flattenTikTokData(data, tiktokLiveConnection.availableGifts);
                        const currentRoomId = Object.keys(roomsData).find(rId => roomsData[rId] && roomsData[rId].tiktokConn === tiktokLiveConnection);
                        if (!currentRoomId) return;
                        handleStreamChat(currentRoomId, roomName, data);
                    });

                    tiktokLiveConnection.on('gift', data => {
                        data = flattenTikTokData(data, tiktokLiveConnection.availableGifts);
                        const currentRoomId = Object.keys(roomsData).find(rId => roomsData[rId] && roomsData[rId].tiktokConn === tiktokLiveConnection);
                        if (!currentRoomId) return;
                        const room = roomsData[currentRoomId];
                        if (room && room.gameState && room.gameState.gameType === 'tiktok_marathon') {
                            handleMarathonGift(currentRoomId, data);
                            return;
                        }
                        io.to(roomName).emit('tiktok_gift', data);
                    });

                    tiktokLiveConnection.on('like', data => {
                        data = flattenTikTokData(data, tiktokLiveConnection.availableGifts);
                        const currentRoomId = Object.keys(roomsData).find(rId => roomsData[rId] && roomsData[rId].tiktokConn === tiktokLiveConnection);
                        if (!currentRoomId) return;
                        const room = roomsData[currentRoomId];
                        if (room && room.gameState && room.gameState.gameType === 'tiktok_marathon') {
                            handleMarathonLike(currentRoomId, data);
                            return;
                        }
                        io.to(roomName).emit('tiktok_like', data);
                    });

                    tiktokLiveConnection.on('share', data => {
                        data = flattenTikTokData(data, tiktokLiveConnection.availableGifts);
                        const currentRoomId = Object.keys(roomsData).find(rId => roomsData[rId] && roomsData[rId].tiktokConn === tiktokLiveConnection);
                        if (!currentRoomId) return;
                        const room = roomsData[currentRoomId];
                        if (room && room.gameState && room.gameState.gameType === 'tiktok_marathon') {
                            handleMarathonShare(currentRoomId, data);
                            return;
                        }
                        io.to(roomName).emit('tiktok_share', data);
                    });

                    tiktokLiveConnection.on('streamEnd', (actionId) => {
                        console.log(`[TikTok StreamEnd] Stream ended for @${username}`);
                        io.to(roomName).emit('tiktok_disconnected', 'تم إنهاء البث المباشر.');
                        const currentRoomId = Object.keys(roomsData).find(rId => roomsData[rId] && roomsData[rId].tiktokConn === tiktokLiveConnection);
                        if (currentRoomId && roomsData[currentRoomId]) {
                            if (roomsData[currentRoomId].tiktokConn) {
                                try { roomsData[currentRoomId].tiktokConn.disconnect(); } catch(e){}
                            }
                            if (roomsData[currentRoomId].timer) clearTimeout(roomsData[currentRoomId].timer);
                            delete roomsData[currentRoomId];
                            broadcastDashboardUpdate();
                        }
                    });

                    tiktokLiveConnection.on('disconnected', () => {
                        console.log(`[TikTok Disconnected] Connection dropped for @${username}. Initiating reconnect...`);
                        const currentRoomId = Object.keys(roomsData).find(rId => roomsData[rId] && roomsData[rId].tiktokConn === tiktokLiveConnection);
                        if (currentRoomId && roomsData[currentRoomId] && roomsData[currentRoomId].tiktokConn) {
                            try { roomsData[currentRoomId].tiktokConn.disconnect(); } catch(e){}
                        }
                        if (socket.connected && currentRoomId && roomsData[currentRoomId]) {
                            setTimeout(() => {
                                startTikTokConnection(1, true);
                            }, 5000);
                        }
                    });

                    tiktokLiveConnection.on('error', (err) => {
                        console.error(`[TikTok Error] @${username}:`, err.message || err);
                    });

                    socket.tiktokConn = tiktokLiveConnection;

                }).catch(err => {
                    console.log(`❌ فشل الاتصال ببث @${username} (محاولة ${attempt}):`, err.message);
                    
                    const maxAttempts = isReconnect ? 5 : 4;
                    const currentRoomId = Object.keys(roomsData).find(rId => roomsData[rId].tiktokUser === username);
                    const canRetry = attempt < maxAttempts && socket.connected && (isReconnect ? !!currentRoomId : true);

                    if (canRetry) {
                        const delay = isReconnect ? 15000 : 5000;
                        setTimeout(() => {
                            startTikTokConnection(attempt + 1, isReconnect);
                        }, delay);
                    } else {
                        console.log(`❌ توقفت محاولات الاتصال ببث @${username}`);
                        io.to(roomName).emit('tiktok_disconnected', 'تعذر الاتصال بالبث المباشر بعد عدة محاولات.');
                        if (currentRoomId && roomsData[currentRoomId]) {
                            if (roomsData[currentRoomId].timer) clearTimeout(roomsData[currentRoomId].timer);
                            delete roomsData[currentRoomId];
                            broadcastDashboardUpdate();
                        }
                    }
                });
            };

            startTikTokConnection(1, false);
        }
    });



    // استلام طلب الإغلاق اليدوي من زر "الإغلاق" في صفحة اللعبة
    socket.on('tiktok_disconnect', () => {
        if (socket.tiktokConn) {
            socket.tiktokConn.disconnect();
            socket.tiktokConn = null;
        }
        if (marathonLoops[socket.id]) {
            clearInterval(marathonLoops[socket.id]);
            delete marathonLoops[socket.id];
        }
        if (roomsData[socket.id]) {
            clearTimeout(roomsData[socket.id].timer);
            delete roomsData[socket.id];
            broadcastDashboardUpdate();
            console.log(`تم مسح وإغلاق روم التيك توك يدوياً`);
        }
    });


    // --- منطق الألعاب العادية ---
    socket.on('createRoom', (roomId, gameType) => {
        const existingRoom = roomsData[roomId];
        const originalGameType = existingRoom && existingRoom.gameState ? (existingRoom.gameState.gameType || existingRoom.gameState.type) : null;
        const resolvedGameType = gameType || originalGameType;
        // التحقق الأمني: يسمح للألعاب المجانية بالمرور بدون توكن
        const isFreeGame = ['countries_war', 'fruit_war', 'flip_turn', 'memory', 'lucky_wheel'].includes(resolvedGameType);
        
        if (!isFreeGame) {
            if (!socket.decodedToken || (socket.decodedToken.type !== 'vip' && socket.decodedToken.type !== 'tiktok')) {
                console.warn(`[Security Violation] createRoom rejected for socket ${socket.id} - Not authorized`);
                socket.emit('auth_error', 'غير مصرح لك بإنشاء غرفة. يرجى تسجيل الدخول بكود تفعيل صالح.');
                return;
            }
        }

        const hostClient = socket.decodedToken ? socket.decodedToken.client : 'free_user';
        const currentDeviceId = socket.decodedToken ? socket.decodedToken.deviceId : 'free_device';

        // منع الجلسات المتزامنة: إغلاق أي غرف نشطة سابقة لنفس هذا الهوست
        for (const existingRoomId in roomsData) {
            const room = roomsData[existingRoomId];
            if (room && room.hostClient === hostClient && existingRoomId !== roomId) {
                console.log(`[Concurrent Session] Closing old room ${existingRoomId} for host ${hostClient}`);
                io.to(existingRoomId).emit('roomClosed', 'تم إغلاق الغرفة لفتحها من جهاز أو متصفح آخر.');
                // إجبار كل السوكتس في الغرفة على مغادرتها
                io.in(existingRoomId).socketsLeave(existingRoomId);
                // تنظيف اتصال تيك توك لو كان موجود
                if (room.tiktokConn) {
                    room.tiktokConn.disconnect();
                }
                if (marathonLoops[existingRoomId]) {
                    clearInterval(marathonLoops[existingRoomId]);
                    delete marathonLoops[existingRoomId];
                }
                clearTimeout(room.timer);
                delete roomsData[existingRoomId];
            }
        }

        socket.join(roomId);
        if (!existingRoom) {
            roomsData[roomId] = {
                createdAt: Date.now(),
                gameState: { gameType: resolvedGameType },
                timer: null,
                hostSocketId: socket.id, // تسجيل معرف سوكت الهوست للتحقق اللاحق
                hostClient: hostClient,
                deviceId: currentDeviceId
            };
        } else {
            // تحديث سوكت الهوست عند إعادة إنشاء نفس الغرفة (مثلاً بعد إعادة تحميل الصفحة أو إعادة الاتصال)
            // للتأكد من حماية الغرفة، نتحقق أن المنشئ الجديد هو نفس العميل أو نفس الجهاز
            const oldHostClient = existingRoom.hostClient;
            const oldDeviceId = existingRoom.deviceId;

            const isAuthorizedRecreate = isFreeGame || 
                !oldHostClient || 
                oldHostClient === 'free_user' || 
                oldHostClient === hostClient || 
                (oldDeviceId && oldDeviceId === currentDeviceId);

            if (isAuthorizedRecreate) {
                console.log(`[Room Re-created] Updating hostSocketId for room ${roomId} to new socket ${socket.id}`);
                existingRoom.hostSocketId = socket.id;
                existingRoom.hostClient = hostClient;
                existingRoom.deviceId = currentDeviceId;
                if (resolvedGameType && (!existingRoom.gameState || !existingRoom.gameState.gameType)) {
                    if (!existingRoom.gameState) existingRoom.gameState = {};
                    existingRoom.gameState.gameType = resolvedGameType;
                }
            } else {
                console.warn(`[Security Violation] Unauthorized attempt to recreate room ${roomId} by client ${hostClient}`);
                socket.emit('auth_error', 'كود الغرفة هذا مستخدم بالفعل من قبل مستخدم آخر.');
                return;
            }
        }
        resetRoomTimer(roomId);
        broadcastDashboardUpdate();
    });


    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        if (roomsData[roomId]) {
            socket.emit('syncState', roomsData[roomId].gameState);
            resetRoomTimer(roomId);
        }
        broadcastDashboardUpdate();
    });

    socket.on('disconnect', () => {
        // 1. Disconnect stream connection associated with this socket immediately
        if (socket.tiktokConn) {
            console.log(`[TikTok Socket Disconnect] Disconnecting TikTokLiveConnection for socket ${socket.id}`);
            try { socket.tiktokConn.disconnect(); } catch (e) {}
            socket.tiktokConn = null;
        }
        if (socket.twitchConn) {
            console.log(`[Twitch Socket Disconnect] Disconnecting Twitch connection for socket ${socket.id}`);
            try { socket.twitchConn.disconnect(); } catch (e) {}
            socket.twitchConn = null;
        }
        if (socket.kickConn) {
            console.log(`[Kick Socket Disconnect] Disconnecting Kick connection for socket ${socket.id}`);
            try { socket.kickConn.disconnect(); } catch (e) {}
            socket.kickConn = null;
        }

        // 2. Clean up marathon loops/queues
        if (marathonLoops[socket.id]) {
            clearInterval(marathonLoops[socket.id]);
            delete marathonLoops[socket.id];
        }
        delete marathonQueues[socket.id];

        // 3. Find if this socket owns any room (either by socket.id or hostSocketId) and clean it up immediately
        for (const roomId in roomsData) {
            const room = roomsData[roomId];
            if (roomId === socket.id || room.hostSocketId === socket.id) {
                console.log(`[Socket Disconnect] Cleaning up room ${roomId} owned by host socket ${socket.id} immediately.`);
                if (room.timer) clearTimeout(room.timer);
                if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
                if (room.tiktokConn) {
                    try { room.tiktokConn.disconnect(); } catch (e) {}
                }
                if (room.twitchConn) {
                    try { room.twitchConn.disconnect(); } catch (e) {}
                }
                if (room.kickConn) {
                    try { room.kickConn.disconnect(); } catch (e) {}
                }
                if (marathonLoops[roomId]) {
                    clearInterval(marathonLoops[roomId]);
                    delete marathonLoops[roomId];
                }
                delete marathonQueues[roomId];
                delete roomsData[roomId];
            }
        }

        setTimeout(broadcastDashboardUpdate, 1000);
    });

    socket.on('gameEvent', (data) => {
        if (data && data.room) {
            const room = roomsData[data.room];
            if (!room) return;

            // التحقق الأمني: لا يُسمح بإغلاق الروم أو حفظ الحالة إلا من سوكت الهوست الحقيقي للغرفة
            const isHostEvent = data.event === 'roomClosed' || data.event === 'saveState';
            if (isHostEvent && room.hostSocketId !== socket.id) {
                console.warn(`[Security Alert] Non-host socket ${socket.id} tried to trigger host event "${data.event}" in room ${data.room}`);
                return; // تجاهل الطلب لحماية الغرفة
            }

            if (data.event === 'roomClosed') {
                socket.to(data.room).emit('roomClosed', data.payload);
                clearTimeout(room.timer);
                delete roomsData[data.room];
                io.in(data.room).socketsLeave(data.room);
                broadcastDashboardUpdate();
                return;
            }

            resetRoomTimer(data.room);
            if (data.event === 'saveState') {
                room.gameState = data.payload;
            }
            socket.to(data.room).emit(data.event, data.payload);
            if (data.event === 'saveState') broadcastDashboardUpdate();
        }
    });

    // ============================================================
    //   نظام تتبع أسئلة الألعاب (Game Question Tracking)
    //   يحفظ الأسئلة/الأرقام المستخدمة per tiktokUser على السيرفر
    //   data.gameKey: 'trivia' | 'bomb' | 'hexagon'
    // ============================================================

    // [1] تسجيل عناصر مستخدمة
    socket.on('game_track_used', (data) => {
        const room = roomsData[socket.id];
        if (!room) return;
        const key = data.gameKey || 'trivia';
        if (!room.usedItems) room.usedItems = {};
        if (!room.usedItems[key]) room.usedItems[key] = new Set();
        if (Array.isArray(data.items)) {
            data.items.forEach(item => room.usedItems[key].add(String(item)));
        }
    });

    // [2] طلب العناصر المستخدمة
    socket.on('game_get_used', (data) => {
        const room = roomsData[socket.id];
        const key = (data && data.gameKey) || 'trivia';
        const usedSet = (room && room.usedItems && room.usedItems[key]) ? room.usedItems[key] : new Set();
        socket.emit('game_used_response', { gameKey: key, items: Array.from(usedSet) });
        if (room) {
            console.log(`[Game Tracking] Sent ${usedSet.size} used items for game=${key}, room=${socket.id}`);
        }
    });

    // [3] إعادة تعيين قائمة لعبة معينة
    socket.on('game_reset_used', (data) => {
        const room = roomsData[socket.id];
        if (!room) return;
        const key = (data && data.gameKey) || 'trivia';
        if (!room.usedItems) room.usedItems = {};
        room.usedItems[key] = new Set();
        console.log(`[Game Tracking] Reset used items for game=${key}, room=${socket.id}`);
    });

    // [4] إزالة عناصر مستخدمة معينة
    socket.on('game_untrack_used', (data) => {
        const room = roomsData[socket.id];
        if (!room) return;
        const key = data.gameKey || 'trivia';
        if (room.usedItems && room.usedItems[key] && Array.isArray(data.items)) {
            data.items.forEach(item => room.usedItems[key].delete(String(item)));
            console.log(`[Game Tracking] Removed ${data.items.length} items from game=${key}, room=${socket.id}`);
        }
    });

    // متوافق مع النظام القديم (trivia-survival.html مازال يستخدم الأحداث القديمة)
    socket.on('trivia_track_questions', (data) => {
        const room = roomsData[socket.id];
        if (!room) return;
        if (!room.usedItems) room.usedItems = {};
        if (!room.usedItems['trivia']) room.usedItems['trivia'] = new Set();
        if (Array.isArray(data.questions)) {
            data.questions.forEach(q => room.usedItems['trivia'].add(String(q)));
        }
    });

    socket.on('trivia_get_used_questions', () => {
        const room = roomsData[socket.id];
        const usedSet = (room && room.usedItems && room.usedItems['trivia']) ? room.usedItems['trivia'] : new Set();
        socket.emit('trivia_used_questions_response', { questions: Array.from(usedSet) });
        console.log(`[Trivia Tracking Legacy] Sent ${usedSet.size} used questions for room ${socket.id}`);
    });

    socket.on('trivia_reset_questions', () => {
        const room = roomsData[socket.id];
        if (!room) return;
        if (!room.usedItems) room.usedItems = {};
        room.usedItems['trivia'] = new Set();
        console.log(`[Trivia Tracking Legacy] Reset for room ${socket.id}`);
    });

    // --- Russian Roulette Socket Event Handlers ---
    socket.on('russian_roulette_init', (data) => {
        const room = roomsData[socket.id];
        if (!room) return;

        const firingMode = data.firingMode || 'classic';
        const chambersCount = parseInt(data.chambersCount) || 6;
        const bulletsCount = parseInt(data.bulletsCount) || 1;

        // Calculate base survival chance based on chambers and bullets: S = round((1 - bullets/chambers) * 100)
        const calculatedSurvival = Math.round((1 - (bulletsCount / chambersCount)) * 100);

        room.rouletteState = {
            firingMode: firingMode,
            chambersCount: chambersCount,
            bulletsCount: bulletsCount,
            survivalChance: calculatedSurvival,
            cylinder: generateCylinder(chambersCount, bulletsCount),
            activeChamberIndex: 0,
            shotsTaken: 0
        };
        console.log(`[Russian Roulette Init] Room ${socket.id} loaded in ${firingMode} mode. Calculated survival chance: ${calculatedSurvival}%.`);
    });

    socket.on('russian_roulette_spin', () => {
        const room = roomsData[socket.id];
        if (!room || !room.rouletteState) return;

        const state = room.rouletteState;
        const total = state.chambersCount;
        state.activeChamberIndex = Math.floor(Math.random() * total);
        
        socket.emit('russian_roulette_spin_result', {
            activeChamberIndex: state.activeChamberIndex
        });
        console.log(`[Russian Roulette Spin] Room ${socket.id} spun to chamber ${state.activeChamberIndex}.`);
    });

    socket.on('russian_roulette_pull_trigger', (data) => {
        const room = roomsData[socket.id];
        if (!room || !room.rouletteState) return;

        const state = room.rouletteState;
        const victimId = data.victimId;
        if (!victimId) return;

        let isBullet = false;
        let shots = state.shotsTaken || 0;

        if (state.firingMode === 'classic') {
            isBullet = state.cylinder[state.activeChamberIndex];
            state.activeChamberIndex = (state.activeChamberIndex + 1) % state.chambersCount;
        } else {
            // Percentage mode: dynamic probability drop
            // Survival chance decreases by 15% on each consecutive shot
            const currentSurvival = Math.max(5, state.survivalChance - (shots * 15));
            const roll = Math.random() * 100;
            isBullet = roll > currentSurvival;
        }

        // Increment consecutive shots taken
        state.shotsTaken = shots + 1;

        // Calculate the survival chance for the NEXT shot if they survive
        const nextSurvivalChance = Math.max(5, state.survivalChance - (state.shotsTaken * 15));

        if (isBullet) {
            // Reset state on hit (death)
            state.shotsTaken = 0;
            if (state.firingMode === 'classic') {
                state.cylinder = generateCylinder(state.chambersCount, state.bulletsCount);
                state.activeChamberIndex = 0;
            }
        }

        socket.emit('russian_roulette_trigger_result', {
            isBullet: isBullet,
            activeChamberIndex: state.activeChamberIndex,
            shotsTaken: state.shotsTaken, // this is the correct non-reset count
            nextSurvivalChance: nextSurvivalChance
        });

        console.log(`[Russian Roulette Trigger] Room ${socket.id} pulled trigger. Victim ${victimId} shots: ${state.shotsTaken}. Hit: ${isBullet}.`);
    });

});

function generateCylinder(chambers, bullets) {
    const cylinder = new Array(chambers).fill(false);
    let bulletsPlaced = 0;
    while (bulletsPlaced < bullets) {
        const randIndex = Math.floor(Math.random() * chambers);
        if (!cylinder[randIndex]) {
            cylinder[randIndex] = true;
            bulletsPlaced++;
        }
    }
    return cylinder;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`سيرفر Q-Kio شغال ومستعد على بورت ${PORT}`);
});
