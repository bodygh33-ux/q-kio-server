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

function verifySocketAuth(socket, requiredType) {
    try {
        const auth = socket.handshake.auth;
        const token = auth && auth.token;
        if (!token) return false;
        
        const payload = verifySecureToken(token);
        if (!payload) return false;
        
        if (payload.type !== requiredType) return false;
        if (Date.now() > payload.expiry) return false;
        
        return true;
    } catch (e) {
        return false;
    }
}

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
app.post('/api/user/validate-game-code', async (req, res) => {
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
});

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
app.post('/api/user/verify-session', (req, res) => {
    const { token, deviceId, type } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'توكن مفقود' });

    const payload = verifySecureToken(token);
    if (!payload) return res.status(401).json({ success: false, message: 'توكن غير صالح أو منتهي الصلاحية' });

    if (type && payload.type !== type) {
        return res.status(403).json({ success: false, message: 'نوع جلسة غير متطابق' });
    }
    if (deviceId && payload.deviceId !== deviceId) {
        return res.status(403).json({ success: false, message: 'جلسة مسجلة لجهاز آخر' });
    }
    if (Date.now() > payload.expiry) {
        return res.status(401).json({ success: false, message: 'انتهت صلاحية الجلسة' });
    }

    res.json({ success: true, client: payload.client });
});

// الخزنة الرئيسية اللي هتشيل كل بيانات الرومات المفتوحة في الرامات
const roomsData = {};

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
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
        io.to(roomId).emit('roomClosed', 'تم إغلاق الغرفة من قبل الإدارة');
        io.in(roomId).socketsLeave(roomId);
        delete roomsData[roomId];
        broadcastDashboardUpdate();
    }
    res.send('تم الحذف بنجاح');
});


io.on('connection', (socket) => {

    socket.on('adminLogin', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            socket.join('admin_room');
            broadcastDashboardUpdate();
        }
    });

    // --- منطق ألعاب تيك توك اللحظية ---
    socket.on('tiktok_connect', (data) => {
        // التحقق الأمني من توكن التيك توك قبل الاتصال بالبث
        if (!verifySocketAuth(socket, 'tiktok')) {
            console.log(`[Security Action] Rejecting tiktok_connect for unauthorized socket ${socket.id}`);
            socket.emit('tiktok_error', { message: 'غير مصرح لك بالاتصال. يرجى تفعيل كود تيك توك صالح.' });
            socket.disconnect();
            return;
        }

        const username = data.username;
        if (!username) return;

        if (socket.tiktokConn) {
            socket.tiktokConn.disconnect();
        }

        console.log(`محاولة الاتصال ببث تيك توك: @${username}`);

        let tiktokLiveConnection = new WebcastPushConnection(username, {
            processInitialData: false,
            enableExtendedGiftInfo: false,
            enableWebsocketUpgrade: true
        });

        tiktokLiveConnection.connect().then(state => {
            console.log(`✅ تم الاتصال بنجاح ببث: @${username} (RoomID: ${state.roomId})`);

            const profilePic = state.roomInfo?.owner?.avatar_large?.url_list?.[0] ||
                state.roomInfo?.owner?.avatar_medium?.url_list?.[0] ||
                state.roomInfo?.owner?.avatar_thumb?.url_list?.[0] ||
                'https://ui-avatars.com/api/?name=' + username;
            const nickname = state.roomInfo?.owner?.nickname || username;

            // تسجيل الروم
            roomsData[socket.id] = {
                createdAt: Date.now(),
                gameState: { gameType: 'tiktok_bomb' },
                isTikTok: true,
                tiktokUser: username,
                tiktokConn: tiktokLiveConnection,
                timer: null
            };
            resetRoomTimer(socket.id); // بدء عداد الحذف التلقائي (30 دقيقة)
            broadcastDashboardUpdate();

            socket.emit('tiktok_connected', { profilePic, nickname });

            // إعداد فلتر مخصص من العميل لحماية السيرفر (Dynamic Filter)
            socket.on('set_tiktok_filter', (filterOptions) => {
                // filterOptions: { type: 'exact_match', targets: ['answer1', 'answer2'] }
                // أو { type: 'all' } للألعاب التي تحتاج كل الشات
                if (roomsData[socket.id]) {
                    roomsData[socket.id].chatFilter = filterOptions;
                }
            });

            // تمرير أحداث تيك توك للعميل (مع حماية الفلترة)
            tiktokLiveConnection.on('chat', data => {
                const room = roomsData[socket.id];
                if (!room || !room.chatFilter) return; // تجاهل كل الشات إذا لم يكن هناك فلتر نشط
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
                } else if (room.chatFilter.type === 'all') {
                    socket.emit('tiktok_chat', data);
                }
            });
            tiktokLiveConnection.on('gift', data => {
                socket.emit('tiktok_gift', data);
            });
            tiktokLiveConnection.on('like', data => {
                socket.emit('tiktok_like', data);
            });

            // الاستماع لإنهاء البث أو انقطاع الاتصال من خوادم تيك توك
            tiktokLiveConnection.on('streamEnd', (actionId) => {
                socket.emit('tiktok_disconnected', 'تم إنهاء البث المباشر.');
                if (roomsData[socket.id]) {
                    if (roomsData[socket.id].tiktokConn) {
                        roomsData[socket.id].tiktokConn.disconnect();
                    }
                    delete roomsData[socket.id];
                    broadcastDashboardUpdate();
                }
            });

            tiktokLiveConnection.on('disconnected', () => {
                socket.emit('tiktok_disconnected', 'انقطع الاتصال ببث التيك توك.');
                if (roomsData[socket.id]) {
                    if (roomsData[socket.id].tiktokConn) {
                        roomsData[socket.id].tiktokConn.disconnect();
                    }
                    delete roomsData[socket.id];
                    broadcastDashboardUpdate();
                }
            });

        }).catch(err => {
            console.error(`❌ فشل الاتصال ببث @${username}:`, err.message);
            socket.emit('tiktok_error', { message: 'هذا الحساب ليس في بث مباشر حالياً، أو اليوزر خطأ.' });
        });

        socket.tiktokConn = tiktokLiveConnection;
    });



    // استلام طلب الإغلاق اليدوي من زر "الإغلاق" في صفحة اللعبة
    socket.on('tiktok_disconnect', () => {
        if (socket.tiktokConn) {
            socket.tiktokConn.disconnect();
            socket.tiktokConn = null;
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
        // التحقق الأمني من توكن VIP قبل إنشاء غرفة ألعاب
        if (!verifySocketAuth(socket, 'vip')) {
            console.log(`[Security Action] Rejecting createRoom for unauthorized socket ${socket.id}`);
            socket.emit('error', 'غير مصرح لك بإنشاء غرفة ألعاب. يرجى تسجيل الدخول بكود صالح.');
            socket.disconnect();
            return;
        }

        socket.join(roomId);
        if (!roomsData[roomId]) {
            roomsData[roomId] = {
                createdAt: Date.now(),
                gameState: {},
                timer: null
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
        if (roomsData[socket.id]) {
            delete roomsData[socket.id];
        }
        setTimeout(broadcastDashboardUpdate, 1000);
    });

    socket.on('gameEvent', (data) => {
        if (data && data.room) {
            if (data.event === 'roomClosed') {
                socket.to(data.room).emit('roomClosed', data.payload);
                if (roomsData[data.room]) {
                    clearTimeout(roomsData[data.room].timer);
                    delete roomsData[data.room];
                }
                io.in(data.room).socketsLeave(data.room);
                broadcastDashboardUpdate();
                return;
            }
            resetRoomTimer(data.room);
            if (data.event === 'saveState' && roomsData[data.room]) {
                roomsData[data.room].gameState = data.payload;
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
