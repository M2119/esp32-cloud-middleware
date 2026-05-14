require('dotenv').config();
const express = require('express');
const mqtt = require('mqtt');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const multer = require('multer');
const cron = require('node-cron');
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

// --- CẤU HÌNH MULTER (SỬ DỤNG BỘ NHỚ ĐỂ ĐẨY LÊN GITHUB) ---
// Vì Render xóa file local khi restart, ta không dùng diskStorage nữa
const upload = multer({ storage: multer.memoryStorage() });

// --- KẾT NỐI GOOGLE SHEETS ---
const serviceAccountAuth = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

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
        const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const suffix = (topic === 'nhakho/recovery') ? ' [Recovery]' : '';
        
        io.emit('mqttData', { ...data, time: timestamp.split(' ')[0] });

        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Data'];
        await sheet.addRow({
            Timestamp: `${timestamp}${suffix}`,
            Temperature: data.temp.toFixed(1).replace('.', ','),
            Humidity: data.hum.toFixed(1).replace('.', ',')
        });
    } catch (err) {
        console.error('Lỗi xử lý bản ghi MQTT:', err);
    }
});

// --- NODE-CRON: TỰ ĐỘNG TÍNH TOÁN TRUNG BÌNH (MỖI 30 PHÚT) ---
cron.schedule('*/30 * * * *', async () => {
    console.log('Đang chạy tác vụ tính toán trung bình ngầm...');
    try {
        await doc.loadInfo();
        const dataSheet = doc.sheetsByTitle['Data'];
        const summarySheet = doc.sheetsByTitle['Summary'];
        const rows = await dataSheet.getRows();

        const calculateAvg = (minutes) => {
            const now = new Date();
            const filtered = rows.filter(r => {
                const timestampField = r.get('Timestamp');
                if (!timestampField) return false;
                
                const timeStr = timestampField.split(' [')[0]; 
                const [time, date] = timeStr.split(' ');
                const [d, m, y] = date.split('/');
                const dateObj = new Date(`${y}-${m}-${d}T${time}`);
                
                return (now - dateObj) <= (minutes * 60000);
            });

            if (filtered.length === 0) return null;

            const sumT = filtered.reduce((acc, r) => acc + parseFloat(r.get('Temperature').replace(',', '.')), 0);
            const sumH = filtered.reduce((acc, r) => acc + parseFloat(r.get('Humidity').replace(',', '.')), 0);
            
            return {
                avgT: (sumT / filtered.length).toFixed(1),
                avgH: (sumH / filtered.length).toFixed(1),
                points: filtered.length
            };
        };

        const types = [
            { name: '30p', min: 30 },
            { name: '1Day', min: 1440 },
            { name: '1Week', min: 10080 },
            { name: '1Month', min: 43200 }
        ];

        const currentTime = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        for (const t of types) {
            const res = calculateAvg(t.min);
            if (res) {
                await summarySheet.addRow({
                    Type: t.name,
                    Timestamp: currentTime,
                    AvgTemperature: res.avgT.replace('.', ','),
                    AvgHumidity: res.avgH.replace('.', ','),
                    DataPoints: res.points
                });
            }
        }
    } catch (err) {
        console.error('Lỗi tính toán Node-cron:', err);
    }
});

// --- API ROUTES ---

app.use(express.static('public'));

// XỬ LÝ UPLOAD OTA TỪ XA QUA GITHUB API
app.post('/upload-ota', upload.single('firmware'), async (req, res) => {
    if (!req.file) return res.status(400).send('Không tìm thấy file firmware tải lên.');

    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const targetPath = 'public/ota/firmware.bin';

    if (!token || !owner || !repo) {
        return res.status(500).send('Chưa cấu hình thông tin Token hoặc Repo GitHub trong file .env');
    }

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${targetPath}`;
    const fileBase64 = req.file.buffer.toString('base64'); // Chuyển đổi nhị phân sang Base64
    let fileSha = null;

    try {
        // Bước 1: Gọi API kiểm tra xem file firmware.bin đã tồn tại trên repo chưa để lấy SHA
        const getRes = await fetch(`${apiUrl}?ref=${branch}`, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'NodeJS-OTA-Uploader'
            }
        });

        if (getRes.ok) {
            const fileData = await getRes.json();
            fileSha = fileData.sha; // Lấy SHA nếu file cần được ghi đè
        }

        // Bước 2: Commit và ghi đè file mới lên GitHub
        const putPayload = {
            message: `Cập nhật Firmware OTA từ xa lúc ${new Date().toLocaleTimeString('vi-VN')}`,
            content: fileBase64,
            branch: branch
        };
        if (fileSha) putPayload.sha = fileSha; // Bắt buộc phải có SHA cũ nếu ghi đè

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

        if (!putRes.ok) {
            const errorDetails = await putRes.text();
            throw new Error(`GitHub API từ chối cập nhật: ${errorDetails}`);
        }

        // Bước 3: Phát lệnh nạp trực tiếp qua liên kết Raw siêu tốc của GitHub
        const rawOtaUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${targetPath}`;
        client.publish('nhakho/cmd', JSON.stringify({ cmd: "UPDATE_FIRMWARE", url: rawOtaUrl }));

        res.send('Tải file lên GitHub thành công! Đã phát lệnh cập nhật OTA tự động.');
    } catch (err) {
        console.error('Lỗi quy trình OTA Remote:', err);
        res.status(500).send(`Lỗi đẩy file lên GitHub: ${err.message}`);
    }
});

// Lấy 100 dòng mới nhất
app.get('/api/history-100', async (req, res) => {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Data'];
        const rows = await sheet.getRows({ offset: Math.max(0, sheet.rowCount - 101) });
        const data = rows.map(r => ({
            time: r.get('Timestamp').split(' ')[0],
            temp: parseFloat(r.get('Temperature').replace(',', '.')),
            hum: parseFloat(r.get('Humidity').replace(',', '.'))
        }));
        res.json(data);
    } catch (err) {
        res.status(500).send('Lỗi truy xuất dữ liệu 100 dòng.');
    }
});

// Lấy thống kê Summary
app.get('/api/summary/:type', async (req, res) => {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Summary'];
        const rows = await sheet.getRows();
        const filtered = rows.filter(r => r.get('Type') === req.params.type).slice(-20);
        const data = filtered.map(r => ({
            time: r.get('Timestamp').split(' ')[0],
            temp: parseFloat(r.get('AvgTemperature').replace(',', '.')),
            hum: parseFloat(r.get('AvgHumidity').replace(',', '.'))
        }));
        res.json(data);
    } catch (err) {
        res.status(500).send('Lỗi truy xuất dữ liệu tổng hợp.');
    }
});

server.listen(PORT, () => console.log(`Server Render đang chạy tại Port ${PORT}`));