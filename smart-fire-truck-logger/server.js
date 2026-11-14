const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

// ตั้งค่า Environment Variables บน Render:
// 1. SPREADSHEET_ID : รหัส Spreadsheet ID จาก URL ของ Google Sheets
// 2. GOOGLE_SERVICE_ACCOUNT_EMAIL : client_email จากไฟล์ JSON
// 3. GOOGLE_PRIVATE_KEY : private_key จากไฟล์ JSON
// 4. API_KEY : รหัสลับสำหรับยืนยันตัวตนจาก ESP32 (เช่น IEE_SUT_FIRETRUCK_2025)

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const API_KEY = process.env.API_KEY || 'IEE_SUT_FIRETRUCK_2025';

function getSheetsClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

function formatThaiTimestamp(dateObj = new Date()) {
  return dateObj.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
}

function classifyRssi(rssi) {
  if (rssi >= -65) return 'STRONG (ปกติ)';
  if (rssi >= -78) return 'WEAK (เริ่มอ่อน)';
  return 'DEAD_ZONE_RISK (เสี่ยงอับสัญญาณ!)';
}

function classifyHardwareTemp(dhtTemp, espTemp) {
  const maxHw = Math.max(dhtTemp || 0, espTemp || 0);
  if (maxHw >= 65) return 'OVERHEAT_ALERT (ร้อนจัด!)';
  if (maxHw >= 50) return 'WARM (สะสมความร้อน)';
  return 'NORMAL (ปกติ)';
}

// 1. Endpoint บันทึกประวัติการพบเพลิงไหม้ (Incident Logs)
app.post('/api/incident', async (req, res) => {
  try {
    if (req.headers['x-api-key'] !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized API Key' });
    }

    const {
      durationSec = 0,
      thresholdTemp = 80.0,
      peakTemp = 0,
      targetX = 16,
      targetY = 12,
      distanceM = 0,
      valveCycles = 0
    } = req.body;

    const endMs = Date.now();
    const startMs = endMs - Math.round(Number(durationSec) * 1000);

    const startTimeStr = formatThaiTimestamp(new Date(startMs));
    const endTimeStr = formatThaiTimestamp(new Date(endMs));

    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Incident_Logs!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          startTimeStr,
          endTimeStr,
          Number(durationSec).toFixed(1),
          Number(thresholdTemp).toFixed(1),
          Number(peakTemp).toFixed(1),
          `X:${targetX}, Y:${targetY}`,
          Number(distanceM).toFixed(2),
          Number(valveCycles)
        ]]
      }
    });

    res.status(200).json({ status: 'logged_incident', durationSec, peakTemp });
  } catch (err) {
    console.error('Incident Log Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Endpoint บันทึกค่าสุขภาพฮาร์ดแวร์และสัญญาณ WiFi (Telemetry Logs)
app.post('/api/telemetry', async (req, res) => {
  try {
    if (req.headers['x-api-key'] !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized API Key' });
    }

    const {
      rssi = -100,
      dhtTemp = 0,
      dhtHum = 0,
      espTemp = 0,
      valveCycles = 0,
      cameraMaxTemp = 0
    } = req.body;

    const timestampStr = formatThaiTimestamp();
    const signalQuality = classifyRssi(Number(rssi));
    const hwStatus = classifyHardwareTemp(Number(dhtTemp), Number(espTemp));

    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Telemetry_Logs!A:I',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          timestampStr,
          Number(rssi),
          signalQuality,
          Number(dhtTemp).toFixed(1),
          Number(dhtHum).toFixed(1),
          Number(espTemp).toFixed(1),
          hwStatus,
          Number(valveCycles),
          Number(cameraMaxTemp).toFixed(1)
        ]]
      }
    });

    res.status(200).json({ status: 'logged_telemetry', signalQuality, hwStatus });
  } catch (err) {
    console.error('Telemetry Log Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('SMART FIRE TRUCK — Google Sheets Logger API is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Logger API listening on port ${PORT}`);
});