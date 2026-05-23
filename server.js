require('dotenv').config();
const express = require('express');
const mqtt = require('mqtt');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- CẤU HÌNH TỪ FILE .env ---
const PORT = process.env.PORT || 3001;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Thông tin chứng thực tài khoản dịch vụ Google
const serviceAccountPath = path.join(__dirname, 'service-account.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

// Cấu hình MQTT Broker
const mqttOptions = {
    host: process.env.HIVEMQ_HOST,
    port: 8883,
    protocol: 'mqtts',
    username: process.env.HIVEMQ_USERNAME,
    password: process.env.HIVEMQ_PASSWORD,
};

// Cấu hình Multer sử dụng bộ nhớ RAM để đẩy thẳng OTA lên GitHub
const upload = multer({ storage: multer.memoryStorage() });

// --- KẾT NỐI GOOGLE SHEETS ---
const serviceAccountAuth = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// Bộ đệm ghi nhớ dữ liệu gần nhất để lọc trùng lặp
let lastReceivedData = { temp: null, hum: null, time: 0 };

// --- KẾT NỐI MQTT ---
const client = mqtt.connect(mqttOptions);
client.on('connect', () => {
    console.log('Connected to HiveMQ Broker');
    client.subscribe('nhakho/telemetry');
    client.subscribe('nhakho/recovery');
});

// Xử lý dữ liệu từ mạch gửi lên
client.on('message', async (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        const nowMs = Date.now();
        const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const suffix = (topic === 'nhakho/recovery') ? ' [Recovery]' : '';
        
        // Phát dữ liệu Realtime lên giao diện Web
        io.emit('mqttData', { ...data, time: timestamp.split(' ')[0] });

        // --- BỘ LỌC TRÙNG LẶP DỮ LIỆU ---
        if (topic === 'nhakho/telemetry') {
            if (lastReceivedData.temp === data.temp && 
                lastReceivedData.hum === data.hum && 
                (nowMs - lastReceivedData.time < 45000)) {
                return; // Bỏ qua, không ghi vào Sheet Data
            }
            lastReceivedData = { temp: data.temp, hum: data.hum, time: nowMs };
        }

        // Ghi dữ liệu sạch vào Sheet Data
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Data'];
        await sheet.addRow({
            Timestamp: `${timestamp}${suffix}`,
            Temperature: parseFloat(data.temp).toFixed(1).replace('.', ','),
            Humidity: parseFloat(data.hum).toFixed(1).replace('.', ',')
        });
    } catch (err) {
        console.error('Lỗi xử lý bản ghi MQTT:', err);
    }
});

// --- API ROUTES ---
app.use(express.static('public'));

// Xử lý upload OTA Remote qua GitHub API
app.post('/upload-ota', upload.single('firmware'), async (req, res) => {
    if (!req.file) return res.status(400).send('Không tìm thấy file firmware.');

    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const targetPath = 'public/ota/firmware.bin';

    if (!token || !owner || !repo) {
        return res.status(500).send('Chưa cấu hình Token hoặc Repo GitHub trong .env');
    }

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${targetPath}`;
    const fileBase64 = req.file.buffer.toString('base64');
    let fileSha = null;

    try {
        const getRes = await fetch(`${apiUrl}?ref=${branch}`, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'NodeJS-OTA-Uploader'
            }
        });

        if (getRes.ok) {
            const fileData = await getRes.json();
            fileSha = fileData.sha; 
        }

        const putPayload = {
            message: `Cập nhật Firmware OTA từ xa lúc ${new Date().toLocaleTimeString('vi-VN')}`,
            content: fileBase64,
            branch: branch
        };
        if (fileSha) putPayload.sha = fileSha; 

        const putRes = await fetch(apiUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'NodeJS-OTA-Uploader'
            },
            body: JSON.stringify(putPayload)
        });

        if (!putRes.ok) throw new Error(await putRes.text());

        const rawOtaUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${targetPath}`;
        client.publish('nhakho/cmd', JSON.stringify({ cmd: "UPDATE_FIRMWARE", url: rawOtaUrl }));

        res.send('Tải file lên GitHub thành công! Đã phát lệnh cập nhật OTA tự động.');
    } catch (err) {
        res.status(500).send(`Lỗi đẩy file lên GitHub: ${err.message}`);
    }
});

server.listen(PORT, () => console.log(`Server Render đang chạy tại Port ${PORT}`));