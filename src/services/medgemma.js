import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/medgemma_analyze.py');

// Total budget for the local Python attempt, across every python command tried. The upload
// response waits on this, so it has to be bounded: three candidates at the spawn timeout each
// could otherwise hold a request open for a quarter of an hour.
const LOCAL_ANALYSIS_BUDGET_MS = Number(process.env.MEDGEMMA_TIMEOUT_MS) || 120000;

const HF_MODEL = 'google/medgemma-4b-it';
const HF_API_URL = `https://router.huggingface.co/hf-inference/models/${HF_MODEL}/v1/chat/completions`;

// ── Helpers ──────────────────────────────

function getHfToken() {
    if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
    try {
        const envPath = path.resolve('.', '.env');
        if (fs.existsSync(envPath)) {
            const lines = fs.readFileSync(envPath, 'utf8').split('\n');
            for (const line of lines) {
                const match = line.match(/^HF_TOKEN\s*=\s*(.+)/);
                if (match) return match[1].trim();
            }
        }
    } catch {}
    return null;
}

/**
 * DICOM pads odd-length string values to an even byte count, so text elements routinely arrive
 * with a trailing NUL or space - "Patient Sex: F\x00". Node refuses to spawn a process with a NUL
 * in an argument, so an unwashed value here kills the whole upload.
 *
 * Multi-valued elements come through as arrays, and person names as { Alphabetic: "..." }.
 */
function cleanText(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(' ');
    if (typeof value === 'object') return cleanText(value.Alphabetic ?? '');

    // Anything below space, plus DEL, becomes a space - which covers the NUL padding - and the
    // runs of spaces that leaves are collapsed. Written without a control-character class so no
    // raw control bytes end up in this file.
    return Array.from(String(value))
        .map(ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) ? ' ' : ch)
        .join('')
        .replace(/[ ]+/g, ' ')
        .trim();
}

function buildContext(dicomInfo) {
    const modality = cleanText(dicomInfo?.Modality) || 'Unknown';
    const bodyPart = cleanText(dicomInfo?.BodyPartExamined) || 'Unknown';
    const studyDesc = cleanText(dicomInfo?.StudyDescription);
    const seriesDesc = cleanText(dicomInfo?.SeriesDescription);
    const patientAge = cleanText(dicomInfo?.PatientAge);
    const patientSex = cleanText(dicomInfo?.PatientSex);

    return [
        `Modality: ${modality}`,
        bodyPart !== 'Unknown' ? `Body Part: ${bodyPart}` : '',
        studyDesc ? `Study: ${studyDesc}` : '',
        seriesDesc ? `Series: ${seriesDesc}` : '',
        patientAge ? `Patient Age: ${patientAge}` : '',
        patientSex ? `Patient Sex: ${patientSex}` : ''
    ].filter(Boolean).join(', ');
}

// ── Local Python Analysis ────────────────

function findPython() {
    // Common python command names
    const candidates = process.platform === 'win32'
        ? ['python', 'python3', 'py']
        : ['python3', 'python'];
    return candidates;
}

function tryLocalAnalysis(imagePath, context) {
    return new Promise((resolve) => {
        if (!fs.existsSync(SCRIPT_PATH)) {
            console.log('MedGemma: analysis script missing — skipping local analysis.');
            resolve(null);
            return;
        }

        const pythonCmds = findPython();
        const deadline = Date.now() + LOCAL_ANALYSIS_BUDGET_MS;
        let tried = 0;

        function tryNext() {
            const remaining = deadline - Date.now();
            if (tried >= pythonCmds.length || remaining <= 0) {
                if (remaining <= 0)
                    console.log(`MedGemma: local analysis gave up after ${LOCAL_ANALYSIS_BUDGET_MS} ms.`);
                resolve(null); // No working python found, or out of time
                return;
            }

            const cmd = pythonCmds[tried++];
            const args = [SCRIPT_PATH, imagePath];
            if (context) args.push('--context', context);

            let stdout = '';
            let stderr = '';

            const proc = spawn(cmd, args, {
                timeout: remaining,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            proc.stdout.on('data', d => stdout += d);
            proc.stderr.on('data', d => {
                stderr += d;
                // Relay progress messages
                const lines = d.toString().split('\n');
                for (const line of lines) {
                    if (line.startsWith('MedGemma:')) console.log(line.trim());
                }
            });

            proc.on('error', () => {
                // Command not found, try next
                tryNext();
            });

            proc.on('close', code => {
                if (code !== 0) {
                    console.error(`MedGemma: Python (${cmd}) exited with code ${code}`);
                    if (stderr) console.error(stderr.slice(-500));
                    tryNext();
                    return;
                }
                try {
                    // Find the last line that looks like JSON
                    const lines = stdout.trim().split('\n');
                    let jsonStr = null;
                    for (let i = lines.length - 1; i >= 0; i--) {
                        if (lines[i].startsWith('{')) { jsonStr = lines[i]; break; }
                    }
                    if (!jsonStr) throw new Error('No JSON in output');
                    const result = JSON.parse(jsonStr);
                    if (result.error) throw new Error(result.error);
                    resolve(result);
                } catch (e) {
                    console.error('MedGemma: Failed to parse Python output:', e.message);
                    resolve(null);
                }
            });
        }

        tryNext();
    });
}

// ── HuggingFace API Fallback ─────────────

function imageToBase64DataUrl(imagePath) {
    const buffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function callMedGemmaAPI(imageDataUrl, prompt, token) {
    const body = {
        model: HF_MODEL,
        messages: [
            {
                role: "user",
                content: [
                    { type: "image_url", image_url: { url: imageDataUrl } },
                    { type: "text", text: prompt }
                ]
            }
        ],
        max_tokens: 1024
    };

    const res = await fetch(HF_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`MedGemma API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
}

async function runApiAnalysis(imagePath, context, token) {
    const imageDataUrl = imageToBase64DataUrl(imagePath);

    const [interpretation, analysis, report] = await Promise.all([
        callMedGemmaAPI(imageDataUrl,
            `You are a medical imaging AI. ${context}. Provide a brief clinical interpretation of this medical image. Focus on what is visible, any notable findings, and their significance. Keep it concise (3-5 sentences).`,
            token),
        callMedGemmaAPI(imageDataUrl,
            `You are a medical imaging AI. ${context}. Provide a technical analysis of this medical image. Describe the image quality, positioning, contrast, visible anatomical structures, and any abnormalities or variants. Keep it concise (4-6 sentences).`,
            token),
        callMedGemmaAPI(imageDataUrl,
            `You are a medical imaging AI. ${context}. Generate a structured radiology-style report for this medical image with these sections: FINDINGS, IMPRESSION. Be professional and concise.`,
            token)
    ]);

    return {
        model: HF_MODEL,
        source: 'huggingface-api',
        interpretation: interpretation.trim(),
        analysis: analysis.trim(),
        report: report.trim(),
    };
}

// ── Main Entry Point ─────────────────────

/**
 * Run MedGemma analysis on a representative image from the DICOM set.
 * Strategy: try local Python + GPU first, fall back to HF API.
 * Returns { interpretation, analysis, report, ... } or null if unavailable.
 */
export async function analyzeDicom(jpgAbsolutePath, dicomInfo) {
    if (!jpgAbsolutePath || !fs.existsSync(jpgAbsolutePath)) {
        console.log('MedGemma: No image file found — skipping AI analysis.');
        return null;
    }

    const context = buildContext(dicomInfo);
    const timestamp = new Date().toISOString();
    const disclaimer = 'AI-generated analysis for research purposes only. Not a clinical diagnosis. Always consult a qualified healthcare professional.';

    // ── Try 1: Local Python with GPU ──
    console.log('MedGemma: Trying local Python analysis...');
    const localResult = await tryLocalAnalysis(jpgAbsolutePath, context);
    if (localResult && localResult.interpretation) {
        console.log(`MedGemma: Local analysis complete (device: ${localResult.device || 'unknown'}).`);
        return {
            ...localResult,
            source: `local-${localResult.device || 'python'}`,
            timestamp,
            context,
            disclaimer
        };
    }

    // ── Try 2: HuggingFace Inference API ──
    const token = getHfToken();
    if (!token) {
        console.log('MedGemma: Local Python unavailable and no HF_TOKEN set — skipping AI analysis.');
        console.log('  → To enable local: pip install transformers torch pillow accelerate');
        console.log('  → To enable API:   set HF_TOKEN in .env file');
        return null;
    }

    try {
        console.log('MedGemma: Falling back to HuggingFace API...');
        const apiResult = await runApiAnalysis(jpgAbsolutePath, context, token);
        console.log('MedGemma: API analysis complete.');
        return {
            ...apiResult,
            timestamp,
            context,
            disclaimer
        };
    } catch (error) {
        console.error('MedGemma: API analysis failed:', error.message);
        return null;
    }
}
