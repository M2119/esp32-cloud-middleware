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

// ==========================================
// 🔔 CẤU HÌNH THÔNG BÁO FB MESSENGER (CallMeBot) VÀ CÁC NGƯỠNG AN TOÀN
// ==========================================
const FB_API_KEY = process.env.FB_API_KEY || "xxxxx"; 

// 🟢 CÁC NGƯỠNG CẢNH BÁO MỚI (Đồng bộ với ESP32)
const TEMP_MIN = 20.0;
const TEMP_MAX = 25.0;
const HUM_MIN = 40.0;
const HUM_MAX = 80.0;

let lastAlertTime = 0; 

// Hàm gửi tin nhắn với nội dung động (báo chính xác thông số bị lỗi)
async function sendMessengerAlert(alertDetails, temp, hum, timeStr) {
    if (!FB_API_KEY || FB_API_KEY === "xxxxx") {
        console.warn("⚠️ Chưa cấu hình FB_API_KEY. Bỏ qua gửi Facebook Messenger.");
        return;
    }
    
    // Cooldown 15 phút chống Spam
    if (Date.now() - lastAlertTime < 900000) return;

    const message = `🚨 CẢNH BÁO NHÀ KHO 🚨\n${alertDetails}\n🌡️ Nhiệt độ hiện tại: ${temp}°C\n💧 Độ ẩm hiện tại: ${hum}%\n⏰ Thời gian: ${timeStr}`;
    const url = `https://api.callmebot.com/facebook/send.php?apikey=${FB_API_KEY}&text=${encodeURIComponent(message)}`;

    try {
        const response = await fetch(url);
        if (response.ok) {
            console.log("💬 [MESSENGER] Đã gửi tin nhắn cảnh báo thành công:\n", alertDetails);
            lastAlertTime = Date.now(); 
        }
    } catch (error) {
        console.error("❌ [MESSENGER] Lỗi kết nối gửi tin nhắn:", error);
    }
}
// ==========================================

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
let lastKnownState = { temp: null, hum: null, timeStr: null, alarm_muted: null };

io.on('connection', (socket) => {
    if (lastKnownState.temp !== null) {
        socket.emit('mqttData', {
            temp: lastKnownState.temp,
            hum: lastKnownState.hum,
            time: lastKnownState.timeStr,
            alarm_muted: lastKnownState.alarm_muted
        });
    }
});

const client = mqtt.connect(mqttOptions);
client.on('connect', () => {
    console.log('Connected to HiveMQ Broker');
    client.subscribe('nhakho/telemetry');
    client.subscribe('nhakho/recovery');
});

client.on('message', async (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        
        // 1. Phản hồi nhanh từ nút bấm
        if (data.is_ack) {
            lastKnownState.alarm_muted = data.alarm_muted; 
            io.emit('mqttData', { alarm_muted: data.alarm_muted });
            return; 
        }

        // 2. OTA Events
        if (data.status === 'OTA_SUCCESS') {
            io.emit('otaEvent', { success: true, message: '✓ Mạch đã nhận Code thành công!' });
            return; 
        } else if (data.status === 'OTA_FAILED') {
            io.emit('otaEvent', { success: false, message: 'Nạp Code thất bại! Thử lại.' });
            return;
        }

        // 3. Xử lý số liệu đo đạc
        const nowMs = Date.now();
        let timestamp;
        let isRecovery = (topic === 'nhakho/recovery');

        if (isRecovery && data.timestamp) {
            timestamp = new Date(data.timestamp * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        } else {
            timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        }

        const suffix = isRecovery ? ' [Recovery]' : '';
        let timeStr = timestamp.split(' ')[0];
        
        io.emit('mqttData', { ...data, time: timeStr });

        if (!isRecovery && data.temp != null && data.hum != null) {
            lastKnownState = { 
                temp: data.temp, 
                hum: data.hum, 
                timeStr: timeStr, 
                alarm_muted: data.alarm_muted !== undefined ? data.alarm_muted : lastKnownState.alarm_muted 
            };
            
            // 🟢 KIỂM TRA ĐIỀU KIỆN ĐỂ GỬI MESSENGER
            const currentTemp = parseFloat(data.temp);
            const currentHum = parseFloat(data.hum);
            let alertDetails = "";

            if (currentTemp > TEMP_MAX) alertDetails += `⚠️ LỖI: NHIỆT ĐỘ QUÁ CAO (>40°C)\n`;
            else if (currentTemp < TEMP_MIN) alertDetails += `⚠️ LỖI: NHIỆT ĐỘ QUÁ THẤP (<20°C)\n`;

            if (currentHum > HUM_MAX) alertDetails += `⚠️ LỖI: ĐỘ ẨM QUÁ CAO (>80%)\n`;
            else if (currentHum < HUM_MIN) alertDetails += `⚠️ LỖI: ĐỘ ẨM QUÁ THẤP (<40%)\n`;

            // Nếu có ít nhất 1 lỗi xảy ra thì kích hoạt hàm gửi tin nhắn
            if (alertDetails !== "") {
                sendMessengerAlert(alertDetails, currentTemp, currentHum, timestamp);
            }
        }

        // Chống spam Google Sheets
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
app.use(express.json()); 

app.post('/control-buzzer', (req, res) => {
    try {
        const { command } = req.body; 
        if (command === 'MUTE_BUZZER' || command === 'UNMUTE_BUZZER') {
            client.publish('nhakho/cmd', JSON.stringify({ cmd: command }));
            res.send('Đã gửi!');
        } else {
            res.status(400).send('Lỗi');
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post('/reset-wifi', (req, res) => {
    try {
        client.publish('nhakho/cmd', JSON.stringify({ cmd: "RESET_WIFI" }));
        res.send('Thành công!');
    } catch (err) {
        res.status(500).send(err.message);
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
        client.publish('nhakho/cmd', JSON.stringify({ cmd: "UPDATE_FIRMWARE", url: rawOtaUrl }));
        res.send('Đã đẩy file lên Github và ra lệnh cho thiết bị!');
    } catch (err) {
        res.status(500).send(`Lỗi đẩy file lên GitHub: ${err.message}`);
    }
});

server.listen(PORT, () => console.log(`Server Render đang chạy tại Port ${PORT}`));