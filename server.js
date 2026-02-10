import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===== ENV VARS (set in Render) =====
const DAILY_API_KEY = process.env.DAILY_API_KEY;
const REVEI_SECRET  = process.env.REVEI_SHARED_SECRET;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

function requireEnv(keys = []) {
  const missing = [];
  for (const k of keys) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

// Server-to-server auth (ONLY WP should call these)
function checkSecret(req) {
  const s = req.headers["x-revei-secret"];
  return s && s === REVEI_SECRET;
}

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * =========================
 * DAILY: CREATE ROOM + TOKEN
 * =========================
 */
app.post("/create-room", async (req, res) => {
  try {
    requireEnv(["DAILY_API_KEY", "REVEI_SHARED_SECRET"]);
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const sid = String(req.body?.sid || "").trim();
    const minutes = Number(req.body?.minutes || 15);
    const candidateNameRaw = String(req.body?.candidate_name || "").trim();

    if (!sid) return res.status(400).json({ error: "sid_required" });
    if (![15, 30].includes(minutes)) return res.status(400).json({ error: "minutes_must_be_15_or_30" });

    const candidateName = (candidateNameRaw || "Candidate").slice(0, 60);
    const roomName = `mock-${sid}`.toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 60);

    const createRoomResp = await fetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DAILY_API_KEY}`
      },
      body: JSON.stringify({
        name: roomName,
        privacy: "private",
        properties: {
          exp: Math.floor(Date.now() / 1000) + (60 * 60),
          max_participants: 4,
          enable_recording: "cloud"
        }
      })
    });

    const createJson = await createRoomResp.json().catch(() => ({}));

    let roomData = null;
    const roomAlreadyExists =
      createRoomResp.status === 409 ||
      (createJson?.info && String(createJson.info).toLowerCase().includes("already exists"));

    if (roomAlreadyExists) {
      const getRoomResp = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
        headers: { Authorization: `Bearer ${DAILY_API_KEY}` }
      });
      roomData = await getRoomResp.json().catch(() => ({}));
    } else {
      roomData = createJson;
    }

    if (!roomData?.url) {
      return res.status(500).json({ error: "daily_room_failed", details: roomData });
    }

    const tokenResp = await fetch("https://api.daily.co/v1/meeting-tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DAILY_API_KEY}`
      },
      body: JSON.stringify({
        properties: {
          room_name: roomName,
          user_name: candidateName,
          exp: Math.floor(Date.now() / 1000) + (60 * 60),
          eject_at_token_exp: true,
          enable_recording: "cloud",
          start_cloud_recording: true
        }
      })
    });

    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenData?.token) {
      return res.status(500).json({ error: "meeting_token_failed", details: tokenData });
    }

    const joinUrl = `${roomData.url}?t=${encodeURIComponent(tokenData.token)}`;

    return res.json({
      room_name: roomName,
      room_url: roomData.url,
      join_url: joinUrl
    });

  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

/**
 * =========================
 * DAILY: RECORDINGS HELPERS
 * =========================
 */
app.get("/latest-recording", async (req, res) => {
  try {
    requireEnv(["DAILY_API_KEY", "REVEI_SHARED_SECRET"]);
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const roomName = String(req.query?.room_name || "").trim();
    if (!roomName) return res.status(400).json({ error: "room_name_required" });

    const recListResp = await fetch(
      `https://api.daily.co/v1/recordings?room_name=${encodeURIComponent(roomName)}`,
      { headers: { Authorization: `Bearer ${DAILY_API_KEY}` } }
    );

    const recList = await recListResp.json().catch(() => ({}));
    const latest = Array.isArray(recList?.data) && recList.data.length ? recList.data[0] : null;

    if (!latest?.id) {
      return res.json({ ok: true, recording_id: null, status: "not_found_yet" });
    }

    return res.json({ ok: true, recording_id: latest.id, status: latest.status || null });

  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

app.get("/recording-link", async (req, res) => {
  try {
    requireEnv(["DAILY_API_KEY", "REVEI_SHARED_SECRET"]);
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const recordingId = String(req.query?.recording_id || "").trim();
    if (!recordingId) return res.status(400).json({ error: "recording_id_required" });

    const resp = await fetch(
      `https://api.daily.co/v1/recordings/${encodeURIComponent(recordingId)}/access-link`,
      { headers: { Authorization: `Bearer ${DAILY_API_KEY}` } }
    );

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(500).json({ error: "daily_access_link_failed", details: data });

    const link = data?.link || data?.url || data?.download_link || "";
    if (!link) return res.status(500).json({ error: "mp4_link_missing", details: data });

    return res.json({
      ok: true,
      mp4_url: link,
      expires: data?.expires || null
    });

  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

/**
 * =========================
 * DEEPGRAM REALTIME: TOKEN
 * (WP calls this server-to-server; browser will not see secrets)
 * =========================
 * POST /stt/token  Header: x-revei-secret
 * Body: { sid: "MIS-xxxx" }
 * Returns: { ok:true, stt_token:"..." }
 */
const sttTokens = new Map(); // token -> {sid, exp}

function makeToken() {
  return "stt_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

app.post("/stt/token", async (req, res) => {
  try {
    requireEnv(["DEEPGRAM_API_KEY", "REVEI_SHARED_SECRET"]);
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const sid = String(req.body?.sid || "").trim();
    if (!sid) return res.status(400).json({ error: "sid_required" });

    const token = makeToken();
    const exp = Date.now() + (10 * 60 * 1000); // 10 minutes

    sttTokens.set(token, { sid, exp });

    // cleanup old tokens
    for (const [k, v] of sttTokens.entries()) {
      if (!v || v.exp < Date.now()) sttTokens.delete(k);
    }

    return res.json({ ok: true, stt_token: token, expires_in_sec: 600 });
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

/**
 * =========================
 * WebSocket: /stt/ws?token=stt_xxx
 *
 * Browser connects here and streams mic audio (we'll do this in WP step later).
 * Backend connects to Deepgram Realtime and relays transcripts back.
 * =========================
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stt/ws" });

wss.on("connection", async (clientWs, req) => {
  try {
    requireEnv(["DEEPGRAM_API_KEY"]);

    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token") || "";

    const t = sttTokens.get(token);
    if (!t || t.exp < Date.now()) {
      clientWs.send(JSON.stringify({ type: "error", error: "invalid_or_expired_token" }));
      clientWs.close();
      return;
    }

    // one-time use token (prevents sharing)
    sttTokens.delete(token);

    // Connect to Deepgram Realtime
    const dgUrl =
      "wss://api.deepgram.com/v1/listen" +
      "?model=nova-2" +
      "&language=en" +
      "&smart_format=true" +
      "&punctuate=true" +
      "&interim_results=true" +
      "&endpointing=250" +          // detects end-of-utterance quickly
      "&vad_events=true";

    const dgWs = new (await import("ws")).WebSocket(dgUrl, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
    });

    let dgOpen = false;

    dgWs.on("open", () => {
      dgOpen = true;
      clientWs.send(JSON.stringify({ type: "ready" }));
    });

    dgWs.on("message", (msg) => {
      // Forward Deepgram JSON to browser
      try {
        const data = JSON.parse(msg.toString());
        // Send only useful parts (still raw enough)
        clientWs.send(JSON.stringify({ type: "dg", data }));
      } catch {
        // ignore parse errors
      }
    });

    dgWs.on("close", () => {
      try { clientWs.close(); } catch {}
    });

    dgWs.on("error", (e) => {
      try {
        clientWs.send(JSON.stringify({ type: "error", error: "deepgram_ws_error" }));
      } catch {}
      try { clientWs.close(); } catch {}
    });

    // Browser -> Deepgram (binary audio)
    clientWs.on("message", (data) => {
      if (!dgOpen) return;
      // We expect raw audio bytes (we'll send proper format later from WP UI)
      dgWs.send(data);
    });

    clientWs.on("close", () => {
      try { dgWs.close(); } catch {}
    });

  } catch (e) {
    try {
      clientWs.send(JSON.stringify({ type: "error", error: "server_error", message: e.message }));
    } catch {}
    try { clientWs.close(); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
