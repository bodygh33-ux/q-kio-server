const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// كلمة السر للوحة التحكم
const ADMIN_PASSWORD = 'admin'; 

// الخزنة الرئيسية اللي هتشيل كل بيانات الرومات المفتوحة في الرامات
const roomsData = {};

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- دالة تحديث الداشبورد ---
function broadcastDashboardUpdate() {
    const activeRooms = {};
    for (const id in roomsData) {
        // استخراج نوع اللعبة من حالة الروم (سواء كان اسمها gameType أو type)
        const state = roomsData[id].gameState || {};
        const gType = state.gameType || state.type || "غير معروف";

        activeRooms[id] = {
            playerCount: io.sockets.adapter.rooms.get(id)?.size || 0,
            createdAt: roomsData[id].createdAt,
            gameType: gType // إرسال نوع اللعبة للداشبورد
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
                @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
            </style>
        </head>
        <body>
            <h2>رومات Q-Kio النشطة <span class="live-badge">Live 🔴</span></h2>
            <table>
                <thead>
                    <tr>
                        <th>رقم الروم (الكود)</th>
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
                
                // قاموس بأسماء الألعاب
                const gameNamesMap = {
                    'bathara': 'بعثرة 🧩',
                    'bingo': 'بينجو 🔢',
                    'risk_game': 'المجازفة 🃏',
                    'tarkiba': 'تركيبة 🔠',
                    'decode': 'فك الشفرة 🕵️',
                    'coordinates': 'إحداثيات 🎯',
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
                        const time = new Date(rooms[id].createdAt).toLocaleTimeString('ar-EG');
                        const count = rooms[id].playerCount;
                        const gType = rooms[id].gameType;
                        const gameDisplayName = gameNamesMap[gType] || gType;

                        html += \`
                            <tr>
                                <td><strong style="font-size:1.1rem;">\${id}</strong></td>
                                <td><span class="game-badge">\${gameDisplayName}</span></td>
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
        // طرد الهوست واللاعبين فوراً
        io.to(roomId).emit('roomClosed', 'تم إغلاق الغرفة من قبل الإدارة');
        io.in(roomId).socketsLeave(roomId);
        delete roomsData[roomId];
        broadcastDashboardUpdate(); 
    }
    res.send('تم الحذف بنجاح');
});


io.on('connection', (socket) => {
    
    socket.on('adminLogin', (pass) => {
        if(pass === ADMIN_PASSWORD) {
            socket.join('admin_room');
            broadcastDashboardUpdate();
        }
    });

    socket.on('createRoom', (roomId) => {
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
        console.log(`تم إنشاء روم جديدة: ${roomId}`);
    });

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        if (roomsData[roomId]) {
            socket.emit('syncState', roomsData[roomId].gameState);
            resetRoomTimer(roomId); 
        }
        broadcastDashboardUpdate(); 
        console.log(`اللاعب ${socket.id} دخل الغرفة ${roomId}`);
    });

    socket.on('disconnect', () => {
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
            
            // تحديث الداشبورد في حالة تغيير اللعبة
            if (data.event === 'saveState') {
                broadcastDashboardUpdate();
            }
        }
    });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`سيرفر Q-Kio شغال ومستعد على بورت ${PORT}`);
});
