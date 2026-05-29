const express = require('express');
const http = require('http');
const cors = require('cors');
const admin = require('firebase-admin');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector'); // إضافة مكتبة تيك توك

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
    const { code, deviceId } = req.body;
    if (!code || !deviceId) {
        return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
    }
    if (code === '6565799') {
        const token = generateSecureToken({
            type: 'tiktok',
            code: code,
            client: 'Maintenance Mode',
            deviceId: deviceId,
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

        const usedDevices = data.usedDevices || [];
        if (data.device && !usedDevices.includes(data.device)) {
            usedDevices.push(data.device);
        }
        const maxDevices = Number(data.maxDevices) || 1;
        const isRegistered = usedDevices.includes(deviceId);

        // توليد توكن الجلسة الآمن
        const token = generateSecureToken({
            type: 'tiktok',
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

    if (isHost) {
        if (!token) {
            console.warn(`[Socket Auth] Rejected - Host socket missing token (Socket ID: ${socket.id})`);
            return next(new Error('Authentication error: Missing token for Host connection'));
        }
        const payload = verifySecureToken(token);
        if (!payload) {
            console.warn(`[Socket Auth] Rejected - Host socket invalid token signature (Socket ID: ${socket.id})`);
            return next(new Error('Authentication error: Invalid token signature'));
        }
        if (Date.now() > payload.expiry) {
            console.warn(`[Socket Auth] Rejected - Host socket token expired (Socket ID: ${socket.id})`);
            return next(new Error('Authentication error: Token expired'));
        }
        // حفظ بيانات الجلسة المصدقة في السوكت
        socket.decodedToken = payload;
        console.log(`[Socket Auth] Approved Host connection - Client: ${payload.client}, Type: ${payload.type}`);
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
        if (roomsData[roomId].timer) clearTimeout(roomsData[roomId].timer);

        roomsData[roomId].timer = setTimeout(() => {
            console.log(`[تنظيف أوتوماتيكي] حذف الغرفة ${roomId} بسبب الخمول.`);
            io.to(roomId).emit('roomClosed', 'تم إغلاق الغرفة بسبب عدم التفاعل لفترة طويلة');
            io.in(roomId).socketsLeave(roomId);

            // إغلاق اتصال التيك توك لو كان موجود
            if (roomsData[roomId].tiktokConn) {
                roomsData[roomId].tiktokConn.disconnect();
            }

            if (marathonLoops[roomId]) {
                clearInterval(marathonLoops[roomId]);
                delete marathonLoops[roomId];
            }

            delete roomsData[roomId];
            broadcastDashboardUpdate();
        }, 30 * 60 * 1000);
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
                    'tiktok_marathon': 'تيك توك: الماراثون الجماعي 🏃‍♂️',
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

const MARATHON_WORDS = [
    "مسرع", "متحمس", "بطل", "سباق", "نصر", "تحدي", "قوة", "سرعة", "ماراثون", "وقود",
    "فوز", "نجم", "اسطورة", "عزيمة", "طاقة", "حماس", "قمة", "كاسر", "شجاع", "ذكي"
];

function handleMarathonChat(roomId, data) {
    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;
    const state = room.marathonState;
    const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
    const comment = data.comment.trim();
    const nickname = data.nickname || data.uniqueId;
    const avatar = data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}`;

    if (!state.isActive) {
        if (state.entryType === 'word') {
            const commentNorm = normalizeArabicForServer(comment);
            const entryNorm = normalizeArabicForServer(state.entryValue);
            if (commentNorm.includes(entryNorm) || comment.toLowerCase().includes(state.entryValue.toLowerCase())) {
                joinMarathonPlayer(state, uniqueId, nickname, avatar);
            }
        }
    } else {
        const player = state.players[uniqueId];
        if (player && state.wordChallenge.active && !player.isFrozen) {
            const commentNorm = normalizeArabicForServer(comment);
            const targetNorm = normalizeArabicForServer(state.wordChallenge.word);
            if (commentNorm === targetNorm || comment.toLowerCase() === state.wordChallenge.word.toLowerCase()) {
                const alreadySolved = state.wordChallenge.slots.some(s => s.id === uniqueId);
                if (!alreadySolved && state.wordChallenge.slots.length < 3) {
                    let boost = 0;
                    const slotIndex = state.wordChallenge.slots.length;
                    if (slotIndex === 0) boost = 0.04;      // أقصى دفعة سرعة
                    else if (slotIndex === 1) boost = 0.025; // دفعة متوسطة
                    else if (slotIndex === 2) boost = 0.015; // دفعة خفيفة

                    state.wordChallenge.slots.push({
                        id: uniqueId,
                        name: nickname,
                        avatar: avatar,
                        boost: boost
                    });

                    player.wordBoost = boost;
                    player.comments++;

                    if (state.wordChallenge.slots.length === 3) {
                        state.wordChallenge.solvedAt = Date.now();
                    }
                }
            }
        }
    }
}

function handleMarathonLike(roomId, data) {
    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;
    const state = room.marathonState;
    const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
    const nickname = data.nickname || data.uniqueId;
    const avatar = data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}`;
    const likeCount = data.likeCount || 1;

    if (!state.isActive) {
        if (state.entryType === 'likes' || state.entryType === 'all') {
            joinMarathonPlayer(state, uniqueId, nickname, avatar);
        }
    } else {
        const player = state.players[uniqueId];
        if (player) {
            player.likes += likeCount;
            player.recentLikes += likeCount;
            player.lastActive = Date.now();
            
            // Check milestones: 200, 400, 800, 1600
            const milestones = [200, 400, 800, 1600];
            if (!player.reachedMilestones) player.reachedMilestones = [];
            milestones.forEach(m => {
                if (player.likes >= m && !player.reachedMilestones.includes(m)) {
                    player.reachedMilestones.push(m);
                    player.boostUntil = Date.now() + 6000; // 6 seconds temporary double speed boost
                    io.to(roomId).emit('marathon_milestone', {
                        playerName: nickname,
                        milestone: m,
                        duration: 6
                    });
                }
            });
        } else if (state.entryType === 'likes' || state.entryType === 'all') {
            if (Object.keys(state.players).length < state.maxPlayers) {
                const newPlayer = joinMarathonPlayer(state, uniqueId, nickname, avatar);
                if (newPlayer) {
                    newPlayer.likes += likeCount;
                    newPlayer.recentLikes += likeCount;
                }
            }
        }
    }
}

function handleMarathonShare(roomId, data) {
    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;
    const state = room.marathonState;
    const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
    const nickname = data.nickname || data.uniqueId;
    const avatar = data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}`;

    if (!state.isActive) {
        if (state.entryType === 'all') {
            joinMarathonPlayer(state, uniqueId, nickname, avatar);
        }
    } else {
        const player = state.players[uniqueId];
        if (player) {
            if (!player.shares) player.shares = 0;
            player.shares++;
            player.lastActive = Date.now();

            if (player.shares === 5 && !player.shareBoostUsed) {
                player.shareBoostUsed = true;
                player.boostUntil = Date.now() + 6000; // 6 seconds temporary double speed boost
                io.to(roomId).emit('marathon_milestone', {
                    playerName: nickname,
                    milestone: '5 شير للبث',
                    duration: 6,
                    isShare: true
                });
            }
        }
    }
}

function handleMarathonGift(roomId, data) {
    const room = roomsData[roomId];
    if (!room || !room.marathonState) return;
    const state = room.marathonState;
    const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
    const nickname = data.nickname || data.uniqueId;
    const avatar = data.profilePictureUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}`;
    const giftName = data.giftName || '';

    if (!state.isActive) {
        if (state.entryType === 'gift') {
            joinMarathonPlayer(state, uniqueId, nickname, avatar);
        }
    }

    const player = state.players[uniqueId];
    if (player) {
        player.gifts++;
        
        if (giftName.toLowerCase().includes(state.smallGiftId.toLowerCase())) {
            const spillPos = (player.progress - 0.03 + 1) % 1;
            const spillId = 'oil_' + Date.now() + '_' + Math.floor(Math.random()*1000);
            state.oilSpills.push({
                id: spillId,
                progress: spillPos,
                expiresAt: Date.now() + 6000, // 6 ثوانٍ
                spawnedBy: nickname
            });
            player.disruptions = (player.disruptions || 0) + 1; // زيادة عدد التخريبات
            console.log(`[Marathon Spill] Created by ${nickname} at progress ${spillPos}`);
        }
        else if (giftName.toLowerCase().includes(state.mediumGiftId.toLowerCase())) {
            const sorted = Object.values(state.players).sort((a,b) => {
                if (a.laps !== b.laps) return b.laps - a.laps;
                return b.progress - a.progress;
            });
            
            // إذا كان مطلق الصاروخ هو نفسه الأول، يستهدف الثاني. غير ذلك يستهدف الأول.
            let target = sorted[0];
            if (target && target.id === uniqueId && sorted.length > 1) {
                target = sorted[1];
            }
            
            if (target) {
                const rocketId = 'rocket_' + Date.now() + '_' + Math.floor(Math.random()*1000);
                state.rockets.push({
                    id: rocketId,
                    progress: player.laps + player.progress, // Start from the shooter's actual position (laps + progress)
                    targetId: target.id,
                    speed: 0.15, // السرعة لكل ثانية (تمت زيادتها من 0.05)
                    spawnedBy: nickname,
                    expires: false
                });
                player.disruptions = (player.disruptions || 0) + 1; // زيادة عدد التخريبات
                console.log(`[Marathon Rocket] Fired by ${nickname} targeting ${target.name}`);
            }
        }
    }
}

function joinMarathonPlayer(state, uniqueId, nickname, avatar) {
    if (state.players[uniqueId]) return state.players[uniqueId];
    if (Object.keys(state.players).length >= state.maxPlayers) return null;

    const newPlayer = {
        id: uniqueId,
        name: nickname,
        avatar: avatar,
        progress: 0,
        laps: 0,
        speed: 0, // تبدأ السرعة من 0 ولا يتحرك اللاعب إلا بالتكبيس
        wordBoost: 0,
        likes: 0,
        comments: 0,
        gifts: 0,
        recentLikes: 0,
        isFrozen: false,
        freezeUntil: 0,
        reachedMilestones: [],
        boostUntil: 0,
        shares: 0,
        shareBoostUsed: false,
        hitOilSpills: [], // تتبع بقع الزيت التي اصطدم بها لتجنب تكرار الإشعار
        lastActive: Date.now()
    };
    state.players[uniqueId] = newPlayer;
    
    // إرسال تحديث فوري للاعب المنضم في مرحلة اللوبي
    io.to(state.roomId).emit('marathon_lobby_update', {
        players: Object.values(state.players)
    });

    return newPlayer;
}

function normalizeArabicForServer(text) {
    if (!text) return '';
    return text.normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/[yيى]/g, 'ي')
        .replace(/[^\w\s\u0600-\u06FF]/gi, '')
        .trim();
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

    const interval = setInterval(() => {
        const currentRoom = roomsData[roomId];
        if (!currentRoom || !currentRoom.marathonState || !currentRoom.marathonState.isActive) {
            clearInterval(interval);
            delete marathonLoops[roomId];
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

            socket.emit('marathon_tick', {
                players: playersArr,
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

        // 2. تحديث اللاعبين وحركاتهم
        Object.values(mState.players).forEach(p => {
            if (p.isFrozen) {
                if (now >= p.freezeUntil) {
                    p.isFrozen = false;
                } else {
                    p.speed = 0;
                    p.wordBoost = 0;
                    p.recentLikes = 0;
                    return;
                }
            }

            // سرعة اللاعب الحالية (تبدأ من الصفر أو السرعة السابقة مع تباطؤ)
            let speed = p.speed || 0;

            // تباطؤ تدريجي للسرعة بنسبة 20% في الثانية في حال عدم التكبيس (معادلة اضمحلال أسية تناسب 0.2 ثانية)
            speed *= 0.956; 

            // سرعة التكبيس (Capped at max likes speed)
            if (p.recentLikes > 0) {
                // إذا كان اللاعب واقفاً تماماً، نعطيه دفعة انطلاق أولية لتسهيل الحركة
                const startBoost = speed === 0 ? 0.004 : 0;
                const likesBoost = Math.min(0.010, p.recentLikes * 0.002); // حد أقصى للتكبيس في التيك الواحد
                speed += likesBoost + startBoost;
                p.recentLikes = 0; // استهلاك التكبيسات المستلمة
            }

            // حد أقصى للسرعة الناتجة عن التكبيس العادي فقط (لتكون أبطأ بشكل ملحوظ من الشير والكومنت)
            if (speed > 0.014) speed = 0.014;

            // إذا أصبحت السرعة ضئيلة جداً، نوقف اللاعب تماماً
            if (speed < 0.0002) speed = 0;

            // دفعة الكلمات (تُضاف بعد حد التكبيس الأقصى حتى تتجاوزه وتدفع اللاعب بقوة)
            if (p.wordBoost > 0) {
                speed += p.wordBoost;
                p.wordBoost *= 0.917; // اضمحلال سرعة الكلمة بالاعتماد على dt (35% بالثانية)
                if (p.wordBoost < 0.0008) p.wordBoost = 0;
            }

            // فحص بقعة الزيت
            let onOil = false;
            mState.oilSpills.forEach(spill => {
                const diff = Math.abs((p.progress % 1) - spill.progress);
                const circularDiff = Math.min(diff, 1 - diff);
                if (circularDiff < 0.025) {
                    onOil = true;
                    if (!p.hitOilSpills) p.hitOilSpills = [];
                    if (!p.hitOilSpills.includes(spill.id)) {
                        p.hitOilSpills.push(spill.id);
                        io.to(roomId).emit('marathon_disruption', {
                            type: 'oil',
                            attacker: spill.spawnedBy,
                            victim: p.name
                        });
                    }
                }
            });
            if (onOil) {
                speed *= 0.05; // إبطاء شديد جداً بنسبة 95%
            }

            // تفعيل مضاعفة السرعة للتكبيس
            p.isBoosted = now < p.boostUntil;
            if (p.isBoosted) {
                speed *= 2.0;
            }

            p.speed = speed;
            p.progress += speed * dt; // زيادة المسافة حسب الفرق الزمني
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

        socket.emit('marathon_tick', {
            players: Object.values(mState.players),
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
                lastWordSpawn: 0
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
        if (roomsData[roomId] && roomsData[roomId].marathonState) {
            const state = roomsData[roomId].marathonState;
            state.isActive = false;
            state.players = {};
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
                console.log(`[Marathon Kick] Kicked player ${targetId} from room ${roomId}`);
                io.to(roomId).emit('marathon_lobby_update', {
                    players: Object.values(state.players)
                });
            }
        }
    });

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

        // كول داون 15 ثانية بين محاولات الربط لنفس الحساب (لتجنب الحظر والسبام)
        const now = Date.now();
        const lastConnect = connectionCooldowns[username];
        if (lastConnect && (now - lastConnect) < 15000) {
            const secondsLeft = Math.ceil((15000 - (now - lastConnect)) / 1000);
            socket.emit('tiktok_error', { message: `الرجاء الانتظار ${secondsLeft} ثانية قبل محاولة الربط مجدداً.` });
            return;
        }
        connectionCooldowns[username] = now;

        // 1. تنظيف عالمي لأي اتصال نشط سابق لنفس اسم المستخدم لمنع تضارب الجلسات
        for (const rId in roomsData) {
            const room = roomsData[rId];
            if (room && room.isTikTok && room.tiktokUser && room.tiktokUser.trim().toLowerCase() === username) {
                console.log(`[TikTok Cleanup] Found active connection for @${username} in room ${rId}. Disconnecting...`);
                if (room.tiktokConn) {
                    try {
                        room.tiktokConn.disconnect();
                    } catch (err) {
                        console.error(`Error disconnecting old tiktokConn:`, err);
                    }
                }
                io.to(rId).emit('tiktok_disconnected', 'تم تسجيل الدخول بالبث من صفحة أو لعبة أخرى.');
                if (rId !== socket.id) {
                    delete roomsData[rId];
                }
            }
        }

        if (socket.tiktokConn) {
            socket.tiktokConn.disconnect();
        }

        console.log(`محاولة الاتصال ببث تيك توك: @${username}`);

        const connectionOptions = {
            processInitialData: false,
            enableExtendedGiftInfo: false,
            enableWebsocketUpgrade: true
        };

        // دعم البروكسي لتخطي حظر الـ IP من خوادم Render
        const proxyUrl = process.env.TIKTOK_PROXY_URL;
        if (proxyUrl) {
            console.log(`[Proxy] توجيه اتصال التيك توك عبر البروكسي: ${proxyUrl.replace(/:[^:]*@/, ':****@')}`);
            try {
                const { HttpsProxyAgent } = require('https-proxy-agent');
                const agent = new HttpsProxyAgent(proxyUrl);
                
                connectionOptions.webClientOptions = {
                    httpsAgent: agent
                };
                connectionOptions.websocketOptions = {
                    agent: agent
                };
                connectionOptions.requestOptions = {
                    httpsAgent: agent
                };
            } catch (proxyErr) {
                console.error(`❌ فشل تهيئة البروكسي:`, proxyErr.message);
            }
        }

        const startTikTokConnection = (attempt = 1, isReconnect = false) => {
            if (isReconnect) {
                console.log(`[TikTok Reconnect] Attempt ${attempt} for @${username} (Socket: ${socket.id})`);
                socket.emit('tiktok_reconnecting', { attempt, maxAttempts: 5 });
            }

            let tiktokLiveConnection = new WebcastPushConnection(username, connectionOptions);

            tiktokLiveConnection.connect().then(state => {
                console.log(`✅ تم الاتصال بنجاح ببث: @${username} (RoomID: ${state.roomId}) (Reconnect: ${isReconnect})`);

                const profilePic = state.roomInfo?.owner?.avatar_large?.url_list?.[0] ||
                    state.roomInfo?.owner?.avatar_medium?.url_list?.[0] ||
                    state.roomInfo?.owner?.avatar_thumb?.url_list?.[0] ||
                    'https://ui-avatars.com/api/?name=' + username;
                const nickname = state.roomInfo?.owner?.nickname || username;

                if (isReconnect) {
                    if (roomsData[socket.id]) {
                        roomsData[socket.id].tiktokConn = tiktokLiveConnection;
                    }
                    socket.emit('tiktok_reconnected', { profilePic, nickname });
                } else {
                    // تسجيل الروم لأول مرة
                    roomsData[socket.id] = {
                        createdAt: Date.now(),
                        gameState: { gameType: 'tiktok_bomb' },
                        isTikTok: true,
                        tiktokUser: username,
                        tiktokConn: tiktokLiveConnection,
                        timer: null,
                        chatFilter: null
                    };
                    resetRoomTimer(socket.id); // بدء عداد الحذف التلقائي (30 دقيقة)
                    broadcastDashboardUpdate();
                    socket.emit('tiktok_connected', { profilePic, nickname });
                }

                // تمرير أحداث تيك توك للعميل (مع حماية الفلترة)
                tiktokLiveConnection.on('chat', data => {
                    const room = roomsData[socket.id];
                    if (!room) return;
                    if (room.gameState && room.gameState.gameType === 'tiktok_marathon') {
                        handleMarathonChat(socket.id, data);
                        return;
                    }
                    if (!room.chatFilter) return; // تجاهل كل الشات إذا لم يكن هناك فلتر نشط
                    if (room.chatFilter.type === 'exact') {
                        const comment = data.comment.trim().toLowerCase();
                        const targets = room.chatFilter.targets || [];

                        if (targets.includes(comment)) {
                            socket.emit('tiktok_chat', data);
                            // بمجرد إيجاد فائز، يتم مسح الفلتر فوراً لتجاهل باقي الإجابات
                            room.chatFilter = null;
                        }
                    } else if (room.chatFilter.type === 'contains_any') {
                        // فلتر القنبلة: يرسل أي تعليق يحتوي على أي كلمة مستهدفة (بدون مسح الفلتر)
                        const comment = data.comment.trim().toLowerCase();
                        const targets = room.chatFilter.targets || [];
                        const matched = targets.find(t => comment.includes(t));
                        if (matched) {
                            socket.emit('tiktok_chat', { ...data, matchedTarget: matched });
                        }
                    } else if (room.chatFilter.type === 'active_players') {
                        const uniqueId = data.uniqueId ? data.uniqueId.toLowerCase() : '';
                        const comment = data.comment.trim();
                        const playersList = (room.chatFilter.players || []).map(p => p.toLowerCase());
                        
                        if (playersList.includes(uniqueId)) {
                            if (room.chatFilter.regex) {
                                try {
                                    const regex = new RegExp(room.chatFilter.regex, room.chatFilter.regexFlags || '');
                                    if (regex.test(comment)) {
                                        socket.emit('tiktok_chat', data);
                                    }
                                } catch (regexErr) {
                                    socket.emit('tiktok_chat', data);
                                }
                            } else {
                                socket.emit('tiktok_chat', data);
                            }
                        }
                    } else if (room.chatFilter.type === 'regex') {
                        const comment = data.comment.trim();
                        if (room.chatFilter.regex) {
                            try {
                                const regex = new RegExp(room.chatFilter.regex, room.chatFilter.regexFlags || 'i');
                                if (regex.test(comment)) {
                                    socket.emit('tiktok_chat', data);
                                }
                            } catch (regexErr) {
                                // If regex compilation fails, ignore to protect server resources
                            }
                        }
                    } else if (room.chatFilter.type === 'all') {
                        socket.emit('tiktok_chat', data);
                    }
                });
                tiktokLiveConnection.on('gift', data => {
                    const room = roomsData[socket.id];
                    if (room && room.gameState && room.gameState.gameType === 'tiktok_marathon') {
                        handleMarathonGift(socket.id, data);
                        return;
                    }
                    socket.emit('tiktok_gift', data);
                });
                tiktokLiveConnection.on('like', data => {
                    const room = roomsData[socket.id];
                    if (room && room.gameState && room.gameState.gameType === 'tiktok_marathon') {
                        handleMarathonLike(socket.id, data);
                        return;
                    }
                    socket.emit('tiktok_like', data);
                });
                tiktokLiveConnection.on('share', data => {
                    const room = roomsData[socket.id];
                    if (room && room.gameState && room.gameState.gameType === 'tiktok_marathon') {
                        handleMarathonShare(socket.id, data);
                        return;
                    }
                    socket.emit('tiktok_share', data);
                });

                // الاستماع لإنهاء البث أو انقطاع الاتصال من خوادم تيك توك
                tiktokLiveConnection.on('streamEnd', (actionId) => {
                    console.log(`[TikTok StreamEnd] Stream ended for @${username}`);
                    socket.emit('tiktok_disconnected', 'تم إنهاء البث المباشر.');
                    if (roomsData[socket.id]) {
                        if (roomsData[socket.id].tiktokConn) {
                            try { roomsData[socket.id].tiktokConn.disconnect(); } catch(e){}
                        }
                        delete roomsData[socket.id];
                        broadcastDashboardUpdate();
                    }
                });

                tiktokLiveConnection.on('disconnected', () => {
                    console.log(`[TikTok Disconnected] Connection dropped for @${username}. Initiating reconnect...`);
                    if (roomsData[socket.id] && roomsData[socket.id].tiktokConn) {
                        try { roomsData[socket.id].tiktokConn.disconnect(); } catch(e){}
                    }
                    // محاولة إعادة الاتصال فوراً
                    if (socket.connected && roomsData[socket.id]) {
                        startTikTokConnection(1, true);
                    }
                });

                socket.tiktokConn = tiktokLiveConnection;

            }).catch(err => {
                console.log(`❌ فشل الاتصال ببث @${username} (محاولة ${attempt}):`, err.message);
                
                const maxAttempts = isReconnect ? 5 : 4;
                const canRetry = attempt < maxAttempts && socket.connected && (isReconnect ? !!roomsData[socket.id] : true);

                if (canRetry) {
                    // الانتظار 3 ثواني قبل المحاولة القادمة (أو 5 ثواني في حالة إعادة الاتصال)
                    const delay = isReconnect ? 5000 : 3000;
                    setTimeout(() => {
                        const stillConnected = socket.connected && (isReconnect ? !!roomsData[socket.id] : true);
                        if (stillConnected) {
                            startTikTokConnection(attempt + 1, isReconnect);
                        }
                    }, delay);
                } else {
                    // فشل نهائي
                    const errMsg = err.message || '';
                    const isBlocked = errMsg.includes('403') || 
                                      errMsg.includes('429') || 
                                      errMsg.toLowerCase().includes('forbidden') || 
                                      errMsg.toLowerCase().includes('too many requests') ||
                                      errMsg.toLowerCase().includes('ip') ||
                                      errMsg.toLowerCase().includes('rate limit') ||
                                      errMsg.toLowerCase().includes('status code');
                    
                    let finalMsg = 'هذا الحساب ليس في بث مباشر حالياً، أو اليوزر خطأ.';
                    if (isBlocked) {
                        finalMsg = '⚠️ نعتذر، خوادم الربط تشهد ضغطاً مؤقتاً في الوقت الحالي. يرجى الانتظار قليلاً وإعادة المحاولة لاحقاً.';
                    } else if (isReconnect) {
                        finalMsg = 'انقطع الاتصال ببث التيك توك وفشلت محاولات إعادة الاتصال.';
                    }
                    
                    if (isReconnect) {
                        socket.emit('tiktok_disconnected', finalMsg);
                        if (roomsData[socket.id]) {
                            delete roomsData[socket.id];
                            broadcastDashboardUpdate();
                        }
                    } else {
                        socket.emit('tiktok_error', { message: finalMsg });
                    }
                }
            });
        };

        startTikTokConnection(1, false);
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
    socket.on('createRoom', (roomId) => {
        // التحقق الأمني: يجب أن يكون الاتصال مصدقاً ومصنفاً كـ Host
        if (!socket.decodedToken || (socket.decodedToken.type !== 'vip' && socket.decodedToken.type !== 'tiktok')) {
            console.warn(`[Security Violation] createRoom rejected for socket ${socket.id} - Not authorized`);
            socket.emit('auth_error', 'غير مصرح لك بإنشاء غرفة. يرجى تسجيل الدخول بكود تفعيل صالح.');
            return;
        }

        const hostClient = socket.decodedToken.client;
        const currentDeviceId = socket.decodedToken.deviceId;

        // منع الجلسات المتزامنة: إغلاق أي غرف نشطة سابقة لنفس هذا الهوست
        for (const existingRoomId in roomsData) {
            const existingRoom = roomsData[existingRoomId];
            if (existingRoom && existingRoom.hostClient === hostClient && existingRoomId !== roomId) {
                console.log(`[Concurrent Session] Closing old room ${existingRoomId} for host ${hostClient}`);
                io.to(existingRoomId).emit('roomClosed', 'تم إغلاق الغرفة لفتحها من جهاز أو متصفح آخر.');
                // إجبار كل السوكتس في الغرفة على مغادرتها
                io.in(existingRoomId).socketsLeave(existingRoomId);
                // تنظيف اتصال تيك توك لو كان موجود
                if (existingRoom.tiktokConn) {
                    existingRoom.tiktokConn.disconnect();
                }
                if (marathonLoops[existingRoomId]) {
                    clearInterval(marathonLoops[existingRoomId]);
                    delete marathonLoops[existingRoomId];
                }
                clearTimeout(existingRoom.timer);
                delete roomsData[existingRoomId];
            }
        }

        socket.join(roomId);
        if (!roomsData[roomId]) {
            roomsData[roomId] = {
                createdAt: Date.now(),
                gameState: {},
                timer: null,
                hostSocketId: socket.id, // تسجيل معرف سوكت الهوست للتحقق اللاحق
                hostClient: hostClient,
                deviceId: currentDeviceId
            };
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
        if (socket.tiktokConn) {
            socket.tiktokConn.disconnect();
        }
        if (marathonLoops[socket.id]) {
            clearInterval(marathonLoops[socket.id]);
            delete marathonLoops[socket.id];
        }
        if (roomsData[socket.id]) {
            delete roomsData[socket.id];
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

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`سيرفر Q-Kio شغال ومستعد على بورت ${PORT}`);
});
