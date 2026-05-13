require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mqtt = require('mqtt');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const os = require('os'); // Thêm thư viện hệ thống để lấy IP LAN

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
// Link tĩnh cho dashboard và file OTA (để trong public/ota/firmware.bin)
app.use(express.static(path.join(__dirname, 'public')));

// --- HÀM HỖ TRỢ: LẤY IP NỘI BỘ CỦA MÁY TÍNH ---
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Lấy địa chỉ IPv4 và không phải là địa chỉ nội bộ (127.0.0.1)
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// ==========================================
//    0. CẤU HÌNH THÔNG BÁO FB MESSENGER
// ==========================================
const FB_API_KEY = process.env.FB_API_KEY || "xxxxx";
const TEMP_ALARM_THRESHOLD = 40.0; 
let lastAlertTime = 0; 

async function sendMessengerAlert(temp, hum, timeStr) {
  if (!FB_API_KEY || FB_API_KEY === "xxxxx") {
    console.warn("⚠️ Chưa cấu hình FB_API_KEY. Bỏ qua gửi Messenger.");
    return;
  }
  
  if (Date.now() - lastAlertTime < 900000) return; // Cooldown 15p

  const message = `🚨 CẢNH BÁO NHÀ KHO 🚨\nNhiệt độ vượt ngưỡng!\n🌡️ T: ${temp}°C | 💧 H: ${hum}%\n⏰ ${timeStr}`;
  const url = `https://api.callmebot.com/facebook/send.php?apikey=${FB_API_KEY}&text=${encodeURIComponent(message)}`;

  try {
    const response = await fetch(url);
    if (response.ok) {
      console.log("💬 [MESSENGER] Đã gửi cảnh báo thành công!");
      lastAlertTime = Date.now();
    }
  } catch (error) {
    console.error("❌ [MESSENGER] Lỗi kết nối:", error);
  }
}

// ==========================================
//    1. KẾT NỐI GOOGLE SHEETS
// ==========================================
let sheet;
async function initSheets() {
  try {
    const keysPath = path.join(__dirname, 'service-account.json');
    if (!fs.existsSync(keysPath)) return;
    
    const creds = require('./service-account.json');
    const auth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
    await doc.loadInfo(); 
    sheet = doc.sheetsByIndex[0];
    console.log(`✅ [DATABASE] Kết nối Sheets thành công: ${doc.title}`);
  } catch (error) {
    console.error("❌ [DATABASE] Lỗi Sheets:", error);
  }
}
initSheets();

// ==========================================
//    2. KẾT NỐI WEBSOCKET
// ==========================================
wss.on('connection', (ws) => {
  console.log('🔗 [WS] Trình duyệt đã kết nối');
  ws.send(JSON.stringify({ type: 'status', message: 'Kết nối Backend thành công' }));
});

function broadcastWS(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

// ==========================================
//    3. KẾT NỐI HIVEMQ CLOUD
// ==========================================
const mqttUrl = `mqtts://${process.env.HIVEMQ_HOST}:8883`;
const mqttClient = mqtt.connect(mqttUrl, {
  username: process.env.HIVEMQ_USERNAME,
  password: process.env.HIVEMQ_PASSWORD,
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  console.log('🚀 [MQTT] Đã kết nối HiveMQ Cloud');
  mqttClient.subscribe(['nhakho/telemetry', 'nhakho/recovery']);
  broadcastWS({ type: 'mqtt_status', connected: true });
});

mqttClient.on('message', async (topic, payload) => {
  try {
    const data = JSON.parse(payload.toString());
    let isRecovery = (topic === 'nhakho/recovery');
    let timestamp = isRecovery ? Number(data.timestamp) * 1000 : Date.now();
    const timeStr = new Date(timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    // Lưu Google Sheets
    if (sheet && data.temp != null) {
      sheet.addRow({
        Timestamp: isRecovery ? `${timeStr} [PHỤC HỒI]` : timeStr,
        Temperature: data.temp,
        Humidity: data.hum
      }).catch(e => console.error("Lỗi ghi Sheets"));
    }

    // Cảnh báo Messenger
    if (!isRecovery && data.temp > TEMP_ALARM_THRESHOLD) {
      sendMessengerAlert(data.temp, data.hum, timeStr);
    }

    // Gửi lên Dashboard
    broadcastWS({ type: 'telemetry', temp: data.temp, hum: data.hum, time: timeStr, isRecovery });

  } catch (err) {
    console.error('❌ [MQTT] Lỗi dữ liệu:', err);
  }
});

// ==========================================
//    4. API ĐIỀU KHIỂN (CẬP NHẬT IP LAN)
// ==========================================
app.post('/api/command', (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: 'Thiếu lệnh' });

  let payload = {};
  
  if (cmd === 'UPDATE_FIRMWARE') {
    const port = process.env.PORT || 3001;
    // Tự động lấy IP máy tính để ESP32 có thể kết nối trong mạng LAN
    const localIp = getLocalIp(); 
    const protocol = req.protocol === 'https' ? 'https' : 'http';
    
    // Tạo link OTA chuẩn (Ví dụ: http://192.168.1.15:3001/ota/firmware.bin)
    const otaUrl = `${protocol}://${localIp}:${port}/ota/firmware.bin`;
    
    payload = { cmd: 'UPDATE_FIRMWARE', url: otaUrl };
    console.log(`⚙️ [CMD] Lệnh OTA: ${otaUrl}`);
  } else if (cmd === 'RESET_WIFI') {
    payload = { cmd: 'RESET_WIFI' };
  }

  mqttClient.publish('nhakho/cmd', JSON.stringify(payload), (err) => {
    if (err) return res.status(500).json({ error: 'Lỗi MQTT' });
    res.json({ success: true, payload });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🏢 [SERVER] Đang chạy tại: http://localhost:${PORT}`);
  console.log(`🌐 [LAN IP] ESP32 có thể kết nối qua: http://${getLocalIp()}:${PORT}`);
});