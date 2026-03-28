const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// --- الإضافة الجديدة لحل مشكلة Cannot GET / ---
app.get('/', (req, res) => {
    res.send('Welcome to Q-Kio Server! السيرفر شغال وجاهز لاستقبال اللاعبين 🎮');
});
// ----------------------------------------------

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('لاعب جديد دخل السيرفر:', socket.id);

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        console.log(`اللاعب ${socket.id} دخل الغرفة ${roomId}`);
    });

    socket.on('gameEvent', (data) => {
        if (data && data.room) {
            socket.to(data.room).emit(data.event, data.payload);
        }
    });

    socket.on('disconnect', () => {
        console.log('لاعب خرج:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`سيرفر Q-Kio شغال على بورت ${PORT}`);
});
