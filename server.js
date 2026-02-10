import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ===== ENV VARS (set these in Render) =====
const DAILY_API_KEY = process.env.DAILY_API_KEY;          // Keep secret
const REVEI_SECRET  = process.env.REVEI_SHARED_SECRET;    // Shared secret between WP server and Render

function requireEnv() {
  const missing = [];
  if (!DAILY_API_KEY) missing.push("DAILY_API_KEY");
  if (!REVEI_SECRET) missing.push("REVEI_SHARED_SECRET");
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Server-to-server auth (ONLY WordPress should call this)
function checkSecret(req) {
  const s = req.headers["x-revei-secret"];
  return s && s === REVEI_SECRET;
}

/**
 * POST /create-room
 * Body: { sid: "MIS-XXXX", minutes: 15, candidate_name: "Wasim" }
 * Returns: { join_url, room_url, room_name, recording }
 */
app.post("/create-room", async (req, res) => {
  try {
    requireEnv();
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const sid = String(req.body?.sid || "").trim();
    const minutes = Number(req.body?.minutes || 15);
    const candidateNameRaw = String(req.body?.candidate_name || "").trim();

    if (!sid) return res.status(400).json({ error: "sid_required" });
    if (![15, 30].includes(minutes)) return res.status(400).json({ error: "minutes_must_be_15_or_30" });

    // Safe display name (Daily UI)
    const candidateName = (candidateNameRaw || "Candidate").slice(0, 60);

    const roomName = `mock-${sid}`.toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 60);

    // 1) Create private room
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
    max_participants: 4,

    // ✅ THIS IS THE KEY PART
    enable_cloud_recording: true,
    start_cloud_recording_on_join: true,
    cloud_recording_mode: "cloud" // full audio+video mp4
  }
})
    });

    // If room exists, fetch it
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

    // 2) Start cloud recording (MVP: start now)
    const startRecResp = await fetch(`https://api.daily.co/v1/rooms/${roomName}/recordings/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DAILY_API_KEY}`
      },
      body: JSON.stringify({})
    });

    const recData = await startRecResp.json();

    // 3) Create meeting token INCLUDING user_name so Daily won't ask for name
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
          exp: Math.floor(Date.now() / 1000) + (60 * 60), // token valid 60 min
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
