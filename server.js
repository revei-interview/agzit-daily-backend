import express from "express";
import cors from "cors";
import crypto from "crypto";

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

function hmacSig(message) {
  return crypto.createHmac("sha256", REVEI_SECRET).update(message).digest("hex");
}

function safeEqual(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * POST /create-room
 * Body: { sid, minutes, candidate_name }
 * Returns: { room_name, room_url, join_url }
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

    // Robust “room already exists” detection
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

    // Token auto-start cloud recording on join + sets name
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
 * GET /latest-recording?room_name=mock-mis-xxxx
 * Returns: { ok:true, recording_id, status }
 */
app.get("/latest-recording", async (req, res) => {
  try {
    requireEnv();
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

/**
 * GET /recording-link?recording_id=XXXX   (SERVER-TO-SERVER ONLY)
 * Requires x-revei-secret header
 * Returns: { ok:true, mp4_url, expires }
 */
app.get("/recording-link", async (req, res) => {
  try {
    requireEnv();
    if (!checkSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const recordingId = String(req.query?.recording_id || "").trim();
    if (!recordingId) return res.status(400).json({ error: "recording_id_required" });

    const resp = await fetch(
      `https://api.daily.co/v1/recordings/${encodeURIComponent(recordingId)}/access-link`,
      { headers: { Authorization: `Bearer ${DAILY_API_KEY}` } }
    );

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(500).json({ error: "daily_access_link_failed", details: data });

    if (data?.download_link) {
      return res.json({ ok: true, mp4_url: data.download_link, expires: data.expires || null });
    }

    return res.json({ ok: false, status: "processing", details: data });
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

/**
 * ✅ NEW: GET /stream-recording?recording_id=...&exp=...&sig=...
 * Browser-safe streaming endpoint:
 * - No secret header needed
 * - WordPress signs URL (HMAC) so only legit users can stream for short time
 * - Streams MP4 with inline disposition (plays in browser)
 */
app.get("/stream-recording", async (req, res) => {
  try {
    requireEnv();

    const recordingId = String(req.query?.recording_id || "").trim();
    const exp = String(req.query?.exp || "").trim();
    const sig = String(req.query?.sig || "").trim();

    if (!recordingId || !exp || !sig) {
      return res.status(400).json({ error: "missing_params" });
    }

    const expNum = Number(exp);
    const now = Math.floor(Date.now() / 1000);

    if (!Number.isFinite(expNum) || expNum < now) {
      return res.status(401).json({ error: "expired" });
    }

    const message = `${recordingId}|${expNum}`;
    const expected = hmacSig(message);

    if (!safeEqual(expected, sig)) {
      return res.status(401).json({ error: "bad_signature" });
    }

    // Get fresh Daily download link
    const resp = await fetch(
      `https://api.daily.co/v1/recordings/${encodeURIComponent(recordingId)}/access-link`,
      { headers: { Authorization: `Bearer ${DAILY_API_KEY}` } }
    );

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(500).json({ error: "daily_access_link_failed", details: data });

    const url = data?.download_link;
    if (!url) {
      return res.status(202).json({ ok: false, status: "processing" });
    }

    // Fetch MP4 and stream it inline
    const mp4Resp = await fetch(url);
    if (!mp4Resp.ok || !mp4Resp.body) {
      return res.status(502).json({ error: "mp4_fetch_failed" });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="mock-interview.mp4"');
    res.setHeader("Cache-Control", "no-store");

    // Pipe stream
    mp4Resp.body.pipe(res);

  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
