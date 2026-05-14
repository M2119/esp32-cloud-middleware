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
        // Bỏ qua nếu bản tin Telemetry giống hệt bản tin trước đó trong vòng 45 giây
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

// --- NODE-CRON: TỰ ĐỘNG TÍNH TOÁN TRUNG BÌNH (MỖI 5 PHÚT ĐỂ TEST) ---
cron.schedule('*/5 * * * *', async () => {
    console.log('Đang chạy tác vụ tính Summary (Chu kỳ 5 phút)...');
    try {
        await doc.loadInfo();
        const dataSheet = doc.sheetsByTitle['Data'];
        const summarySheet = doc.sheetsByTitle['Summary'];
        
        if (!summarySheet) {
            console.error('Lỗi: Không tìm thấy Sheet mang tên "Summary".');
            return;
        }
        
        const rows = await dataSheet.getRows();

        const calculateAvg = (minutes) => {
            const now = new Date();
            const filtered = rows.filter(r => {
                const timestampField = r.get('Timestamp');
                const tempField = r.get('Temperature');
                const humField = r.get('Humidity');
                
                // BỘ LỌC VALIDATION: Loại bỏ hoàn toàn các dòng trống hoặc dữ liệu rác
                if (!timestampField || !tempField || !humField) return false;
                
                // Đảm bảo thông số chuyển đổi được sang số hợp lệ
                const tVal = parseFloat(tempField.replace(',', '.'));
                const hVal = parseFloat(humField.replace(',', '.'));
                if (isNaN(tVal) || isNaN(hVal)) return false;

                // Lọc theo mốc thời gian
                try {
                    const timeStr = timestampField.split(' [')[0]; 
                    const [time, date] = timeStr.split(' ');
                    const [d, m, y] = date.split('/');
                    const dateObj = new Date(`${y}-${m}-${d}T${time}`);
                    return (now - dateObj) <= (minutes * 60000);
                } catch (e) {
                    return false;
                }
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
        console.log('Ghi thành công dữ liệu vào Sheet Summary!');
    } catch (err) {
        console.error('Lỗi tính toán Node-cron Summary:', err);
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

server.listen(PORT, () => console.log(`Server Render đang chạy tại Port ${PORT}`));///