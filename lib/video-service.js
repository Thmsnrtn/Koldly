/**
 * AI Video Outreach Service (Tier 3)
 *
 * Generates personalized video messages for prospects using Tavus or HeyGen.
 * Each video mentions the prospect's company, a recent event, and the sender's
 * value proposition. Videos are hosted on a Koldly-branded landing page.
 *
 * Environment variables:
 *   VIDEO_PROVIDER     — 'tavus' | 'heygen' (default: tavus)
 *   TAVUS_API_KEY      — Tavus API key
 *   TAVUS_REPLICA_ID   — Tavus replica ID (sender's avatar)
 *   HEYGEN_API_KEY     — HeyGen API key
 *   HEYGEN_AVATAR_ID   — HeyGen avatar ID
 */

const https = require('https');

function apiRequest(hostname, path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname, port: 443, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) throw new Error(`${hostname} ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve(data ? JSON.parse(data) : {});
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Video API request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ============================================================
// Tavus Adapter
// ============================================================

class TavusAdapter {
  constructor(apiKey, replicaId) {
    this.apiKey = apiKey;
    this.replicaId = replicaId;
  }

  async createVideo(script, prospectName, callbackUrl) {
    const result = await apiRequest(
      'tavusapi.com', '/v2/videos', 'POST',
      {
        replica_id: this.replicaId,
        script,
        video_name: `Koldly Outreach — ${prospectName}`,
        callback_url: callbackUrl || null,
        fast_render: false // Higher quality for outreach
      },
      { 'x-api-key': this.apiKey }
    );

    return {
      provider: 'tavus',
      external_id: result.video_id,
      status: result.status || 'queued',
      download_url: result.download_url || null,
      stream_url: result.hosted_url || null
    };
  }

  async getVideoStatus(videoId) {
    const result = await apiRequest(
      'tavusapi.com', `/v2/videos/${videoId}`, 'GET',
      null,
      { 'x-api-key': this.apiKey }
    );
    return {
      status: result.status,
      download_url: result.download_url,
      stream_url: result.hosted_url
    };
  }
}

// ============================================================
// HeyGen Adapter
// ============================================================

class HeyGenAdapter {
  constructor(apiKey, avatarId) {
    this.apiKey = apiKey;
    this.avatarId = avatarId;
  }

  async createVideo(script, prospectName, callbackUrl) {
    const result = await apiRequest(
      'api.heygen.com', '/v2/video/generate', 'POST',
      {
        video_inputs: [{
          character: { type: 'avatar', avatar_id: this.avatarId, avatar_style: 'normal' },
          voice: { type: 'text', input_text: script, voice_id: 'default' }
        }],
        dimension: { width: 1280, height: 720 },
        test: false
      },
      { 'X-Api-Key': this.apiKey }
    );

    return {
      provider: 'heygen',
      external_id: result.data?.video_id,
      status: 'queued',
      download_url: null,
      stream_url: null
    };
  }

  async getVideoStatus(videoId) {
    const result = await apiRequest(
      'api.heygen.com', `/v1/video_status.get?video_id=${videoId}`, 'GET',
      null,
      { 'X-Api-Key': this.apiKey }
    );
    return {
      status: result.data?.status,
      download_url: result.data?.video_url,
      stream_url: result.data?.video_url
    };
  }
}

// ============================================================
// Video Service
// ============================================================

class VideoService {
  constructor(pool) {
    this.pool = pool;
    this.provider = process.env.VIDEO_PROVIDER || 'tavus';
  }

  _getAdapter() {
    if (this.provider === 'heygen' && process.env.HEYGEN_API_KEY) {
      return new HeyGenAdapter(process.env.HEYGEN_API_KEY, process.env.HEYGEN_AVATAR_ID);
    }
    if (process.env.TAVUS_API_KEY) {
      return new TavusAdapter(process.env.TAVUS_API_KEY, process.env.TAVUS_REPLICA_ID);
    }
    return null;
  }

  _isConfigured() {
    return !!(process.env.TAVUS_API_KEY || process.env.HEYGEN_API_KEY);
  }

  /**
   * Generate a personalized video script for a prospect using AI,
   * then submit to the video provider for rendering.
   *
   * The script is 45–60 seconds (approximately 120–150 words).
   */
  async createProspectVideo(prospectId, userId, ai) {
    if (!this._isConfigured()) {
      throw new Error('Video provider not configured (set TAVUS_API_KEY or HEYGEN_API_KEY)');
    }

    const prospectResult = await this.pool.query(
      `SELECT p.*, c.description as campaign_description, u.name as sender_name
       FROM prospects p
       JOIN campaigns c ON p.campaign_id = c.id
       JOIN users u ON c.user_id = u.id
       WHERE p.id = $1 AND c.user_id = $2`,
      [prospectId, userId]
    );

    if (prospectResult.rows.length === 0) throw new Error('Prospect not found');
    const prospect = prospectResult.rows[0];

    // Generate personalized script via AI
    const scriptResult = await ai.callJSON('video_script', {
      system: `You are writing a 45-second personalized video script for B2B outreach.
The script should:
- Open with a specific, genuine observation about the company or person (NOT generic)
- Briefly state who you are and what you do
- Explain why you reached out to THIS specific company (not a generic pitch)
- End with a clear, low-friction CTA (check out the landing page, 15-min chat)
- Be exactly 100-130 words (fits in 45-60 seconds when spoken)
- Sound natural and conversational — NOT scripted or salesy
- Never say "I came across your profile" or "I hope you're doing well"

Return JSON: {
  "script": "string (the full spoken script)",
  "word_count": number,
  "opening_hook": "string (the personalization you used)",
  "estimated_seconds": number
}`,
      messages: [{
        role: 'user',
        content: [
          `Sender: ${prospect.sender_name}`,
          `Company: ${prospect.company_name}`,
          `Contact: ${[prospect.contact_first_name, prospect.contact_last_name].filter(Boolean).join(' ') || 'Decision maker'}`,
          `Title: ${prospect.contact_title || 'Unknown'}`,
          `Industry: ${prospect.industry || 'Unknown'}`,
          `Research: ${prospect.research_summary || prospect.pain_points || 'Not available'}`,
          `Our product: ${prospect.campaign_description}`
        ].join('\n')
      }]
    }, { userId });

    const script = scriptResult.content;
    const adapter = this._getAdapter();

    const callbackUrl = process.env.APP_URL
      ? `${process.env.APP_URL}/api/webhooks/video-complete`
      : null;

    const prospectName = [prospect.contact_first_name, prospect.contact_last_name].filter(Boolean).join(' ')
      || prospect.company_name;

    const videoResult = await adapter.createVideo(script.script, prospectName, callbackUrl);

    // Insert into video_tasks as pending (rendering takes time)
    const insertResult = await this.pool.query(
      `INSERT INTO video_tasks
       (prospect_id, campaign_id, user_id, provider, external_video_id, script,
        opening_hook, estimated_seconds, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        prospectId, prospect.campaign_id, userId,
        videoResult.provider, videoResult.external_id,
        script.script, script.opening_hook, script.estimated_seconds || 50,
        'rendering'
      ]
    );

    return {
      id: insertResult.rows[0].id,
      external_id: videoResult.external_id,
      status: 'rendering',
      prospect: prospect.company_name,
      script: script.script,
      message: 'Video is rendering. You will be notified when it is ready (typically 2–5 minutes).'
    };
  }

  /**
   * Poll for video status and update the DB.
   * Called by the scheduler every 5 minutes for rendering videos.
   */
  async pollRenderingVideos() {
    const adapter = this._getAdapter();
    if (!adapter) return;

    const renderingResult = await this.pool.query(
      `SELECT id, external_video_id, provider FROM video_tasks
       WHERE status = 'rendering' AND created_at >= NOW() - INTERVAL '2 hours'
       LIMIT 20`
    );

    for (const video of renderingResult.rows) {
      try {
        const status = await adapter.getVideoStatus(video.external_video_id);

        if (status.status === 'ready' || status.download_url) {
          // Generate the landing page URL
          const landingUrl = `${process.env.APP_URL || 'https://koldly.com'}/v/${video.id}`;

          await this.pool.query(
            `UPDATE video_tasks
             SET status = 'ready', download_url = $1, stream_url = $2,
                 landing_page_url = $3, ready_at = NOW(), updated_at = NOW()
             WHERE id = $4`,
            [status.download_url, status.stream_url, landingUrl, video.id]
          );
        } else if (status.status === 'failed' || status.status === 'error') {
          await this.pool.query(
            `UPDATE video_tasks SET status = 'failed', updated_at = NOW() WHERE id = $1`,
            [video.id]
          );
        }
      } catch (err) {
        console.warn(`[Video] Status poll failed for video ${video.id}:`, err.message);
      }
    }
  }

  /**
   * Process video completion webhook (Tavus/HeyGen callback).
   */
  async processWebhook(payload) {
    const externalId = payload.video_id || payload.id;
    const status = payload.status;
    const downloadUrl = payload.download_url || payload.video_url;

    if (!externalId) return;

    const result = await this.pool.query(
      `UPDATE video_tasks
       SET status = $1, download_url = $2, stream_url = $2,
           landing_page_url = CONCAT($3, '/v/', id::text),
           ready_at = CASE WHEN $1 = 'ready' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE external_video_id = $4
       RETURNING id, user_id, prospect_id`,
      [
        status === 'ready' ? 'ready' : status,
        downloadUrl || null,
        process.env.APP_URL || 'https://koldly.com',
        externalId
      ]
    );

    if (result.rows[0] && status === 'ready') {
      console.info(`[Video] Video ${externalId} ready for prospect ${result.rows[0].prospect_id}`);
    }
  }

  /**
   * Get video landing page data (public — no auth required).
   * Used by the video landing page to display the video + booking widget.
   */
  async getLandingPageData(videoTaskId) {
    const result = await this.pool.query(
      `SELECT
         vt.stream_url, vt.download_url, vt.status,
         p.company_name, p.contact_first_name,
         u.name as sender_name, u.email as sender_email,
         c.description as campaign_description
       FROM video_tasks vt
       JOIN prospects p ON p.id = vt.prospect_id
       JOIN campaigns c ON c.id = vt.campaign_id
       JOIN users u ON u.id = vt.user_id
       WHERE vt.id = $1 AND vt.status = 'ready'`,
      [videoTaskId]
    );

    return result.rows[0] || null;
  }
}

module.exports = VideoService;
