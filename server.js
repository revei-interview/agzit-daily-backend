import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const REVEI_SECRET  = process.env.REVEI_SHARED_SECRET;

function requireEnv() {
  const missing = [];
  if (!DAILY_API_KEY) missing.push("DAILY_API_KEY");
  if (!REVEI_SECRET) missing.push("REVEI_SHARED_SECRET");
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

app.get("/health", (req, res) => res.json({ ok: true }));

function checkSecret(req) {
  const s = req.headers["x-revei-secret"];
  return s && s === REVEI_SECRET;
}

app.post("/create-room", async (req, res) => {
  try {
    requireEnv();
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const sid = String(req.body?.sid || "").trim();
    const minutes = Number(req.body?.minutes || 15);
    const candidateNameRaw = String(req.body?.candidate_name || "").trim();

    if (!sid) return res.status(400).json({ error: "sid_required" });
    if (![15, 30].includes(minutes)) return res.status(400).json({ error: "minutes_must_be_15_or_30" });

    const candidateName = (candidateNameRaw || "Candidate").slice(0, 60);
    const roomName = `mock-${sid}`.toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 60);

    // ✅ Create private room with cloud recording enabled at ROOM level
    // Daily: enable_recording = "cloud" at room level
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
          exp: Math.floor(Date.now() / 1000) + (60 * 60), // room expires in 1 hour
          max_participants: 4,
          enable_recording: "cloud"
        }
      })
    });

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

    // ✅ Create meeting token:
    // - user_name sets the display name (no prompt)
    // - enable_recording:"cloud" allows recording controls for this participant
    // - start_cloud_recording:true auto-starts recording when they join
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

    const tokenData = await tokenResp.json();
    if (!tokenData?.token) {
      return res.status(500).json({ error: "meeting_token_failed", details: tokenData });
    }

    const joinUrl = `${roomData.url}?t=${encodeURIComponent(tokenData.token)}`;

    // Fetch latest recording for this room (may be processing)
const recListResp = await fetch(
  `https://api.daily.co/v1/recordings?room_name=${encodeURIComponent(roomName)}`,
  {
    headers: { Authorization: `Bearer ${DAILY_API_KEY}` }
  }
);

const recList = await recListResp.json();
const latestRecording = Array.isArray(recList?.data) && recList.data.length
  ? recList.data[0]
  : null;

return res.json({
  room_name: roomName,
  room_url: roomData.url,
  join_url: joinUrl,
  recording_id: latestRecording ? latestRecording.id : null
});


  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
