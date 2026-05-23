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

const PORT = process.env.PORT || 3001;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const serviceAccountPath = path.join(__dirname, 'service-account.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

const mqttOptions = {
    host: process.env.HIVEMQ_HOST,
    port: 8883,
    protocol: 'mqtts',
    username: process.env.HIVEMQ_USERNAME,
    password: process.env.HIVEMQ_PASSWORD,
};

const upload = multer({ storage: multer.memoryStorage() });

const serviceAccountAuth = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

let lastReceivedData = { temp: null, hum: null, time: 0 };

const client = mqtt.connect(mqttOptions);
client.on('connect', () => {
    console.log('Connected to HiveMQ Broker');
    client.subscribe('nhakho/telemetry');
    client.subscribe('nhakho/recovery');
});

client.on('message', async (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        
        // --- 🛠️ XỬ LÝ PHẢN HỒI OTA TỪ MẠCH ---
        if (data.status === 'OTA_SUCCESS') {
            io.emit('otaEvent', { success: true, message: '✓ Mạch đã nhận Code mới thành công và đang khởi động lại!' });
            return; // Dừng lại, không ghi vào Google Sheets
        } else if (data.status === 'OTA_FAILED') {
            io.emit('otaEvent', { success: false, message: 'Nạp Code thất bại! Vui lòng thử lại.' });
            return;
        }

        // --- XỬ LÝ DỮ LIỆU CẢM BIẾN ---
        const nowMs = Date.now();
        let timestamp;
        if (topic === 'nhakho/recovery' && data.timestamp) {
            timestamp = new Date(data.timestamp * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        } else {
            timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        }

        const suffix = (topic === 'nhakho/recovery') ? ' [Recovery]' : '';
        io.emit('mqttData', { ...data, time: timestamp.split(' ')[0] });

        if (topic === 'nhakho/telemetry') {
            if (lastReceivedData.temp === data.temp && 
                lastReceivedData.hum === data.hum && 
                (nowMs - lastReceivedData.time < 45000)) {
                return; 
            }
            lastReceivedData = { temp: data.temp, hum: data.hum, time: nowMs };
        }

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

app.use(express.static('public'));

app.post('/reset-wifi', (req, res) => {
    try {
        client.publish('nhakho/cmd', JSON.stringify({ cmd: "RESET_WIFI" }));
        res.send('Gửi lệnh yêu cầu xóa cấu hình WiFi và khởi động lại mạch thành công!');
    } catch (err) {
        res.status(500).send(`Không thể gửi lệnh reset: ${err.message}`);
    }
});

app.post('/upload-ota', upload.single('firmware'), async (req, res) => {
    if (!req.file) return res.status(400).send('Không tìm thấy file firmware.');

    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const targetPath = 'public/ota/firmware.bin';

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${targetPath}`;
    const fileBase64 = req.file.buffer.toString('base64');
    let fileSha = null;

    try {
        const getRes = await fetch(`${apiUrl}?ref=${branch}`, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NodeJS-OTA' }
        });
        if (getRes.ok) fileSha = (await getRes.json()).sha; 

        const putPayload = { message: `OTA Update ${new Date().toLocaleTimeString()}`, content: fileBase64, branch: branch };
        if (fileSha) putPayload.sha = fileSha; 

        const putRes = await fetch(apiUrl, {
            method: 'PUT',
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'NodeJS-OTA' },
            body: JSON.stringify(putPayload)
        });

        if (!putRes.ok) throw new Error(await putRes.text());

        const rawOtaUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${targetPath}`;
        
        // Phát lệnh OTA xuống ESP32
        client.publish('nhakho/cmd', JSON.stringify({ cmd: "UPDATE_FIRMWARE", url: rawOtaUrl }));

        // Chỉ gửi phản hồi là Đã đẩy file thành công. Chờ mạch xử lý.
        res.send('Đã đẩy file lên Github và ra lệnh cho thiết bị!');
    } catch (err) {
        res.status(500).send(`Lỗi đẩy file lên GitHub: ${err.message}`);
    }
});

server.listen(PORT, () => console.log(`Server Render đang chạy tại Port ${PORT}`));