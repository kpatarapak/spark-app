/**
 * Spark App — Local Proxy Server
 *
 * Proxies all external API calls that would otherwise fail with CORS errors:
 *   /proxy/anthropic    → Anthropic-format requests → OpenAI-compatible API (gemini-2.5-flash)
 *   /proxy/image        → Wikimedia Commons image search (improved)
 *   /proxy/video        → YouTube video search (no API key required)
 *   /proxy/voices       → ElevenLabs voices list
 *   /proxy/elevenlabs   → ElevenLabs TTS (POST)
 *
 * Also serves the static app files (index.html, cards.json, manifest.json).
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const fs      = require('fs');
const crypto  = require('crypto');
try { require('dotenv').config(); } catch(e) { /* dotenv optional */ }

const app  = express();
const PORT = process.env.PORT || 3000;

// ── API keys ──────────────────────────────────────────────────────────────────
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY ||
  '328a9148e590759da4b832c7e58bf4beac6a559d5901f1fcaf3c2319a7399cef';

// User's OpenAI key — used for image generation (gpt-image-1) AND content generation (gpt-4.1-mini)
const USER_OPENAI_KEY = process.env.SPARK_OPENAI_KEY
  || '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';
// Sandbox key — used for content generation via sandbox OpenAI-compatible endpoint
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || USER_OPENAI_KEY;
const AI_BASE_URL    = process.env.OPENAI_BASE_URL || 'https://api.openai.com';

app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ── Serve static files ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
// ── Serve cached AI images ────────────────────────────────────────────────────
const IMG_CACHE_DIR = path.join(__dirname, 'img-cache');
if (!fs.existsSync(IMG_CACHE_DIR)) fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
app.use('/img-cache', express.static(IMG_CACHE_DIR));

// ─────────────────────────────────────────────────────────────────────────────
// Helper: HTTPS GET
// ─────────────────────────────────────────────────────────────────────────────
function httpsGet(url, reqHeaders = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: reqHeaders }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, reqHeaders, timeoutMs).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: HTTPS POST
// ─────────────────────────────────────────────────────────────────────────────
function httpsPost(hostname, urlPath, reqHeaders, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path: urlPath,
      method: 'POST',
      headers: { ...reqHeaders, 'Content-Length': bodyBuffer.length },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyBuffer);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// /proxy/anthropic  (POST)
// Accepts Anthropic-format body, translates to OpenAI-compatible, returns
// Anthropic-format response so existing frontend code works unchanged.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/proxy/anthropic', async (req, res) => {
  try {
    const { model, max_tokens, system, messages } = req.body || {};

    const oaiMessages = [];
    if (system) oaiMessages.push({ role: 'system', content: system });
    if (Array.isArray(messages)) messages.forEach(m => oaiMessages.push({ role: m.role, content: m.content }));

    const oaiBody = {
      model: 'gemini-2.5-flash',
      max_tokens: max_tokens || 1024,
      messages: oaiMessages,
    };

    const baseUrl    = new URL(AI_BASE_URL);
    const hostname   = baseUrl.hostname;
    const pathPrefix = baseUrl.pathname.replace(/\/$/, '');
    const bodyBuf    = Buffer.from(JSON.stringify(oaiBody), 'utf8');

    const result = await httpsPost(
      hostname,
      pathPrefix + '/chat/completions',
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      bodyBuf
    );

    if (result.statusCode !== 200) {
      console.error('[anthropic proxy] Upstream error', result.statusCode, result.body.toString('utf8').slice(0, 300));
      return res.status(result.statusCode).json({ error: 'Upstream AI error', detail: result.body.toString('utf8').slice(0, 300) });
    }

    const oaiResp = JSON.parse(result.body.toString('utf8'));
    const text    = oaiResp.choices?.[0]?.message?.content || '';

    return res.json({
      id: oaiResp.id || 'proxy-' + Date.now(),
      type: 'message',
      role: 'assistant',
      model: model || 'gemini-2.5-flash',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens:  oaiResp.usage?.prompt_tokens || 0,
        output_tokens: oaiResp.usage?.completion_tokens || 0,
      },
    });
  } catch (err) {
    console.error('[anthropic proxy] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /proxy/image?q=<keyword>&band=<ageBand>
//
// Strategy (waterfall):
//   1. Wikipedia pageimages — most reliable for named topics (persons, places, events)
//   2. Wikimedia Commons file search — with strict filtering to reject books/scans/docs
//   3. Pollinations.ai AI illustration — fallback when Wikimedia has nothing good
//
// Returns: { url: "https://...", source: "wikipedia"|"commons"|"pollinations"|"none" }
// ─────────────────────────────────────────────────────────────────────────────

// Words in filenames that indicate a bad result (books, scans, newspapers, etc.)
const BAD_FILENAME_PATTERNS = [
  /book/i, /cover/i, /scan/i, /newspaper/i, /cartoon/i, /magazine/i,
  /pamphlet/i, /poster/i, /broadside/i, /flyer/i, /advertisement/i,
  /\btext\b/i, /\bpage\b/i, /\bprint\b/i, /\bdocument/i, /\bmanuscript/i,
  /\bpublication/i, /\bjournal\b/i, /\btimes\b/i, /\bgazette/i,
  /\bdaily\b/i, /\bweekly\b/i, /\bmonthly\b/i, /\bherald/i,
  /\bvolume\b/i, /\bchapter/i, /\bpages\b/i, /\bfrontispiece/i,
  /\bplate\b.*\d/i, /fig\./i, /\billustration/i, /\bengrav/i,
];

function isBadFilename(title) {
  return BAD_FILENAME_PATTERNS.some(p => p.test(title));
}

app.get(['/proxy/image', '/.netlify/functions/image'], async (req, res) => {
  const q    = (req.query.q    || '').trim();
  const band = (req.query.band || 'default').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const UA = 'SparkApp/2.0 (educational; proxy)';

  // ── Strategy 1: Wikipedia pageimages (most reliable for named topics) ────────
  try {
    // First find the best matching Wikipedia article
    const searchUrl =
      `https://en.wikipedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&origin=*`;

    const searchRes = await httpsGet(searchUrl, { 'User-Agent': UA });

    if (searchRes.statusCode === 200) {
      const hits = JSON.parse(searchRes.body.toString('utf8'))?.query?.search || [];

      // Try each hit until we find one with a good thumbnail
      for (const hit of hits) {
        const imgUrl =
          `https://en.wikipedia.org/w/api.php?action=query&titles=` +
          `${encodeURIComponent(hit.title)}&prop=pageimages&pithumbsize=900` +
          `&format=json&origin=*`;

        const imgRes = await httpsGet(imgUrl, { 'User-Agent': UA });
        if (imgRes.statusCode === 200) {
          const pages = JSON.parse(imgRes.body.toString('utf8'))?.query?.pages || {};
          const page  = Object.values(pages)[0];
          const thumb = page?.thumbnail?.source;
          if (thumb && !isBadFilename(thumb)) {
            // Fetch the image bytes and return as base64 data URL to avoid CORS issues on mobile
            try {
              const imgBytes = await httpsGet(thumb, { 'User-Agent': UA, 'Referer': 'https://en.wikipedia.org/' }, 20000);
              if (imgBytes.statusCode === 200 && imgBytes.headers['content-type']?.startsWith('image/')) {
                const mime = imgBytes.headers['content-type'].split(';')[0];
                const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
                const cacheKey = crypto.createHash('md5').update(thumb).digest('hex');
                const cacheFile = path.join(IMG_CACHE_DIR, `${cacheKey}.${ext}`);
                const cacheUrl = `/img-cache/${cacheKey}.${ext}`;
                if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, imgBytes.body);
                console.log(`[image] Wikipedia (${hit.title}): ${q} → cached ${imgBytes.body.length} bytes`);
                return res.json({ url: cacheUrl, source: 'wikipedia' });
              }
            } catch (fetchErr) {
              console.warn('[image] Wikipedia image fetch error:', fetchErr.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[image] Wikipedia error:', err.message);
  }

  // ── Strategy 2: Wikimedia Commons — strict filtering ─────────────────────────
  try {
    const commonsSearchUrl =
      `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(q)}&srnamespace=6&srlimit=15&format=json&origin=*`;

    const commonsRes = await httpsGet(commonsSearchUrl, { 'User-Agent': UA });

    if (commonsRes.statusCode === 200) {
      const hits = JSON.parse(commonsRes.body.toString('utf8'))?.query?.search || [];

      // Filter: must be jpg/png/webp AND must not have bad filename patterns
      const goodHits = hits.filter(h =>
        /\.(jpe?g|png|webp)$/i.test(h.title) && !isBadFilename(h.title)
      );

      if (goodHits.length > 0) {
        const fileTitle = goodHits[0].title;
        const infoUrl =
          `https://commons.wikimedia.org/w/api.php?action=query` +
          `&titles=${encodeURIComponent(fileTitle)}&prop=imageinfo` +
          `&iiprop=url&iiurlwidth=900&format=json&origin=*`;

        const infoRes = await httpsGet(infoUrl, { 'User-Agent': UA });
        if (infoRes.statusCode === 200) {
          const page  = Object.values(JSON.parse(infoRes.body.toString('utf8'))?.query?.pages || {})[0];
          const thumb = page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url;
          if (thumb) {
            // Fetch the image bytes and return as base64 data URL to avoid CORS issues on mobile
            try {
              const imgBytes = await httpsGet(thumb, { 'User-Agent': UA, 'Referer': 'https://commons.wikimedia.org/' }, 20000);
              if (imgBytes.statusCode === 200 && imgBytes.headers['content-type']?.startsWith('image/')) {
                const mime = imgBytes.headers['content-type'].split(';')[0];
                const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
                const cacheKey = crypto.createHash('md5').update(thumb).digest('hex');
                const cacheFile = path.join(IMG_CACHE_DIR, `${cacheKey}.${ext}`);
                const cacheUrl = `/img-cache/${cacheKey}.${ext}`;
                if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, imgBytes.body);
                console.log(`[image] Commons: ${q} → cached ${imgBytes.body.length} bytes`);
                return res.json({ url: cacheUrl, source: 'commons' });
              }
            } catch (fetchErr) {
              console.warn('[image] Commons image fetch error:', fetchErr.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[image] Commons error:', err.message);
  }

  // ── Strategy 3: Pollinations.ai AI illustration fallback ─────────────────────
  try {
    const style = AI_IMAGE_STYLES[band] || AI_IMAGE_STYLES.default;
    const prompt = `${q}, ${style}, no text, no watermark, no logos`;
    const seed = q.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 99999;
    const pollinationsUrl =
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=800&height=600&seed=${seed}&nologo=true&model=flux`;

    console.log(`[image] Falling back to Pollinations AI for: ${q}`);
    const result = await httpsGet(pollinationsUrl, {
      'User-Agent': 'SparkApp/2.0 (educational; proxy)',
      'Accept': 'image/*',
    }, 30000);

    if (result.statusCode === 200 && result.headers['content-type']?.startsWith('image/')) {
      const mime   = result.headers['content-type'].split(';')[0];
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const cacheKey = crypto.createHash('md5').update(q + '_poll').digest('hex');
      const cacheFile = path.join(IMG_CACHE_DIR, `${cacheKey}.${ext}`);
      const cacheUrl = `/img-cache/${cacheKey}.${ext}`;
      if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, result.body);
      console.log(`[image] Pollinations fallback OK: ${q} (${result.body.length} bytes) → cached`);
      return res.json({ url: cacheUrl, source: 'pollinations' });
    }
  } catch (err) {
    console.warn('[image] Pollinations fallback error:', err.message);
  }

  console.log(`[image] No image found for: ${q}`);
  return res.json({ url: '', source: 'none' });
});

// ─────────────────────────────────────────────────────────────────────────────
// /proxy/video?q=<keyword>
//
// Uses YouTube's internal search API (no API key required).
// Returns the top educational video result.
//
// Returns: { videoId: "abc123", title: "...", thumbnail: "https://..." }
//          or { videoId: null } if nothing found
// ─────────────────────────────────────────────────────────────────────────────
app.get('/proxy/video', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  // Append "explained" to bias toward educational content
  const query = q.endsWith('explained') ? q : `${q} explained`;

  try {
    const body = JSON.stringify({
      context: {
        client: {
          clientName:    'WEB',
          clientVersion: '2.20231219.04.00',
          hl: 'en',
          gl: 'US',
        },
      },
      query,
      params: 'EgIQAQ==', // filter: videos only
    });

    const result = await httpsPost(
      'www.youtube.com',
      '/youtubei/v1/search?prettyPrint=false',
      {
        'Content-Type':  'application/json',
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin':        'https://www.youtube.com',
        'Referer':       'https://www.youtube.com/',
      },
      Buffer.from(body, 'utf8')
    );

    if (result.statusCode !== 200) {
      console.warn('[video] YouTube returned', result.statusCode);
      return res.json({ videoId: null });
    }

    const data = JSON.parse(result.body.toString('utf8'));
    const contents = data?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents || [];

    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const vr = item?.videoRenderer;
        if (!vr) continue;

        const videoId   = vr.videoId || '';
        const title     = vr.title?.runs?.[0]?.text || '';
        const duration  = vr.lengthText?.simpleText || '';
        const thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

        // Skip very short clips (< 1 min) or very long ones (> 30 min)
        const durationOk = (() => {
          const parts = duration.split(':').map(Number);
          if (parts.length === 2) {
            const mins = parts[0];
            return mins >= 1 && mins <= 30;
          }
          if (parts.length === 3) {
            return parts[0] === 0; // under 1 hour
          }
          return true;
        })();

        if (videoId && durationOk) {
          console.log(`[video] ${q} → ${videoId}: ${title.slice(0, 60)}`);
          return res.json({ videoId, title, thumbnail, duration });
        }
      }
    }

    console.log(`[video] No video found for: ${q}`);
    return res.json({ videoId: null });
  } catch (err) {
    console.error('[video] Error:', err.message);
    return res.json({ videoId: null });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /proxy/voices  (GET)
// ─────────────────────────────────────────────────────────────────────────────
app.get(['/proxy/voices', '/.netlify/functions/voices'], async (req, res) => {
  try {
    const result = await httpsGet('https://api.elevenlabs.io/v1/voices', {
      'xi-api-key': ELEVENLABS_KEY,
      'Accept': 'application/json',
    });
    if (result.statusCode === 200) return res.json(JSON.parse(result.body.toString('utf8')));
    return res.status(result.statusCode).json({ error: 'ElevenLabs error', voices: [] });
  } catch (err) {
    console.error('[voices] Error:', err.message);
    return res.status(500).json({ error: err.message, voices: [] });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /proxy/elevenlabs  (POST)
// ─────────────────────────────────────────────────────────────────────────────
app.post(['/proxy/elevenlabs', '/.netlify/functions/elevenlabs'], async (req, res) => {
  const { text, voice_id, model_id = 'eleven_turbo_v2' } = req.body || {};
  if (!text || !voice_id) return res.status(400).json({ error: 'Missing text or voice_id' });

  try {
    const bodyBuf = Buffer.from(JSON.stringify({
      text,
      model_id,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }), 'utf8');

    const result = await httpsPost(
      'api.elevenlabs.io',
      `/v1/text-to-speech/${voice_id}`,
      { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      bodyBuf
    );

    if (result.statusCode === 200) {
      return res.json({ audio: `data:audio/mpeg;base64,${result.body.toString('base64')}` });
    }
    return res.status(result.statusCode).json({ error: 'ElevenLabs TTS error' });
  } catch (err) {
    console.error('[elevenlabs] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /proxy/ai-image?q=<prompt>&style=<style>
//
// Uses Pollinations.ai (free, no API key) to generate an AI image.
// Falls back to Wikimedia if Pollinations fails.
//
// Returns: { url: "https://...", source: "pollinations"|"wikimedia"|"none" }
// ─────────────────────────────────────────────────────────────────────────────
// Age-band style profiles for Pollinations prompts
const AI_IMAGE_STYLES = {
  little:  'cute illustrated children\'s book style, bright cheerful colors, friendly cartoon-like, safe for ages 8-9, no scary elements, no violence, no adult content, highly detailed, magical and whimsical',
  junior:  'vibrant educational illustration style, bold colors, engaging and dynamic, safe for ages 10-11, no violence, no adult content, detailed and informative, slightly more realistic than cartoon',
  teen:    'modern infographic illustration style, vivid colors, cool and engaging, safe for ages 12-14, no adult content, detailed and stylish, semi-realistic',
  nerd:    'detailed scientific illustration style, rich colors, intellectually engaging, safe for all ages, no adult content, highly detailed and accurate-looking',
  default: 'vibrant illustrated educational style for children, bright colors, engaging, detailed, safe for all ages, no adult content, no violence',
};

app.get('/proxy/ai-image', async (req, res) => {
  const q    = (req.query.q    || '').trim();
  const band = (req.query.band || 'default').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const style = AI_IMAGE_STYLES[band] || AI_IMAGE_STYLES.default;
  const prompt = `${q}, ${style}, no text, no watermark, no logos`;

  // ── Primary: OpenAI gpt-image-1 quality:low — save to disk, return URL ──
  if (USER_OPENAI_KEY) {
    try {
      // Check disk cache first
      const cacheKey = crypto.createHash('md5').update(prompt).digest('hex');
      const cacheFile = path.join(IMG_CACHE_DIR, `${cacheKey}.png`);
      const cacheUrl = `/img-cache/${cacheKey}.png`;
      if (fs.existsSync(cacheFile)) {
        console.log(`[ai-image] Cache HIT: ${q}`);
        return res.json({ url: cacheUrl, source: 'openai-cache' });
      }
      console.log(`[ai-image] OpenAI generating: ${q}`);
      const bodyBuf = Buffer.from(JSON.stringify({
        model: 'gpt-image-1',
        prompt: prompt,
        n: 1,
        size: '1024x1024',
        quality: 'low',
      }));
      const result = await httpsPost(
        'api.openai.com', '/v1/images/generations',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${USER_OPENAI_KEY}` },
        bodyBuf
      );
      if (result.statusCode === 200) {
        const data = JSON.parse(result.body.toString('utf8'));
        const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.b64;
        if (b64) {
          // Save to disk and return URL
          fs.writeFileSync(cacheFile, Buffer.from(b64, 'base64'));
          console.log(`[ai-image] OpenAI OK (saved to disk): ${q}`);
          return res.json({ url: cacheUrl, source: 'openai' });
        }
      }
      console.warn(`[ai-image] OpenAI returned ${result.statusCode}: ${result.body.toString('utf8').slice(0,200)}`);
    } catch (err) {
      console.warn('[ai-image] OpenAI error:', err.message);
    }
  }

  // ── Fallback: Pollinations (free, no key) ──
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = q.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 99999;
  const pollinationsUrl =
    `https://image.pollinations.ai/prompt/${encodedPrompt}?width=800&height=600&seed=${seed}&nologo=true&model=flux`;
  try {
    console.log(`[ai-image] Pollinations fallback: ${q}`);
    const result = await httpsGet(pollinationsUrl, {
      'User-Agent': 'SparkApp/2.0 (educational; proxy)',
      'Accept': 'image/*',
    }, 25000);
    if (result.statusCode === 200 && result.headers['content-type']?.startsWith('image/')) {
      const mime = result.headers['content-type'].split(';')[0];
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const pollCacheKey = crypto.createHash('md5').update(prompt + '_poll').digest('hex');
      const pollCacheFile = path.join(IMG_CACHE_DIR, `${pollCacheKey}.${ext}`);
      const pollCacheUrl = `/img-cache/${pollCacheKey}.${ext}`;
      if (!fs.existsSync(pollCacheFile)) fs.writeFileSync(pollCacheFile, result.body);
      console.log(`[ai-image] Pollinations OK: ${q} (${result.body.length} bytes) → cached`);
      return res.json({ url: pollCacheUrl, source: 'pollinations' });
    }
    console.warn(`[ai-image] Pollinations returned ${result.statusCode} for: ${q}`);
  } catch (err) {
    console.warn('[ai-image] Pollinations error:', err.message);
  }

  // Fallback: Wikimedia Commons
  try {
    const UA = 'SparkApp/2.0 (educational; proxy)';
    const commonsSearchUrl =
      `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(q)}&srnamespace=6&srlimit=5&format=json&origin=*`;
    const commonsRes = await httpsGet(commonsSearchUrl, { 'User-Agent': UA });
    if (commonsRes.statusCode === 200) {
      const hits = JSON.parse(commonsRes.body.toString('utf8'))?.query?.search || [];
      const imageHits = hits.filter(h => /\.(jpe?g|png|webp)$/i.test(h.title));
      const bestHit   = imageHits[0] || hits[0];
      if (bestHit) {
        const infoUrl =
          `https://commons.wikimedia.org/w/api.php?action=query` +
          `&titles=${encodeURIComponent(bestHit.title)}&prop=imageinfo` +
          `&iiprop=url&iiurlwidth=800&format=json&origin=*`;
        const infoRes = await httpsGet(infoUrl, { 'User-Agent': UA });
        if (infoRes.statusCode === 200) {
          const page  = Object.values(JSON.parse(infoRes.body.toString('utf8'))?.query?.pages || {})[0];
          const thumb = page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url;
          if (thumb) {
            console.log(`[ai-image] Fallback Wikimedia: ${q}`);
            return res.json({ url: thumb, source: 'wikimedia' });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[ai-image] Wikimedia fallback error:', err.message);
  }

  return res.json({ url: '', source: 'none' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✦ Spark proxy server running at http://localhost:${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser.\n`);
  if (!OPENAI_API_KEY) console.warn('  WARNING: OPENAI_API_KEY is not set — AI generation will fail.');
});
