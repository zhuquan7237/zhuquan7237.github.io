/**
 * Pure helpers for the vision-aux plugin: OpenAI-compatible vision calls and
 * the text blocks that replace image blocks. Host types are structural so this
 * file has zero runtime host imports.
 *
 * @module @dsh-desktop/dsh-vision-aux/vision
 */
/** Default description prompt: the text is read by a model that cannot see the image. */
export const DEFAULT_VISION_PROMPT = '你是编程助手的视觉辅助模型。请详细描述这张图片，供另一个无法查看图片的模型使用：' +
    '界面截图请逐字转写其中的文字（保留标题、按钮、报错等结构），代码或报错请完整转写，' +
    '图表请说明数据与趋势，普通图片请说明主体与关键细节。用简洁准确的中文，不要寒暄，不要解释你在做什么。';
export const DEFAULT_VISION_TIMEOUT_MS = 60_000;
export const DEFAULT_SKIP_WHEN_UNKNOWN = false;
function joinErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split('\n')[0]?.slice(0, 160) || 'unknown error';
}
/**
 * Describe one image through an OpenAI-compatible `/chat/completions` vision
 * call. Aborts honor both the turn signal and the per-image timeout.
 */
export async function describeImage(options, image, signal) {
    const dataUrl = `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`;
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const base = options.baseURL.trim().replace(/\/+$/, '');
    const response = await (options.fetchImpl ?? fetch)(`${base}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: {
            'authorization': `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            'accept': 'application/json',
        },
        body: JSON.stringify({
            model: options.model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: options.prompt },
                        { type: 'image_url', image_url: { url: dataUrl } },
                    ],
                },
            ],
            max_tokens: 1024,
            temperature: 0,
        }),
        signal: combined,
    });
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const body = await response.text();
            if (body.trim().length > 0)
                detail += `：${body.trim().slice(0, 200)}`;
        }
        catch {
            // status is already in the message
        }
        throw new Error(`视觉辅助模型接口返回 ${detail}`);
    }
    const payload = (await response.json());
    const content = payload.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? content
                .map((part) => (typeof part?.text === 'string' ? part.text : ''))
                .join('')
            : '';
    const trimmed = text.trim();
    if (trimmed.length === 0)
        throw new Error('视觉辅助模型返回了空描述');
    return trimmed;
}
/** The text block that replaces a successfully described image. */
export function renderImageDescription(index, total, ref, model, description) {
    return `[图片 ${index}/${total}，${ref.width}×${ref.height} 像素，由视觉辅助模型 ${model} 识别]\n${description.trim()}`;
}
/** The text block that replaces an image whose description failed. */
export function renderImageFailure(index, total, ref, reason) {
    return `[图片 ${index}/${total}，${ref.width}×${ref.height} 像素：视觉辅助模型调用失败（${joinErrorMessage(reason)}），这张图未能转成文字]`;
}
