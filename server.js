const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// كلمة السر للوحة التحكم (تقدر تغيرها براحتك)
const ADMIN_PASSWORD = 'admin'; 

// الخزنة الرئيسية اللي هتشيل كل بيانات الرومات المفتوحة في الرامات
const roomsData = {};

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// --- دالة مساعدة لتجديد عداد الـ 30 دقيقة للروم ---
function resetRoomTimer(roomId) {
    if (roomsData[roomId]) {
        // لو في عداد قديم شغال، وقفه
        if (roomsData[roomId].timer) clearTimeout(roomsData[roomId].timer);
        
        // شغل عداد جديد بـ 30 دقيقة (30 * 60 * 1000 مللي ثانية)
        roomsData[roomId].timer = setTimeout(() => {
            console.log(`[تنظيف أوتوماتيكي] حذف الغرفة ${roomId} بسبب الخمول.`);
            // إبلاغ اللاعبين إن الروم اتقفلت
            io.to(roomId).emit('roomClosed', 'تم إغلاق الغرفة بسبب عدم التفاعل لفترة طويلة');
            // طرد كل اللاعبين من الغرفة
            io.in(roomId).socketsLeave(roomId);
            // حذف البيانات من الرامات
            delete roomsData[roomId];
        }, 30 * 60 * 1000); 
    }
}

// --- واجهات الموقع (الروابط) ---

// الصفحة الرئيسية للتأكيد إن السيرفر شغال
app.get('/', (req, res) => {
    res.send('Welcome to Q-Kio Server! السيرفر شغال وجاهز لاستقبال اللاعبين 🎮');
});

// لوحة التحكم السريعة للرومات (الداشبورد)
app.get('/dashboard', (req, res) => {
    // حماية الداشبورد بكلمة سر في الرابط
    if (req.query.pass !== ADMIN_PASSWORD) {
        return res.status(401).send('<h2 style="color:red; text-align:center;">عفواً، غير مصرح لك بالدخول</h2>');
    }

    let html = `
        <html dir="rtl">
        <head>
            <title>لوحة تحكم منصة Q-Kio</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #f4f4f9; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; background: white; }
                th, td { padding: 12px; border: 1px solid #ddd; text-align: center; }
                th { background-color: #333; color: white; }
                .btn-delete { background: #e74c3c; color: white; border: none; padding: 8px 15px; cursor: pointer; border-radius: 4px; }
                .btn-delete:hover { background: #c0392b; }
            </style>
        </head>
        <body>
            <h2>رومات Q-Kio النشطة حالياً</h2>
            <table>
                <tr>
                    <th>رقم الروم (الكود)</th>
                    <th>عدد اللاعبين المتصلين</th>
                    <th>تاريخ الإنشاء</th>
                    <th>إجراءات</th>
                </tr>
    `;

    const activeRooms = Object.keys(roomsData);
    if (activeRooms.length === 0) {
        html += '<tr><td colspan="4">لا توجد أي رومات مفتوحة حالياً.</td></tr>';
    } else {
        activeRooms.forEach(roomId => {
            const room = roomsData[roomId];
            // معرفة عدد المتصلين الفعليين بالروم حالياً
            const playerCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
            const createTime = new Date(room.createdAt).toLocaleTimeString('ar-EG');
            
            html += `
                <tr>
                    <td><strong>${roomId}</strong></td>
                    <td>${playerCount} لاعب</td>
                    <td>${createTime}</td>
                    <td>
                        <button class="btn-delete" onclick="if(confirm('متأكد من حذف روم ${roomId}؟')) { fetch('/delete-room?id=${roomId}&pass=${ADMIN_PASSWORD}').then(()=>location.reload()) }">إغلاق وحذف</button>
                    </td>
                </tr>
            `;
        });
    }

    html += `</table></body></html>`;
    res.send(html);
});

// رابط الحذف اليدوي للرومات (بيكلمه زرار الحذف في الداشبورد)
app.get('/delete-room', (req, res) => {
    if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('غير مصرح لك');
    const roomId = req.query.id;
    
    if (roomsData[roomId]) {
        clearTimeout(roomsData[roomId].timer);
        io.to(roomId).emit('roomClosed', 'تم إغلاق الغرفة من قبل الإدارة');
        io.in(roomId).socketsLeave(roomId);
        delete roomsData[roomId];
    }
    res.send('تم الحذف بنجاح');
});


// --- منطق الألعاب والاتصال ---
io.on('connection', (socket) => {
    
    // حدث إنشاء غرفة جديدة (بيبعته الهوست)
    socket.on('createRoom', (roomId) => {
        socket.join(roomId);
        // لو الروم مش موجودة، اعملها هيكل جديد في الرامات
        if (!roomsData[roomId]) {
            roomsData[roomId] = {
                createdAt: Date.now(),
                gameState: {}, // هنا الهوست هيحفظ النقاط والأرقام المسحوبة
                timer: null
            };
        }
        resetRoomTimer(roomId);
        console.log(`تم إنشاء روم جديدة: ${roomId}`);
    });

    // حدث انضمام لاعب للغرفة
    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        
        // لو الروم موجودة، ابعت للاعب ده "حالة اللعبة الحالية" عشان يشوف نفس اللي الناس شايفاه
        if (roomsData[roomId]) {
            socket.emit('syncState', roomsData[roomId].gameState);
            resetRoomTimer(roomId); // أي حد يدخل بيجدد العداد
        }
        console.log(`اللاعب ${socket.id} دخل الغرفة ${roomId}`);
    });

    // الموزع الشامل للأحداث + حفظ حالة اللعبة
    socket.on('gameEvent', (data) => {
        if (data && data.room) {
            
            // تجديد وقت الروم عشان اللعب شغال
            resetRoomTimer(data.room); 

            // لو الهوست باعت حدث اسمه 'saveState'، السيرفر هيحفظ الداتا دي في الرامات عنده
            if (data.event === 'saveState' && roomsData[data.room]) {
                roomsData[data.room].gameState = data.payload;
            }

            // إرسال الحركة لباقي اللاعبين في نفس الروم
            socket.to(data.room).emit(data.event, data.payload);
        }
    });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`سيرفر Q-Kio شغال ومستعد على بورت ${PORT}`);
});
