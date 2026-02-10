import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ===== ENV VARS (set these in Render) =====
const DAILY_API_KEY = process.env.DAILY_API_KEY;          // NEW key (don’t expose)
const DAILY_DOMAIN  = process.env.DAILY_DOMAIN;           // https://agzit.daily.co
const REVEI_SECRET  = process.env.REVEI_SHARED_SECRET;    // your shared secret

function requireEnv() {
  const missing = [];
  if (!DAILY_API_KEY) missing.push("DAILY_API_KEY");
  if (!DAILY_DOMAIN) missing.push("DAILY_DOMAIN");
  if (!REVEI_SECRET) missing.push("REVEI_SHARED_SECRET");
  if (missing.length) {
    throw new Error("Missing env vars: " + missing.join(", "));
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

// Simple auth for server-to-server calls (frontend will call this; keep it basic for MVP)
// Send header: x-revei-secret: <secret>
function checkSecret(req) {
  const s = req.headers["x-revei-secret"];
  return s && s === REVEI_SECRET;
}

// 1) Create a Daily room
// Body: { sid: "MIS-XXXX", minutes: 15 }
app.post("/create-room", async (req, res) => {
  try {
    requireEnv();
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const sid = String(req.body?.sid || "").trim();
    const minutes = Number(req.body?.minutes || 15);

    if (!sid) return res.status(400).json({ error: "sid_required" });
    const roomName = `mock-${sid}`.toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 60);

    // Create a private room
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
          exp: Math.floor(Date.now() / 1000) + (60 * 60), // 1 hour expiry
          max_participants: 2
        }
      })
    });

    // If room already exists, Daily returns 409. We’ll fetch it.
    let roomData;
    if (createRoomResp.status === 409) {
      const getRoomResp = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
        headers: { Authorization: `Bearer ${DAILY_API_KEY}` }
      });
      roomData = await getRoomResp.json();
    } else {
      roomData = await createRoomResp.json();
    }

    if (!roomData?.url) {
      return res.status(500).json({ error: "daily_room_failed", details: roomData });
    }

    // 2) Start cloud recording
    // Daily docs: POST /rooms/:name/recordings/start :contentReference[oaicite:1]{index=1}
    const startRecResp = await fetch(`https://api.daily.co/v1/rooms/${roomName}/recordings/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DAILY_API_KEY}`
      },
      body: JSON.stringify({
        // default "cloud" recording; keep it simple for MVP
        // layout can be configured later
      })
    });

    const recData = await startRecResp.json();

// Create a meeting token so user can join private room
const tokenResp = await fetch("https://api.daily.co/v1/meeting-tokens", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DAILY_API_KEY}`
  },
  body: JSON.stringify({
    properties: {
      room_name: roomName,
      exp: Math.floor(Date.now() / 1000) + (60 * 15), // 15 min
      eject_at_token_exp: true
    }
  })
});

const tokenData = await tokenResp.json();

if (!tokenData?.token) {
  return res.status(500).json({ error: "meeting_token_failed", details: tokenData });
}

const joinUrl = `${roomData.url}?t=${encodeURIComponent(tokenData.token)}`;

return res.json({
  room_name: roomName,
  room_url: roomData.url,
  join_url: joinUrl,
  recording: recData
});
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

// 3) Stop recording (we’ll later fetch mp4 link)
// Body: { sid: "MIS-XXXX", recording_id: "rec_..." }
app.post("/stop-recording", async (req, res) => {
  try {
    requireEnv();
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const roomName = String(req.body?.room_name || "").trim();
    const recordingId = String(req.body?.recording_id || "").trim();

    if (!roomName || !recordingId) {
      return res.status(400).json({ error: "room_name_and_recording_id_required" });
    }

    // Stop: POST /rooms/:name/recordings/:recordingId/stop (see Recordings endpoints) :contentReference[oaicite:2]{index=2}
    const stopResp = await fetch(`https://api.daily.co/v1/rooms/${roomName}/recordings/${recordingId}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DAILY_API_KEY}` }
    });

    const stopData = await stopResp.json();
    return res.json({ ok: true, stop: stopData });
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
