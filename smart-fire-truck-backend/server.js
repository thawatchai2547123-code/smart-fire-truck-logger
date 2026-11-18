require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const API_KEY = process.env.API_KEY || 'SUT_FIRE_TRUCK_2025';

// แปลงเวลาปัจจุบันเป็นเวลาประเทศไทย (Asia/Bangkok: YYYY-MM-DD HH:mm:ss)
function getThaiTimestamp(customEpochMs) {
  const d = customEpochMs ? new Date(customEpochMs) : new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
}

// เชื่อมต่อ Google Sheets API ด้วย Service Account
function getSheetsClient() {
  let credentials;
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  } else {
    credentials = {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    };
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

// ตรวจสอบและสร้างแผ่นงาน Incident_Logs และ Telemetry_Logs พร้อมหัวตารางอัตโนมัติ
let sheetsInitialized = false;
async function ensureSheetsAndHeaders(sheets) {
  if (sheetsInitialized || !SPREADSHEET_ID) return;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingTitles = meta.data.sheets.map((s) => s.properties.title);
  const requests = [];

  if (!existingTitles.includes('Incident_Logs')) {
    requests.push({ addSheet: { properties: { title: 'Incident_Logs' } } });
  }
  if (!existingTitles.includes('Telemetry_Logs')) {
    requests.push({ addSheet: { properties: { title: 'Telemetry_Logs' } } });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests }
    });
  }

  // เช็กและใส่หัวตารางแผ่นงานที่ 1: Incident_Logs
  const incCheck = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Incident_Logs!A1:H1'
  });
  if (!incCheck.data.values || incCheck.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Incident_Logs!A1:H1',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          'Detected Timestamp',
          'Extinguished Timestamp',
          'Duration (Seconds)',
          'Fire Threshold (°C)',
          'Peak Fire Temp (°C)',
          'Target Angle (X, Y)',
          'CH5 Spray Activated',
          'Total Valve Cycles'
        ]]
      }
    });
  }

  // เช็กและใส่หัวตารางแผ่นงานที่ 2: Telemetry_Logs
  const telCheck = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Telemetry_Logs!A1:K1'
  });
  if (!telCheck.data.values || telCheck.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Telemetry_Logs!A1:K1',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          'Timestamp',
          'DM542 Valve Cycles',
          'Valve State',
          'Wi-Fi RSSI (dBm)',
          'Signal Quality',
          'Engine Temp DHT22 (°C)',
          'Engine Humidity (%RH)',
          'Buzzer Overheat Alarm',
          'Voltage (V)',
          'Current (A)',
          'Power (W)'
        ]]
      }
    });
  }

  sheetsInitialized = true;
  console.log('[OK] Google Sheets tabs & headers verified.');
}

// แปลผลคุณภาพสัญญาณ Wi-Fi RSSI เพื่อหาจุดอับสัญญาณ (Dead Zone)
function evaluateRssiQuality(rssi) {
  const val = Number(rssi);
  if (isNaN(val)) return 'UNKNOWN';
  if (val >= -65) return 'GOOD (สัญญาณดี)';
  if (val >= -78) return 'WEAK (เริ่มอ่อน)';
  return 'DEAD_ZONE_RISK (เสี่ยงจุดอับสัญญาณ!)';
}

// หน้าแรกสำหรับเช็กสถานะเซิร์ฟเวอร์
app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'SMART FIRE TRUCK — Google Sheets Logger API',
    timestamp: getThaiTimestamp()
  });
});

// Endpoint หลักสำหรับรับข้อมูลจาก ESP32 (POST /api/log)
app.post('/api/log', async (req, res) => {
  try {
    const clientKey = req.headers['x-api-key'] || req.body.apiKey;
    if (API_KEY && clientKey && clientKey !== API_KEY) {
      return res.status(403).json({ error: 'Invalid API Key' });
    }

    const sheets = getSheetsClient();
    await ensureSheetsAndHeaders(sheets);

    const body = req.body || {};
    const logType = (body.logType || 'telemetry').toLowerCase();
    const nowStr = getThaiTimestamp();

    if (logType === 'incident') {
      // บันทึกลงแผ่นงานที่ 1: Incident_Logs
      const durationSec = Number(body.durationSec || 0);
      const detectedTimeStr = durationSec > 0
        ? getThaiTimestamp(Date.now() - Math.round(durationSec * 1000))
        : (body.detectedAt || nowStr);

      const row = [
        detectedTimeStr,
        nowStr,
        durationSec.toFixed(1),
        Number(body.fireThreshold || 80.0).toFixed(1),
        Number(body.peakTemp || 0.0).toFixed(1),
        `X:${body.targetAngleX ?? 90}°, Y:${body.targetAngleY ?? 90}°`,
        body.ch5Sprayed ? 'YES (ฉีดน้ำดับเพลิง)' : 'NO',
        Number(body.valveCycles || 0)
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Incident_Logs!A:H',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] }
      });

      return res.status(200).json({ ok: true, sheet: 'Incident_Logs', row });
    } else {
      // บันทึกลงแผ่นงานที่ 2: Telemetry_Logs
      const rssiVal = Number(body.rssi ?? -55);
      const voltageVal = Number(body.voltage ?? 0);
      const currentVal = Number(body.current ?? 0);
      const powerVal = body.power !== undefined
        ? Number(body.power)
        : (voltageVal * currentVal);

      const row = [
        nowStr,
        Number(body.valveCycles || 0),
        body.valveState || 'CLOSED',
        rssiVal,
        evaluateRssiQuality(rssiVal),
        Number(body.dhtTemp ?? 0).toFixed(1),
        Number(body.dhtHum ?? 0).toFixed(1),
        body.buzzerAlarm ? 'OVERHEAT_ALARM!' : 'NORMAL',
        voltageVal.toFixed(2),
        currentVal.toFixed(2),
        powerVal.toFixed(1)
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Telemetry_Logs!A:K',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] }
      });

      return res.status(200).json({ ok: true, sheet: 'Telemetry_Logs', row });
    }
  } catch (err) {
    console.error('[ERROR /api/log]:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SMART FIRE TRUCK Logger API running on port ${PORT}`);
});