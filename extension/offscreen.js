let videoRecorder = null;
let videoStream = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_VIDEO_CAPTURE') {
        startVideoCapture(msg.streamId, msg.sessionId, msg.collectorUrl)
            .then(() => sendResponse({ ok: true }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true; // async response
    }
    if (msg.type === 'STOP_VIDEO_CAPTURE') {
        stopVideoCapture();
        sendResponse({ ok: true });
    }
});

async function startVideoCapture(streamId, sessionId, collectorUrl) {
    if (videoRecorder) {
        stopVideoCapture();
    }

    try {
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId,
                    maxWidth: 1920,
                    maxHeight: 1080,
                    maxFrameRate: 15
                }
            },
            audio: false
        });

        // Listen for the user clicking the native "Stop sharing" button
        videoStream.getTracks()[0].onended = () => {
            console.log('[QA Recorder] Native stop sharing button clicked');
            chrome.runtime.sendMessage({ type: 'STOP_RECORDING_FROM_SYSTEM_BAR' }).catch(() => { });
        };

        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : 'video/webm';

        videoRecorder = new MediaRecorder(videoStream, {
            mimeType,
            videoBitsPerSecond: 1_500_000,
        });

        let chunkIndex = 0;

        videoRecorder.ondataavailable = async (e) => {
            if (!e.data || e.data.size === 0) return;
            try {
                const buffer = await e.data.arrayBuffer();
                await fetch(`${collectorUrl}/session/${sessionId}/video-chunk`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'x-chunk-index': String(chunkIndex++),
                    },
                    body: buffer,
                });
            } catch (err) {
                console.warn('[QA Recorder] Video chunk upload failed:', err.message);
            }
        };

        videoRecorder.start(5000);
        console.log('[QA Recorder] Offscreen video capture started');
    } catch (err) {
        console.warn('[QA Recorder] Offscreen video capture failed:', err.message);
        throw err;
    }
}

function stopVideoCapture() {
    if (videoRecorder && videoRecorder.state !== 'inactive') {
        videoRecorder.stop();
        videoRecorder = null;
    }
    if (videoStream) {
        videoStream.getTracks().forEach(t => t.stop());
        videoStream = null;
    }
}
