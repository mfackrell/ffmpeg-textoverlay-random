import functions from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

// 1. Get the library-provided path for FFmpeg
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2. Correct way to find the font path in ES Modules
const fontPath = path.join(__dirname, 'node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff');

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'ssm-renders-8822';
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegInstaller.path || ffmpegStatic;

const TEXT_STYLES = [
  { name: 'quiet_center_reveal', fontsize: 36, kerning: 2, shadow: 'shadowx=2:shadowy=2:shadowcolor=black@0.4', x: '(w-text_w)/2', y: '(h-text_h)/2', fontcolor: 'white' },
  { name: 'lower_third_fact', fontsize: 34, kerning: 1, border: 'borderw=3:bordercolor=black@0.8', x: '(w-text_w)/2', y: 'h*0.72' },
  { name: 'internal_shift_up', fontsize: 36, kerning: 2, shadow: 'shadowx=3:shadowy=3:shadowcolor=black@0.5', x: '(w-text_w)/2', y: '(h-text_h)/2 + 50' },
  { name: 'freeze_response', fontsize: 38, kerning: 1, shadow: 'shadowx=4:shadowy=4:shadowcolor=black@0.6', x: '(w-text_w)/2', y: '(h-text_h)/2' },
  { name: 'split_reality_top', fontsize: 34, kerning: 1, border: 'borderw=2:bordercolor=black@0.7', x: '(w-text_w)/2', y: 'h*0.25' },
  { name: 'split_reality_bottom', fontsize: 36, kerning: 2, shadow: 'shadowx=3:shadowy=3:shadowcolor=black@0.5', x: '(w-text_w)/2', y: 'h*0.65' },
  { name: 'gaslight_flicker', fontsize: 36, kerning: 1, shadow: 'shadowx=2:shadowy=2:shadowcolor=black@0.4', x: '(w-text_w)/2', y: '(h-text_h)/2', fontcolor_expr: "if(lt(rand(0),0.92),white,gray)" },
  { name: 'submission_sink', fontsize: 34, kerning: 1, shadow: 'shadowx=3:shadowy=3:shadowcolor=black@0.6', x: '(w-text_w)/2', y: '(h-text_h)/2 + 50' },
  { name: 'memory_echo', fontsize: 36, kerning: 2, fontcolor: 'white@0.6', shadow: 'shadowx=4:shadowy=4:shadowcolor=black@0.7', x: '(w-text_w)/2', y: '(h-text_h)/2' },
  { name: 'realization_snap', fontsize: 40, kerning: 3, border: 'borderw=4:bordercolor=black@0.9', x: '(w-text_w)/2', y: '(h-text_h)/2' }
];

function pickRandomStyle() {
  return TEXT_STYLES[Math.floor(Math.random() * TEXT_STYLES.length)];
}

function wrapText(text, maxWidth) {
  const words = text.split(' ');
  let lines = [];
  let currentLine = words[0];
  for (let i = 1; i < words.length; i++) {
    if (currentLine.length + 1 + words[i].length <= maxWidth) {
      currentLine += ' ' + words[i];
    } else {
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);
  return lines.join('\n');
}

async function download(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function renderTextOverlay(fileName, videoUrl, overlays) {
  const tmp = '/tmp';
  const runId = Date.now(); 
  const videoFile = path.join(tmp, `input_video_${runId}.mp4`);
  const outputFile = path.join(tmp, fileName);
  
  const selectedStyle = pickRandomStyle();
  console.log(`[Run ${runId}] Selected style:`, selectedStyle.name);

  try {
    console.log('Downloading input video...', videoUrl);
    await download(videoUrl, videoFile);

    const filterParts = [];
    let lastLabel = '[0:v]';

    overlays.forEach((overlay, index) => {
      const inputLabel = index === 0 ? '[0:v]' : `[v${index - 1}]`;
      const outputLabel = `[v${index}]`;
      const cleanText = overlay.text.replace(/[\[\]]/g, "");
      const wrappedText = wrapText(cleanText, 25);
      const textFile = path.join(tmp, `text_${runId}_${index}.txt`);
      fs.writeFileSync(textFile, wrappedText, 'utf8');

      const escapedFontPath = fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const escapedTextFile = textFile.replace(/\\/g, '/').replace(/:/g, '\\:');

      const drawTextOptions = [
        `fontfile='${escapedFontPath}'`,
        `textfile='${escapedTextFile}'`,
        `fontsize=${selectedStyle.fontsize}`,
        `kerning=${selectedStyle.kerning || 0}`,
        `line_spacing=20`,
        `x=${selectedStyle.x}`,
        `y=${selectedStyle.y}`,
        `enable='between(t,${overlay.start},${overlay.end})'`
      ];

      if (selectedStyle.fontcolor_expr) {
        drawTextOptions.push(`fontcolor_expr=${selectedStyle.fontcolor_expr}`);
      } else {
        drawTextOptions.push(`fontcolor=${selectedStyle.fontcolor || 'white'}`);
      }

      if (selectedStyle.border) drawTextOptions.push(selectedStyle.border);
      if (selectedStyle.shadow) drawTextOptions.push(selectedStyle.shadow);

      filterParts.push(`${inputLabel}drawtext=${drawTextOptions.join(':')}${outputLabel}`);
      lastLabel = outputLabel;
    });

    const filterChain = filterParts.join(';');
    const args = ['-i', videoFile, '-filter_complex', filterChain, '-map', lastLabel, '-map', '0:a?', '-c:v', 'libx264', '-c:a', 'copy', '-y', outputFile];

    console.log('Executing FFmpeg...');
    execFileSync(ffmpegPath, args);

    console.log(`Uploading ${fileName}...`);
    await storage.bucket(BUCKET_NAME).upload(outputFile, { destination: fileName });

    return `https://storage.googleapis.com/${BUCKET_NAME}/${fileName}`;

  } finally {
    [videoFile, outputFile].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    overlays.forEach((_, i) => {
      const t = path.join(tmp, `text_${runId}_${i}.txt`);
      if (fs.existsSync(t)) fs.unlinkSync(t);
    });
  }
}

functions.http('ffmpegTextOverlay', async (req, res) => {
  const body = req.body;
  if (!body.videoUrl || !body.overlays || !Array.isArray(body.overlays)) {
    return res.status(400).json({ error: 'Payload must include videoUrl and overlays array.' });
  }

  const fileName = `overlay_${Date.now()}.mp4`;

  try {
    const url = await renderTextOverlay(fileName, body.videoUrl, body.overlays);
    res.status(200).json({ status: 'completed', url });
  } catch (err) {
    console.error('Render failed:', err);
    res.status(500).json({ error: err.message });
  }
});
