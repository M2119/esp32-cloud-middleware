require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mqtt = require('mqtt');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
// Lưu ý: File OTA phải nằm trong thư mục: public/ota/firmware.bin
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
//    0. CẤU HÌNH THÔNG BÁO FB MESSENGER
// ==========================================
const FB_API_KEY = process.env.FB_API_KEY || "xxxxx"; // Đặt API Key Messenger của bạn vào file .env hoặc thay thế trực tiếp ở đây
const TEMP_ALARM_THRESHOLD = 35.0; // Ngưỡng nhiệt độ kích hoạt cảnh báo
let lastAlertTime = 0; // Biến lưu vết thời gian cảnh báo cuối cùng để tránh spam (Cooldown)

// Hàm gửi tin nhắn cảnh báo tự động qua Facebook Messenger
async function sendMessengerAlert(temp, hum, timeStr) {
  if (!FB_API_KEY || FB_API_KEY === "xxxxx") {
    console.warn("⚠️ Chưa cấu hình FB_API_KEY. Bỏ qua tác vụ gửi thông báo Facebook Messenger.");
    return;
  }
  
  // Cơ chế Cooldown: Giới hạn chỉ gửi tin nhắn tối đa 15 phút (900.000 ms) một lần để tránh làm trôi tin nhắn
  if (Date.now() - lastAlertTime < 900000) {
    console.log("⏳ Nhiệt độ kho vẫn ở mức cao, nhưng đang trong khoảng thời gian chờ (cooldown) của thông báo Messenger.");
    return;
  }

  // Nội dung thông báo gửi đi
  const message = `🚨 CẢNH BÁO NHÀ KHO 🚨\nNhiệt độ vượt ngưỡng an toàn!\n🌡️ Nhiệt độ: ${temp}°C\n💧 Độ ẩm: ${hum}%\n⏰ Thời gian: ${timeStr}`;
  
  // Đường dẫn gọi API CallMeBot hỗ trợ Facebook Messenger
  const url = `https://api.callmebot.com/facebook/send.php?apikey=${FB_API_KEY}&text=${encodeURIComponent(message)}`;

  try {
    const response = await fetch(url);
    if (response.ok) {
      console.log("💬 [MESSENGER] Đã gửi tin nhắn cảnh báo quá nhiệt thành công qua Facebook Messenger!");
      lastAlertTime = Date.now();
    } else {
      const errText = await response.text();
      console.error("❌ [MESSENGER] Lỗi phản hồi từ dịch vụ CallMeBot:", errText);
    }
  } catch (error) {
    console.error("❌ [MESSENGER] Lỗi kết nối đường truyền khi gửi tin nhắn:", error);
  }
}

// ==========================================
//    1. KẾT NỐI GOOGLE SHEETS
// ==========================================
let doc;
let sheet;

async function initSheets() {
  try {
    const keysPath = path.join(__dirname, 'service-account.json');
    if (!fs.existsSync(keysPath)) {
      console.warn("⚠️ Không tìm thấy service-account.json. Bỏ qua ghi Sheets.");
      return;
    }
    
    const creds = require('./service-account.json');
    const serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo(); 
    sheet = doc.sheetsByIndex[0];
    console.log(`✅ [DATABASE] Đã kết nối Sheets: "${doc.title}"`);
    console.log(`📌 Lưu ý: Đảm bảo ô A1=Timestamp, B1=Temperature, C1=Humidity`);
  } catch (error) {
    console.error("❌ [DATABASE] Lỗi kết nối Sheets:", error);
  }
}
initSheets();

// ==========================================
//    2. KẾT NỐI WEBSOCKET (Dành cho Dashboard)
// ==========================================
wss.on('connection', (ws) => {
  console.log('🔗 [WS] Trình duyệt web vừa kết nối');
  ws.send(JSON.stringify({ type: 'status', message: 'Connected to Render Backend' }));
});

function broadcastWS(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ==========================================
//    3. KẾT NỐI HIVEMQ CLOUD & XỬ LÝ DỮ LIỆU
// ==========================================
const mqttUrl = `mqtts://${process.env.HIVEMQ_HOST}:8883`;
const mqttClient = mqtt.connect(mqttUrl, {
  username: process.env.HIVEMQ_USERNAME,
  password: process.env.HIVEMQ_PASSWORD,
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  console.log('🚀 [MQTT] Đã kết nối trạm HiveMQ Cloud thành công!');
  mqttClient.subscribe('nhakho/telemetry');
  mqttClient.subscribe('nhakho/recovery');
  broadcastWS({ type: 'mqtt_status', connected: true });
});

mqttClient.on('error', (err) => {
  console.error('❌ [MQTT] Lỗi Broker:', err);
});

mqttClient.on('message', async (topic, payload) => {
  try {
    const msgStr = payload.toString();
    console.log(`📩 [MQTT] Nhận từ (${topic}): ${msgStr}`);
    const data = JSON.parse(msgStr);

    let timestamp = Date.now(); // Mặc định lấy giờ Server (mili-giây)
    let isRecovery = false;

    // XỬ LÝ PHỤC HỒI DỮ LIỆU "HỐ ĐEN"
    if (topic === 'nhakho/recovery') {
      isRecovery = true;
      // QUAN TRỌNG: Đổi từ giây (ESP32) sang mili-giây (JS) để tránh lỗi hiển thị năm 1970
      if (data.timestamp) {
        timestamp = Number(data.timestamp) * 1000;
      }
    }

    const timeStr = new Date(timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    // Ghi vào Google Sheets
    if (sheet && data.temp != null && data.hum != null) {
      sheet.addRow({
        Timestamp: timeStr + (isRecovery ? ' [RECOVERY]' : ''),
        Temperature: data.temp,
        Humidity: data.hum
      }).then(() => {
        console.log(`📝 [SHEETS] Đã lưu -> T: ${data.temp}°C | H: ${data.hum}%`);
      }).catch(err => {
        console.error('❌ [SHEETS] Lỗi ghi dòng. Hãy kiểm tra tên cột A1, B1, C1!', err);
      });
    }

    // KIỂM TRA BÁO ĐỘNG FACEBOOK MESSENGER (Chỉ áp dụng khi dữ liệu là Live thời gian thực)
    if (!isRecovery && data.temp != null && data.temp > TEMP_ALARM_THRESHOLD) {
      sendMessengerAlert(data.temp, data.hum, timeStr);
    }

    // Cập nhật lên giao diện Web realtime
    broadcastWS({
      type: 'telemetry',
      temp: data.temp,
      hum: data.hum,
      time: timeStr,
      isRecovery: isRecovery
    });

  } catch (err) {
    console.error('❌ [MQTT] Lỗi xử lý gói tin:', err);
  }
});

// ==========================================
//    4. API ĐIỀU KHIỂN TỪ XA (OTA & RESET)
// ==========================================
app.post('/api/command', (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: 'Thiếu lệnh' });

  let payload = {};
  
  if (cmd === 'UPDATE_FIRMWARE') {
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    // Link tải firmware tự động dựa trên tên miền Render của bạn
    const otaUrl = `${protocol}://${host}/ota/firmware.bin`;
    
    payload = { cmd: 'UPDATE_FIRMWARE', url: otaUrl };
    console.log(`⚙️ [CMD] Phát lệnh OTA. Link: ${otaUrl}`);
  } else if (cmd === 'RESET_WIFI') {
    payload = { cmd: 'RESET_WIFI' };
    console.log("⚙️ [CMD] Phát lệnh xóa cấu hình WiFi trên ESP32");
  }

  mqttClient.publish('nhakho/cmd', JSON.stringify(payload), (err) => {
    if (err) return res.status(500).json({ error: 'Lỗi gửi MQTT' });
    res.json({ success: true, message: 'Đã phát lệnh thành công', payload });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🏢 [SERVER] Hệ thống vận hành tại cổng ${PORT}`);
});