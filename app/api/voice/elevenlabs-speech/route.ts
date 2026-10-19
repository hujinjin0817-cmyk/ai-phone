import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 30;

const ELEVENLABS_API = "https://api.elevenlabs.io";
const MAX_TEXT_LENGTH = 40_000;

function safeId(value: unknown): string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.trim())
        ? value.trim()
        : "";
}

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const voiceId = safeId(body.voiceId);
        const modelId = safeId(body.modelId) || "eleven_multilingual_v2";

        if (!apiKey) return NextResponse.json({ error: "missing_api_key", message: "缺少 ElevenLabs API Key" }, { status: 400 });
        if (!text) return NextResponse.json({ error: "missing_text", message: "缺少待合成文本" }, { status: 400 });
        if (text.length > MAX_TEXT_LENGTH) {
            return NextResponse.json({ error: "text_too_long", message: `文本不能超过 ${MAX_TEXT_LENGTH} 个字符` }, { status: 400 });
        }
        if (!voiceId) return NextResponse.json({ error: "invalid_voice_id", message: "ElevenLabs Voice ID 无效" }, { status: 400 });

        const response = await proxyFetch(
            `${ELEVENLABS_API}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
            {
                method: "POST",
                headers: {
                    "xi-api-key": apiKey,
                    "Content-Type": "application/json",
                    Accept: "audio/mpeg",
                },
                body: JSON.stringify({ text, model_id: modelId }),
            },
        );

        if (!response.ok) {
            const raw = await response.text().catch(() => "");
            let message = raw;
            try {
                const parsed = JSON.parse(raw) as { detail?: string | { message?: string }; message?: string };
                message = typeof parsed.detail === "string"
                    ? parsed.detail
                    : parsed.detail?.message || parsed.message || raw;
            } catch {}
            return NextResponse.json({
                error: "elevenlabs_tts_failed",
                message: message.slice(0, 500) || `ElevenLabs TTS 请求失败 (${response.status})`,
            }, { status: response.status >= 400 && response.status < 500 ? response.status : 502 });
        }

        const audio = await response.arrayBuffer();
        return new Response(audio, {
            status: 200,
            headers: {
                "Content-Type": response.headers.get("content-type") || "audio/mpeg",
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json({ error: "elevenlabs_tts_failed", message: message.slice(0, 500) }, { status: 502 });
    }
}
