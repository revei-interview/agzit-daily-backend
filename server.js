<?php
/**
 * DPR Daily Join + Mark Finished + Attach Recording (NEW TAB + SAVE)
 * Shortcode: [dpr_daily_launcher]
 *
 * ACF repeater: mock_interview_sessions
 * Subfields required:
 * - session_id
 * - room_name
 * - recording_id
 * - audio_url          (label can be "Mock URL", name must stay audio_url)
 * - interview_status
 *
 * user_meta mapping:
 * - dpr_profile_post_id (user -> DPR Profile post ID)
 */

add_action('rest_api_init', function () {

  register_rest_route('dpr/v1', '/daily-join', [
    'methods'  => 'POST',
    'callback' => 'dpr_daily_join_handler',
    'permission_callback' => function () { return is_user_logged_in(); },
  ]);

  register_rest_route('dpr/v1', '/mark-finished', [
    'methods'  => 'POST',
    'callback' => 'dpr_mark_finished_handler',
    'permission_callback' => function () { return is_user_logged_in(); },
  ]);

  register_rest_route('dpr/v1', '/attach-recording', [
    'methods'  => 'POST',
    'callback' => 'dpr_attach_recording_handler',
    'permission_callback' => function () { return is_user_logged_in(); },
  ]);

});

function dpr_profile_post_id($user_id) {
  return (int) get_user_meta($user_id, 'dpr_profile_post_id', true);
}

function dpr_candidate_name($user_id) {
  $pid = dpr_profile_post_id($user_id);

  if ($pid > 0 && function_exists('get_field')) {
    $n = get_field('full_name', $pid);
    $n = is_string($n) ? trim($n) : '';
    if ($n) return $n;
  }

  $u = wp_get_current_user();
  return ($u && !empty($u->display_name)) ? (string) $u->display_name : 'Candidate';
}

function dpr_update_session_row($profile_post_id, $sid, $patch) {
  if (!function_exists('get_field') || !function_exists('update_field')) return false;

  $rows = get_field('mock_interview_sessions', $profile_post_id);
  if (!is_array($rows) || empty($rows)) return false;

  $sid = (string)$sid;

  foreach ($rows as $i => $row) {
    $row_sid = isset($row['session_id']) ? (string)$row['session_id'] : '';
    if ($row_sid === $sid) {
      foreach ($patch as $k => $v) {
        $rows[$i][$k] = $v;
      }
      update_field('mock_interview_sessions', $rows, $profile_post_id);
      return true;
    }
  }

  return false;
}

function dpr_render_post($path, $bodyArr) {
  $render_base   = 'https://agzit-daily-backend.onrender.com';
  $shared_secret = 'Wasim-Revei-Secret-09022026-29051993';

  $resp = wp_remote_post($render_base . $path, [
    'timeout' => 25,
    'headers' => [
      'Content-Type'   => 'application/json',
      'x-revei-secret' => $shared_secret,
    ],
    'body' => wp_json_encode($bodyArr),
  ]);

  if (is_wp_error($resp)) return [null, $resp->get_error_message()];

  $code = wp_remote_retrieve_response_code($resp);
  $json = json_decode(wp_remote_retrieve_body($resp), true);

  if ($code < 200 || $code >= 300) {
    return [null, $json ?: ['http_code' => $code]];
  }

  return [$json, null];
}

function dpr_render_get($pathWithQuery) {
  $render_base   = 'https://agzit-daily-backend.onrender.com';
  $shared_secret = 'Wasim-Revei-Secret-09022026-29051993';

  $resp = wp_remote_get($render_base . $pathWithQuery, [
    'timeout' => 25,
    'headers' => [
      'x-revei-secret' => $shared_secret,
    ],
  ]);

  if (is_wp_error($resp)) return [null, $resp->get_error_message()];

  $code = wp_remote_retrieve_response_code($resp);
  $json = json_decode(wp_remote_retrieve_body($resp), true);

  if ($code < 200 || $code >= 300) {
    return [null, $json ?: ['http_code' => $code]];
  }

  return [$json, null];
}

/** START interview */
function dpr_daily_join_handler(WP_REST_Request $req) {

  $sid     = sanitize_text_field($req->get_param('sid'));
  $minutes = intval($req->get_param('minutes'));
  if (!$sid) return new WP_REST_Response(['ok' => false, 'error' => 'sid_required'], 400);
  if (!in_array($minutes, [15, 30], true)) $minutes = 15;

  $user_id = get_current_user_id();
  $pid     = dpr_profile_post_id($user_id);
  if ($pid <= 0) return new WP_REST_Response(['ok' => false, 'error' => 'profile_not_linked'], 400);

  $name = dpr_candidate_name($user_id);

  list($data, $err) = dpr_render_post('/create-room', [
    'sid'            => $sid,
    'minutes'        => $minutes,
    'candidate_name' => $name,
  ]);

  if ($err || empty($data['join_url']) || empty($data['room_name'])) {
    return new WP_REST_Response(['ok' => false, 'error' => 'render_failed', 'details' => $err ?: $data], 500);
  }

  dpr_update_session_row($pid, $sid, [
    'room_name'        => (string)$data['room_name'],
    'interview_status' => 'in_progress',
  ]);

  return new WP_REST_Response(['ok' => true, 'join_url' => esc_url_raw($data['join_url'])], 200);
}

/** MARK finished (unblock next session) */
function dpr_mark_finished_handler(WP_REST_Request $req) {

  $sid = sanitize_text_field($req->get_param('sid'));
  if (!$sid) return new WP_REST_Response(['ok' => false, 'error' => 'sid_required'], 400);

  $user_id = get_current_user_id();
  $pid     = dpr_profile_post_id($user_id);
  if ($pid <= 0) return new WP_REST_Response(['ok' => false, 'error' => 'profile_not_linked'], 400);

  dpr_update_session_row($pid, $sid, [
    'interview_status' => 'completed_pending_recording',
  ]);

  delete_user_meta($user_id, 'mock_session_lock_until');
  delete_user_meta($user_id, 'mock_session_lock_id');

  return new WP_REST_Response(['ok' => true], 200);
}

/** ATTACH recording */
function dpr_attach_recording_handler(WP_REST_Request $req) {

  $sid = sanitize_text_field($req->get_param('sid'));
  if (!$sid) return new WP_REST_Response(['ok' => false, 'error' => 'sid_required'], 400);

  $user_id = get_current_user_id();
  $pid     = dpr_profile_post_id($user_id);
  if ($pid <= 0) return new WP_REST_Response(['ok' => false, 'error' => 'profile_not_linked'], 400);

  $rows = function_exists('get_field') ? get_field('mock_interview_sessions', $pid) : [];
  $room_name = '';

  if (is_array($rows)) {
    foreach ($rows as $row) {
      if ((string)($row['session_id'] ?? '') === (string)$sid) {
        $room_name = (string)($row['room_name'] ?? '');
        break;
      }
    }
  }

  if (!$room_name) {
    return new WP_REST_Response(['ok' => false, 'status' => 'processing', 'detail' => 'room_name_missing'], 200);
  }

  list($rec, $err) = dpr_render_get('/latest-recording?room_name=' . rawurlencode($room_name));
  if ($err) return new WP_REST_Response(['ok' => false, 'status' => 'processing', 'detail' => 'latest_recording_failed'], 200);

  $recording_id = (string)($rec['recording_id'] ?? '');
  if (!$recording_id) {
    return new WP_REST_Response(['ok' => false, 'status' => 'processing', 'detail' => 'recording_id_not_ready'], 200);
  }

  // Save recording_id immediately
  dpr_update_session_row($pid, $sid, [
    'recording_id' => $recording_id,
  ]);

  list($link, $err2) = dpr_render_get('/recording-link?recording_id=' . rawurlencode($recording_id));
  if ($err2) return new WP_REST_Response(['ok' => false, 'status' => 'processing', 'detail' => 'recording_link_not_ready'], 200);

  $mp4 = (string)($link['mp4_url'] ?? '');
  if (!$mp4) {
    return new WP_REST_Response(['ok' => false, 'status' => 'processing', 'detail' => 'mp4_not_ready'], 200);
  }

  dpr_update_session_row($pid, $sid, [
    'audio_url'        => $mp4,
    'interview_status' => 'completed',
  ]);

  return new WP_REST_Response(['ok' => true, 'recording_id' => $recording_id, 'mp4_url' => $mp4], 200);
}

/** UI Shortcode */
add_shortcode('dpr_daily_launcher', function () {

  if (!is_user_logged_in()) {
    return '<div style="max-width:720px;margin:40px auto;padding:16px;border:1px solid #eee;border-radius:12px;background:#fff;">Please log in to start the interview.</div>';
  }

  $join_url   = esc_url_raw(rest_url('dpr/v1/daily-join'));
  $done_url   = esc_url_raw(rest_url('dpr/v1/mark-finished'));
  $attach_url = esc_url_raw(rest_url('dpr/v1/attach-recording'));
  $nonce      = wp_create_nonce('wp_rest');

  ob_start(); ?>
  <div style="max-width:860px;margin:34px auto;padding:22px;border:1px solid #e8e8e8;border-radius:14px;background:#fff;box-shadow:0 10px 25px rgba(0,0,0,0.06);text-align:left;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
      <div>
        <div style="font-size:12px;color:#667085;letter-spacing:0.4px;text-transform:uppercase;">Agzit DPR</div>
        <h2 style="margin:6px 0 0;font-size:22px;line-height:1.25;">Mock Interview Room</h2>
        <div style="margin-top:6px;color:#475467;font-size:14px;">Your interview opens in a new tab. Come back here to save the recording.</div>
      </div>
      <div id="dpr-pill" style="padding:8px 12px;border-radius:999px;background:#f2f4f7;color:#344054;font-size:13px;">Status: Ready</div>
    </div>

    <div style="margin-top:16px;padding:14px;border-radius:12px;background:#f9fafb;border:1px solid #eef2f6;color:#344054;font-size:14px;line-height:1.5;">
      <b>Before you start:</b>
      <ul style="margin:8px 0 0 18px;">
        <li>Use Chrome for best results</li>
        <li>Allow camera + microphone permissions</li>
        <li>After finishing, come back and click <b>I’ve finished</b></li>
      </ul>
    </div>

    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;">
      <button id="dpr-start" style="padding:12px 16px;font-size:15px;border-radius:10px;background:#0a5cff;color:#fff;border:none;cursor:pointer;">
        🎥 Start Interview (opens new tab)
      </button>
      <button id="dpr-done" style="padding:12px 16px;font-size:15px;border-radius:10px;background:#111827;color:#fff;border:none;cursor:pointer;">
        ✅ I’ve finished (save recording)
      </button>
    </div>

    <div id="dpr-status" style="margin-top:14px;color:#475467;font-size:14px;"></div>

    <div id="dpr-replay-wrap" style="display:none;margin-top:14px;">
      <a id="dpr-replay" href="#" target="_blank" style="display:inline-block;padding:12px 16px;border-radius:10px;background:#16a34a;color:#fff;text-decoration:none;font-weight:600;">
        ⬇ Download Recording
      </a>
      <div style="margin-top:8px;color:#667085;font-size:12px;">Currently, Daily provides a download link. In the next phase, we’ll copy it to our own storage for in-browser playback.</div>
    </div>

    <div style="margin-top:14px;color:#98a2b3;font-size:12px;">We will check for the recording for up to 20 minutes.</div>
  </div>

  <script>
  (function(){
    const statusEl = document.getElementById('dpr-status');
    const pill = document.getElementById('dpr-pill');
    const btnStart = document.getElementById('dpr-start');
    const btnDone = document.getElementById('dpr-done');
    const replayWrap = document.getElementById('dpr-replay-wrap');
    const replayLink = document.getElementById('dpr-replay');

    const params = new URLSearchParams(window.location.search);
    const sid = params.get('sid');

    const JOIN_URL   = <?php echo json_encode($join_url); ?>;
    const DONE_URL   = <?php echo json_encode($done_url); ?>;
    const ATTACH_URL = <?php echo json_encode($attach_url); ?>;
    const NONCE      = <?php echo json_encode($nonce); ?>;

    function setPill(text){ pill.textContent = "Status: " + text; }
    function setMsg(msg){ statusEl.textContent = msg; }

    if (!sid) {
      setPill("Error");
      setMsg("Session ID missing in URL.");
      btnStart.disabled = true;
      btnDone.disabled = true;
      btnStart.style.opacity = '0.6';
      btnDone.style.opacity = '0.6';
      return;
    }

    async function post(url, payload){
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type':'application/json','X-WP-Nonce':NONCE},
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(()=>({}));
      return {res, data};
    }

    async function autoAttach(maxMinutes = 20){
      const start = Date.now();
      let tries = 0;

      while ((Date.now() - start) < maxMinutes * 60 * 1000) {
        tries++;
        setPill("Saving recording");
        setMsg(`Saving recording... (attempt ${tries})`);

        const {data} = await post(ATTACH_URL, {sid});

        if (data && data.ok && data.mp4_url) {
          setPill("Completed");
          setMsg("Recording saved ✅");
          replayLink.href = data.mp4_url;
          replayWrap.style.display = 'block';
          return true;
        }

        await new Promise(r => setTimeout(r, 60000));
      }

      setPill("Processing");
      setMsg("Recording is still processing. Please refresh later and click “I’ve finished” again.");
      return false;
    }

    btnStart.addEventListener('click', async () => {
      btnStart.disabled = true;
      btnStart.style.opacity = '0.7';
      setPill("Starting");
      setMsg("Starting interview...");

      const {res, data} = await post(JOIN_URL, {sid, minutes: 15});

      if (!res.ok || !data.join_url) {
        console.error(res.status, data);
        setPill("Error");
        setMsg("Could not start. Please retry.");
        btnStart.disabled = false;
        btnStart.style.opacity = '1';
        return;
      }

      window.open(data.join_url, '_blank');
      setPill("In progress");
      setMsg("Interview opened in a new tab. When you finish, come back and click “I’ve finished”.");

      btnStart.disabled = false;
      btnStart.style.opacity = '1';
    });

    btnDone.addEventListener('click', async () => {
      btnDone.disabled = true;
      btnDone.style.opacity = '0.7';
      setPill("Finalizing");
      setMsg("Finalizing your session and saving recording...");

      await post(DONE_URL, {sid});
      await autoAttach(20);

      btnDone.disabled = false;
      btnDone.style.opacity = '1';
    });

  })();
  </script>
  <?php
  return ob_get_clean();
});
