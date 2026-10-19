import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 30;

const ELEVENLABS_API = "https://api.elevenlabs.io";

function upstreamMessage(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== "object") return fallback;
    const record = payload as Record<string, unknown>;
    const detail = record.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
        const message = (detail as Record<string, unknown>).message;
        if (typeof message === "string") return message;
    }
    return typeof record.message === "string" ? record.message : fallback;
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error(text.slice(0, 500) || `HTTP ${response.status}`);
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey) return NextResponse.json({ error: "missing_api_key", message: "缺少 ElevenLabs API Key" }, { status: 400 });

        const headers = { "xi-api-key": apiKey, Accept: "application/json" };
        const [voicesResponse, modelsResponse] = await Promise.all([
            proxyFetch(`${ELEVENLABS_API}/v2/voices?page_size=100&include_total_count=false`, { headers }),
            proxyFetch(`${ELEVENLABS_API}/v1/models`, { headers }),
        ]);
        const [voicesPayload, modelsPayload] = await Promise.all([
            readJson(voicesResponse),
            readJson(modelsResponse),
        ]);

        if (!voicesResponse.ok) {
            return NextResponse.json({
                error: "voices_failed",
                message: upstreamMessage(voicesPayload, `ElevenLabs 音色同步失败 (${voicesResponse.status})`),
            }, { status: 502 });
        }
        if (!modelsResponse.ok) {
            return NextResponse.json({
                error: "models_failed",
                message: upstreamMessage(modelsPayload, `ElevenLabs 模型同步失败 (${modelsResponse.status})`),
            }, { status: 502 });
        }

        const voicesRoot = voicesPayload && typeof voicesPayload === "object"
            ? voicesPayload as Record<string, unknown>
            : {};
        const voices = Array.isArray(voicesRoot.voices)
            ? voicesRoot.voices.flatMap(item => {
                if (!item || typeof item !== "object") return [];
                const record = item as Record<string, unknown>;
                const id = typeof record.voice_id === "string" ? record.voice_id.trim() : "";
                if (!id) return [];
                const name = typeof record.name === "string" && record.name.trim()
                    ? record.name.trim()
                    : id;
                return [{ id, name }];
            })
            : [];

        const models = Array.isArray(modelsPayload)
            ? modelsPayload.flatMap(item => {
                if (!item || typeof item !== "object") return [];
                const record = item as Record<string, unknown>;
                if (record.can_do_text_to_speech !== true) return [];
                const id = typeof record.model_id === "string" ? record.model_id.trim() : "";
                if (!id) return [];
                const name = typeof record.name === "string" && record.name.trim()
                    ? record.name.trim()
                    : id;
                return [{ id, name }];
            })
            : [];

        return NextResponse.json({ ok: true, voices, models });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json({ error: "elevenlabs_catalog_failed", message: message.slice(0, 500) }, { status: 502 });
    }
}
